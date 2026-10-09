/* dashboard.js - all dashboard views:
 *   twin | forecast | whatif | planner | reports | alerts | model | admin
 * Data comes from the Flask JSON API (see app.py). No frameworks, no CDN.
 */
(function () {
  "use strict";
  var E = Util.esc, hh = Util.hh;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var CSRF = $('meta[name="csrf-token"]').content;
  var IS_ADMIN = document.body.dataset.role === "admin";
  var INK = "#0E2B36", Q1 = "#4FBFAA", Q3 = "#EE8340", GREY = "#8FA1A7";

  var S = { cfg: null, facs: {}, order: [], favs: {}, home: null, twin: null, live: {}, notes: [], map: null,
            hour: 12, playing: false, timer: null, selected: "library", loaded: {}, dirty: false, offset: 0,
            fc: { fac: "library", idx: 0, data: null }, wi: null, plan: [{ facility: "library", minutes: 120 }, { facility: "gym", minutes: 60 }, { facility: "mess", minutes: 45 }],
            rp: { fac: "mess", level: 3 }, ml: { fac: "library", data: null } };

  /* ------------------------------------------------------------------ helpers */
  function api(url, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", headers: { Accept: "application/json" } };
    if (opts.body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    if (init.method !== "GET") init.headers["X-CSRF-Token"] = CSRF;
    return fetch(url, init).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (r.status === 401) { location.href = "/login"; throw new Error("Please log in"); }
        if (!r.ok) throw new Error((data && data.error) || "Request failed (" + r.status + ")");
        return data;
      });
    });
  }
  var toastTimer;
  function toast(msg, bad) {
    var t = $("#toast"); t.textContent = msg; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3400);
  }
  function fail(e) { toast(e.message || "Something went wrong", true); }
  function serverNow() { return new Date(Date.now() + S.offset); }
  function nowHour() { return serverNow().getHours(); }
  function todayIso() { return S.home.date; }
  function facName(id) { return S.facs[id] ? S.facs[id].name : id; }
  function facShort(id) { return S.facs[id] ? S.facs[id].short : id; }
  function openText(f) { return f.open.map(function (w) { return hh(w[0]) + "\u2013" + hh(w[1]); }).join(", "); }
  function lvl(p, open) { return open === false ? '<span class="lvl lv0">Closed</span>' : '<span class="lvl lv' + Util.level(p) + '">' + Util.levelName(p) + "</span>"; }
  function facOptions(sel, selected, short) {
    sel.innerHTML = S.order.map(function (id) { return '<option value="' + id + '"' + (id === selected ? " selected" : "") + ">" + E(short ? facShort(id) : facName(id)) + "</option>"; }).join("");
  }
  function hourOptions(sel, from, to, selected) {
    var h = "", i; for (i = from; i <= to; i++) h += '<option value="' + i + '"' + (i === selected ? " selected" : "") + ">" + hh(i) + "</option>"; sel.innerHTML = h;
  }
  function dayOptions(sel, selected) {
    var h = "", i, iso; for (i = 0; i < 7; i++) { iso = Util.addDays(todayIso(), i); h += '<option value="' + iso + '"' + (iso === selected ? " selected" : "") + ">" + (i === 0 ? "Today \u00b7 " : "") + Util.dayLabel(iso) + "</option>"; }
    sel.innerHTML = h;
  }
  function seg(host, options, value, onChange) {
    host.innerHTML = options.map(function (o, i) { return '<button type="button" role="radio" aria-checked="' + (o.v === value) + '" data-i="' + i + '">' + E(o.t) + "</button>"; }).join("");
    host.onclick = function (e) {
      var b = e.target.closest("button"); if (!b) return;
      var o = options[+b.dataset.i]; $$("button", host).forEach(function (x) { x.setAttribute("aria-checked", x === b); }); onChange(o.v);
    };
  }
  function pills(host, ids, value, onPick, attr) {
    host.innerHTML = ids.map(function (id) { return '<button type="button" class="pill" role="' + (attr || "tab") + '" ' + (attr === "radio" ? "aria-checked" : "aria-selected") + '="' + (id === value) + '" data-id="' + id + '">' + E(facShort(id)) + "</button>"; }).join("");
    host.onclick = function (e) {
      var b = e.target.closest(".pill"); if (!b) return;
      $$(".pill", host).forEach(function (x) { x.setAttribute(attr === "radio" ? "aria-checked" : "aria-selected", x === b); }); onPick(b.dataset.id);
    };
  }
  function lineSeries(pct, open) { return pct.map(function (v, i) { return open[i] ? v : null; }); }

  /* ------------------------------------------------------------------ navigation */
  var TITLES = { twin: "Campus twin", forecast: "Forecast", whatif: "What-if simulator", planner: "Day planner", reports: "Crowd reports", alerts: "Smart alerts", model: "Model lab", admin: "Admin console" };
  var INIT = {}, REFRESH = {};
  function show(view) {
    if (!$("#view-" + view)) view = "twin";
    $$(".view").forEach(function (v) { v.hidden = v.dataset.view !== view; });
    $$(".nav-item").forEach(function (a) { a.classList.toggle("active", a.dataset.view === view); });
    $("#page-title").textContent = TITLES[view];
    document.title = TITLES[view] + " - Campus Twin";
    $("#rail").classList.remove("open"); $("#nav-toggle").setAttribute("aria-expanded", "false");
    window.scrollTo(0, 0);
    if (!S.loaded[view]) { S.loaded[view] = true; if (INIT[view]) INIT[view](); }
    else if (REFRESH[view]) REFRESH[view]();
  }
  window.addEventListener("hashchange", function () { show(location.hash.slice(1)); });
  function go(view) { if (location.hash.slice(1) === view) show(view); else location.hash = view; }

  /* ------------------------------------------------------------------ top bar + polling */
  function renderChips() {
    var t = S.home; if (!t) return;
    $("#chip-day").textContent = Util.dayLabel(t.date) + " \u00b7 " + t.context.label;
    var h = nowHour(), temp = t.temp[h], next = null, i;
    if (!t.rain[h]) for (i = h + 1; i < 24; i++) if (t.rain[i]) { next = i; break; }
    var wx = t.rain[h] ? "Raining" : next !== null ? "Rain from " + hh(next) : "Dry";
    var c = $("#chip-weather"); c.textContent = Math.round(temp) + "\u00b0C \u00b7 " + wx; c.title = "Simulated weather feed. Plug in a real weather API in app.py.";
  }
  function renderPulse(p) {
    var c = $("#chip-pulse"); if (!p) return;
    var lv = p.value < 35 ? 1 : p.value < 55 ? 2 : p.value < 75 ? 3 : 4;
    c.className = "chip chip-pulse lv" + lv; c.textContent = "Campus pulse " + Math.round(p.value) + " \u00b7 " + p.label;
  }
  function renderBell() {
    var n = S.notes.length, cnt = $("#bell-count"); cnt.hidden = !n; cnt.textContent = n;
    $("#bell-pop").innerHTML = "<h4>Your alerts</h4>" + (n ? "<ul>" + S.notes.map(function (x) { return "<li><b>" + E(facShort(x.facility)) + "</b>" + E(x.message) + "</li>"; }).join("") + "</ul>"
      : '<p class="none">Nothing to report. We will tell you when one of your alert rules is met.</p>');
  }
  function poll() {
    return api("/api/live").then(function (d) {
      S.live = d.live; S.notes = d.notifications; S.offset = new Date(d.now) - Date.now();
      renderPulse(d.pulse); renderBell(); renderChips();
      if (S.loaded.twin && !$("#view-twin").hidden && S.twin && S.twin.is_today && !S.playing) renderTwin();
    }).catch(function () { /* keep the last values */ });
  }
  $("#bell").addEventListener("click", function (e) { e.stopPropagation(); var p = $("#bell-pop"); p.hidden = !p.hidden; });
  document.addEventListener("click", function (e) { if (!e.target.closest(".bell-wrap")) $("#bell-pop").hidden = true; });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { $("#bell-pop").hidden = true; $("#rail").classList.remove("open"); } });
  $("#nav-toggle").addEventListener("click", function () { var r = $("#rail"); r.classList.toggle("open"); this.setAttribute("aria-expanded", r.classList.contains("open")); });

  /* ================================================================== TWIN */
  function loadTwin(iso) { return api("/api/twin" + (iso ? "?date=" + iso : "")).then(function (d) { S.twin = d; return d; }); }

  function valuesAt(h) {
    var out = {}, isNow = S.twin.is_today && h === nowHour();
    S.twin.facilities.forEach(function (f) {
      var pct = f.pct[h], open = f.open[h], lv = isNow ? (S.live[f.id] || f.live) : null;
      if (lv) { pct = lv.pct; open = lv.open; }
      out[f.id] = { pct: pct, open: open, hc: Math.round(pct / 100 * f.capacity) };
    });
    return out;
  }

  function renderTwin() {
    var t = S.twin, h = S.hour, isNow = t.is_today && h === nowHour();
    S.map.update(valuesAt(h));
    $("#tw-hour").value = h; $("#tw-clock").textContent = hh(h);
    $("#twin-title").textContent = isNow ? "Campus right now" : (t.is_today ? "Today at " : Util.dayLabel(t.date) + " at ") + hh(h);
    $("#twin-sub").textContent = (isNow ? "Live estimate: the model blended with recent student reports. " : "Model forecast. ") + t.context.label + ".";
    renderList(); renderBoard(); renderPulseChart(); renderDetail();
  }

  function renderList() {
    var t = S.twin, h = S.hour, vals = valuesAt(h);
    var rows = t.facilities.map(function (f) { return { f: f, v: vals[f.id], prev: f.open[h - 1] && h > 0 ? f.pct[h - 1] : null }; });
    rows.sort(function (a, b) {
      var pa = S.favs[a.f.id] ? 1 : 0, pb = S.favs[b.f.id] ? 1 : 0;
      return pb - pa || (b.v.open - a.v.open) || b.v.pct - a.v.pct;
    });
    $("#side-title").textContent = t.is_today && h === nowHour() ? "Right now" : "At " + hh(h);
    $("#fac-list").innerHTML = rows.map(function (r) {
      var f = r.f, v = r.v, lv = v.open ? Util.level(v.pct) : 0, tr = "";
      if (v.open && r.prev !== null) { var d = Math.round(v.pct - r.prev); tr = d > 2 ? ' <span class="tr up">\u25B2 ' + d + "</span>" : d < -2 ? ' <span class="tr down">\u25BC ' + Math.abs(d) + "</span>" : ""; }
      var meta = v.open ? v.hc.toLocaleString() + " of " + f.capacity.toLocaleString() + " \u00b7 " + Util.levelName(v.pct) + tr : "Closed at this hour";
      return '<li class="lv' + lv + (S.selected === f.id ? " selected" : "") + '" data-id="' + f.id + '">' +
        '<button class="star" data-star="' + f.id + '" aria-pressed="' + !!S.favs[f.id] + '" aria-label="Pin ' + E(f.name) + '">\u2605</button>' +
        '<button class="fac-main" data-pick="' + f.id + '"><span class="fac-name">' + E(f.name) + '</span><span class="fac-meta">' + meta + "</span></button>" +
        '<span class="fac-pct">' + (v.open ? Math.round(v.pct) + "%" : "\u2013") + '</span><span class="fac-bar"><i style="width:' + (v.open ? Math.min(100, v.pct) : 0) + '%"></i></span></li>';
    }).join("");
  }

  function renderBoard() {
    var t = S.twin;
    $("#board-sub").textContent = t.is_today ? "Quietest hour today, and the next calm slot from now." : "Quietest hour on " + Util.dayLabel(t.date) + ", and when it peaks.";
    $("#go-board").innerHTML = t.facilities.map(function (f) {
      if (!f.best) return "";
      var note = t.is_today && f.next_good ? "Next calm slot: " + hh(f.next_good.hour) + " (" + Math.round(f.next_good.pct) + "%). Peak at " + hh(f.peak.hour) + "."
        : "Peaks at " + hh(f.peak.hour) + " (" + Math.round(f.peak.pct) + "%).";
      return '<div class="go-row"><span class="go-name">' + E(f.short) + '</span><span class="go-time">' + hh(f.best.start) + "\u2013" + hh(f.best.end) + "</span>" +
        lvl(f.best.pct) + '<span class="go-note">' + note + "</span></div>";
    }).join("");
  }

  function renderPulseChart() {
    var t = S.twin;
    Charts.line($("#pulse-chart"), { height: 170, label: "Campus pulse across the day", series: [{ name: "Campus pulse", data: t.pulse.map(function (v, i) { return v || (i > 5 && i < 24 ? v : null); }), color: INK, area: true, width: 2.4 }],
      now: t.is_today ? nowHour() + serverNow().getMinutes() / 60 : null, cursor: S.hour, onPick: function (i) { S.hour = i; stopPlay(); renderTwin(); } });
  }

  function selectFac(id) { S.selected = id; if (S.map) S.map.select(id); renderList(); renderDetail(); }

  function renderDetail() {
    var f = S.twin.facilities.filter(function (x) { return x.id === S.selected; })[0], p = $("#detail-panel");
    if (!f) { p.hidden = true; return; }
    var cfg = S.facs[f.id], h = S.hour, v = valuesAt(h)[f.id];
    p.hidden = false;
    p.innerHTML = '<div class="panel-head"><div><h3>' + E(f.name) + '</h3><p class="sub">Capacity ' + f.capacity.toLocaleString() + " \u00b7 open " + E(openText(cfg)) + "</p></div>" + lvl(v.pct, v.open) + "</div>" +
      '<div class="stats"><div><b>' + (v.open ? Math.round(v.pct) + "%" : "\u2013") + "</b><span>at " + hh(h) + "</span></div>" +
      "<div><b>" + (f.best ? hh(f.best.start) : "\u2013") + "</b><span>quietest hour</span></div><div><b>" + (f.peak ? hh(f.peak.hour) : "\u2013") + "</b><span>peak" + (f.peak ? " (" + Math.round(f.peak.pct) + "%)" : "") + "</span></div></div>" +
      '<div id="detail-chart" class="chart"></div>' +
      '<div class="detail-actions"><button class="btn btn-ghost btn-sm" data-go="forecast">Full forecast</button><button class="btn btn-ghost btn-sm" data-go="reports">Report how it feels</button></div>';
    var marks = f.peak ? [{ x: f.peak.hour, y: f.peak.pct, label: "Peak", color: "#C0274F" }] : [];
    Charts.line($("#detail-chart"), { height: 170, label: f.name + " forecast", series: [{ name: "Forecast", data: lineSeries(f.pct, f.open), color: INK, band: { lo: f.lo, hi: f.hi } }],
      shade: f.best ? [{ from: f.best.start, to: f.best.end, label: "Best" }] : [], marks: marks, cursor: S.hour, now: S.twin.is_today ? nowHour() : null });
    $$("[data-go]", p).forEach(function (b) { b.addEventListener("click", function () { if (b.dataset.go === "forecast") S.fc.fac = f.id; if (b.dataset.go === "reports") S.rp.fac = f.id; go(b.dataset.go); }); });
  }

  function setDay(iso) {
    return loadTwin(iso).then(function () { S.hour = S.twin.is_today ? nowHour() : Math.min(23, Math.max(0, S.hour)); renderTwin(); }).catch(fail);
  }

  function stopPlay() { S.playing = false; clearInterval(S.timer); $("#tw-play").innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>'; $("#tw-play").setAttribute("aria-label", "Play the day"); }
  function startPlay() {
    S.playing = true; $("#tw-play").setAttribute("aria-label", "Pause");
    $("#tw-play").innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    S.timer = setInterval(function () { S.hour = (S.hour + 1) % 24; renderTwin(); }, 700);
  }

  INIT.twin = function () {
    S.map = CampusTwin.create($("#twin-map"), { facilities: S.cfg.facilities, onSelect: selectFac });
    CampusTwin.legend($("#twin-legend"));
    S.map.setPinned(Object.keys(S.favs));
    var ticks = "", h; for (h = 0; h < 24; h += 3) ticks += '<span style="left:calc(11px + (100% - 22px) * ' + h + " / 23)\">" + (h < 10 ? "0" : "") + h + "</span>";
    $("#tw-ticks").innerHTML = ticks;
    dayOptions($("#tw-day"), S.twin.date);
    $("#tw-hour").addEventListener("input", function () { S.hour = +this.value; stopPlay(); renderTwin(); });
    $("#tw-play").addEventListener("click", function () { S.playing ? stopPlay() : startPlay(); });
    $("#tw-now").addEventListener("click", function () { stopPlay(); $("#tw-day").value = todayIso(); if (!S.twin.is_today) setDay(todayIso()); else { S.hour = nowHour(); renderTwin(); } });
    $("#tw-day").addEventListener("change", function () { stopPlay(); setDay(this.value); });
    $("#fac-list").addEventListener("click", function (e) {
      var st = e.target.closest("[data-star]"), pk = e.target.closest("[data-pick]");
      if (st) api("/api/favorites", { method: "POST", body: { facility: st.dataset.star } }).then(function (r) {
        S.favs = {}; r.favorites.forEach(function (x) { S.favs[x] = true; }); S.map.setPinned(r.favorites); renderList(); toast(r.pinned ? "Pinned " + facName(st.dataset.star) : "Unpinned " + facName(st.dataset.star));
      }).catch(fail);
      else if (pk) selectFac(pk.dataset.pick);
    });
    var pinned = Object.keys(S.favs); S.selected = pinned.length ? pinned[0] : "library";
    S.hour = nowHour(); S.map.select(S.selected); renderTwin();
  };
  REFRESH.twin = function () {
    if (S.dirty) { S.dirty = false; setDay(S.twin.date); } else { S.playing || renderTwin(); }
    if (S.map) S.map.select(S.selected);
  };

  /* ================================================================== FORECAST */
  function loadForecast() {
    return api("/api/forecast?facility=" + S.fc.fac + "&date=" + todayIso()).then(function (d) { S.fc.data = d; renderForecast(); }).catch(fail);
  }
  function renderForecast() {
    var d = S.fc.data, day = d.days[S.fc.idx], cfg = S.facs[d.facility];
    pills($("#fc-facs"), S.order, S.fc.fac, function (id) { S.fc.fac = id; S.fc.idx = Math.min(S.fc.idx, 6); loadForecast(); });
    $("#fc-days").innerHTML = d.days.map(function (x, i) {
      var tag = x.context.holiday || x.context.vacation || x.context.exam ? x.context.label : x.has_event ? "Event" : x.context.weekend ? "Weekend" : "";
      return '<button type="button" class="day" role="tab" aria-selected="' + (i === S.fc.idx) + '" data-i="' + i + '"><b>' + x.short + " " + Util.parse(x.date).getDate() + "</b><span>" + (i === 0 ? "Today" : Util.MONTHS[Util.parse(x.date).getMonth()]) + "</span><em>" + E(tag) + "</em></button>";
    }).join("");
    $$("#fc-days .day").forEach(function (b) { b.addEventListener("click", function () { S.fc.idx = +b.dataset.i; renderForecast(); }); });
    $("#fc-title").textContent = d.name + " \u00b7 " + day.label;
    $("#fc-sub").textContent = day.context.label + (day.has_event ? " with a scheduled event" : "") + ". Open " + openText(cfg) + ".";
    var marks = day.peak ? [{ x: day.peak.hour, y: day.peak.pct, label: "Peak " + Math.round(day.peak.pct) + "%", color: "#C0274F" }] : [];
    Charts.line($("#fc-chart"), { height: 300, label: d.name + " forecast for " + day.label, series: [{ name: "Predicted", data: lineSeries(day.pct, day.open), color: INK, band: { lo: day.lo, hi: day.hi }, dots: true }],
      shade: day.best ? [{ from: day.best.start, to: day.best.end, label: "Best hour" }] : [], marks: marks, now: S.fc.idx === 0 ? nowHour() + serverNow().getMinutes() / 60 : null,
      tip: function (i) { return "<strong>" + hh(i) + "</strong>" + (day.open[i] ? "<br>" + Math.round(day.pct[i]) + "% \u00b7 " + Util.levelName(day.pct[i]) + "<br>Likely range " + Math.round(day.lo[i]) + "\u2013" + Math.round(day.hi[i]) + "%<br>About " + day.hc[i].toLocaleString() + " people" : "<br>Closed"); } });
    var openVals = day.pct.filter(function (v, i) { return day.open[i]; }), avg = openVals.length ? openVals.reduce(function (a, b) { return a + b; }, 0) / openVals.length : 0;
    $("#fc-stats").innerHTML = [
      ["Quietest hour", day.best ? hh(day.best.start) + "\u2013" + hh(day.best.end) : "\u2013", day.best ? Math.round(day.best.pct) + "% full" : ""],
      ["Quietest 2 hours", day.best2 ? hh(day.best2.start) + "\u2013" + hh(day.best2.end) : "\u2013", day.best2 ? Math.round(day.best2.pct) + "% average" : ""],
      ["Busiest hour", day.peak ? hh(day.peak.hour) : "\u2013", day.peak ? Math.round(day.peak.pct) + "% \u00b7 " + Util.levelName(day.peak.pct) : ""],
      ["Average while open", Math.round(avg) + "%", Util.levelName(avg)],
      ["People at the peak", day.peak ? day.hc[day.peak.hour].toLocaleString() : "\u2013", "of " + d.capacity.toLocaleString()],
      ["Type of day", day.context.label, day.has_event ? "Event scheduled" : ""]
    ].map(function (r) { return "<div><dt>" + r[0] + "</dt><dd>" + E(r[1]) + (r[2] ? "<small>" + E(r[2]) + "</small>" : "") + "</dd></div>"; }).join("");
    // heat-map for the 7 days
    var best = null;
    d.days.forEach(function (x, r) { x.pct.forEach(function (v, h) { if (x.open[h] && h >= 7 && h < 22 && (!best || v < best.v)) best = { row: r, col: h, v: v }; }); });
    Charts.heat($("#fc-heat"), { label: d.name + " next seven days", cellH: 38, best: best,
      rows: d.days.map(function (x) { return { label: x.short + " " + Util.parse(x.date).getDate(), sub: x.context.exam && !x.context.holiday ? "Exam week" : x.context.holiday ? "Holiday" : x.context.vacation ? "Vacation" : x.context.weekend ? "Weekend" : "", vals: x.pct, open: x.open }; }),
      onCell: function (r) { S.fc.idx = r; renderForecast(); } });
    $("#fc-heat-sub").textContent = d.quietest ? "Quietest slot of the week: " + d.quietest.day + " at " + hh(d.quietest.start) + " (" + Math.round(d.quietest.pct) + "% full). Click a row to open that day." : "";
    $("#heat-legend").innerHTML = '<span>Quiet</span><span class="ramp"></span><span>Packed</span><span class="hatch"></span><span>Closed</span>';
  }
  INIT.forecast = function () { loadForecast(); };
  REFRESH.forecast = function () { if (S.fc.data && S.fc.data.facility !== S.fc.fac) loadForecast(); else if (S.fc.data) renderForecast(); };

  /* The remaining views (what-if, planner, reports, alerts, model lab, admin) and start-up live in views.js */
  window.CT = { S: S, INIT: INIT, REFRESH: REFRESH, api: api, toast: toast, fail: fail, show: show, go: go, poll: poll, renderChips: renderChips, loadTwin: loadTwin,
                  helpers: { facOptions: facOptions, hourOptions: hourOptions, dayOptions: dayOptions, seg: seg, pills: pills, lineSeries: lineSeries, lvl: lvl, facName: facName, facShort: facShort,
                             todayIso: todayIso, nowHour: nowHour, serverNow: serverNow, openText: openText, TITLES: TITLES, colors: { INK: INK, Q1: Q1, Q3: Q3, GREY: GREY }, IS_ADMIN: IS_ADMIN } };
})();

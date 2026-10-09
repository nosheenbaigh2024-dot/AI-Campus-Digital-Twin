/* views.js - What-if, Planner, Crowd reports, Alerts, Model lab, Admin + app start-up.
 * Uses the shared state/helpers exposed by dashboard.js as window.CT.
 */
(function () {
  "use strict";
  var CT = window.CT, S = CT.S, api = CT.api, toast = CT.toast, fail = CT.fail, H = CT.helpers, INIT = CT.INIT, REFRESH = CT.REFRESH;
  var E = Util.esc, hh = Util.hh;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var C = H.colors;
  function fullDate(iso) { var d = Util.parse(iso); return d.getDate() + " " + Util.MONTHS[d.getMonth()] + " " + d.getFullYear(); }
  function stamp(iso) { var d = new Date(iso); return d.getDate() + " " + Util.MONTHS[d.getMonth()] + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
  function msg(sel, text, kind) { var m = $(sel); m.textContent = text || ""; m.className = "form-msg" + (kind ? " " + kind : ""); }
  function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }

  /* ================================================================== WHAT-IF */
  var WI_DEFAULT = { daytype: null, exam: null, rain: null, tempOn: false, temp: 32, evOn: false, evFac: "ground", evStart: 15, evEnd: 20, hour: 18 };
  var PRESETS = [
    { t: "Rainy exam evening", d: "Exam week and rain, looking at 20:00", set: { exam: true, rain: true, hour: 20 } },
    { t: "Fest day at the ground", d: "Weekday event from 15:00 to 20:00", set: { daytype: "weekday", evOn: true, evFac: "ground", evStart: 15, evEnd: 20, hour: 17 } },
    { t: "Heatwave weekend", d: "42\u00b0C on a Saturday, looking at 17:00", set: { daytype: "weekend", tempOn: true, temp: 42, hour: 17 } }
  ];
  var wiTimer;

  function wiBody() {
    var w = S.wi, b = { date: w.date };
    if (w.daytype) b.daytype = w.daytype;
    if (w.exam !== null) b.exam = w.exam;
    if (w.rain !== null) b.rain = w.rain;
    if (w.tempOn) b.temp = w.temp;
    if (w.evOn && w.evEnd > w.evStart) b.events = [{ facility: w.evFac, start: w.evStart, end: w.evEnd }];
    return b;
  }
  function wiRun() { clearTimeout(wiTimer); wiTimer = setTimeout(function () { api("/api/whatif", { method: "POST", body: wiBody() }).then(function (d) { S.wi.data = d; wiRender(); }).catch(fail); }, 160); }

  function wiSync() {
    var w = S.wi;
    H.dayOptions($("#wi-date"), w.date);
    H.seg($("#seg-daytype"), [{ t: "Automatic", v: null }, { t: "Weekday", v: "weekday" }, { t: "Weekend", v: "weekend" }], w.daytype, function (v) { w.daytype = v; wiRun(); });
    H.seg($("#seg-exam"), [{ t: "Calendar", v: null }, { t: "Exam week", v: true }, { t: "No exams", v: false }], w.exam, function (v) { w.exam = v; wiRun(); });
    H.seg($("#seg-rain"), [{ t: "Forecast", v: null }, { t: "Dry", v: false }, { t: "Rain all day", v: true }], w.rain, function (v) { w.rain = v; wiRun(); });
    $("#wi-temp-on").checked = w.tempOn; $("#wi-temp").value = w.temp; $("#wi-temp").disabled = !w.tempOn;
    $("#wi-temp-out").textContent = w.tempOn ? w.temp + "\u00b0C" : "forecast";
    $("#wi-ev-on").checked = w.evOn;
    H.facOptions($("#wi-ev-fac"), w.evFac, true); H.hourOptions($("#wi-ev-start"), 0, 23, w.evStart); H.hourOptions($("#wi-ev-end"), 1, 24, w.evEnd);
    $("#wi-hour").value = w.hour; $("#wi-hour-out").textContent = hh(w.hour);
  }

  function wiRender() {
    var w = S.wi, d = w.data, h = w.hour; if (!d) return;
    var rows = d.facilities.map(function (f) { var open = f.open[h]; return { f: f, open: open, b: f.base[h], s: f.scenario[h], d: f.scenario[h] - f.base[h] }; });
    var live = rows.filter(function (r) { return r.open; });
    var top = live.slice().sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d); })[0];
    $("#wi-headline").textContent = top && Math.abs(top.d) >= 1 ? top.f.short + " at " + hh(h) + ": " + Math.round(top.b) + "% becomes " + Math.round(top.s) + "% (" + (top.d > 0 ? "+" : "") + Math.round(top.d) + ")" : "This scenario changes nothing at " + hh(h);
    var over = live.filter(function (r) { return r.s >= 80 && r.b < 80; }).map(function (r) { return r.f.short; });
    var relief = live.filter(function (r) { return r.b >= 80 && r.s < 80; }).map(function (r) { return r.f.short; });
    $("#wi-sub").textContent = "Campus pulse " + Math.round(avg(live.map(function (r) { return r.b; }))) + " \u2192 " + Math.round(avg(live.map(function (r) { return r.s; }))) + "." +
      (over.length ? " Would overflow: " + over.join(", ") + "." : "") + (relief.length ? " No longer packed: " + relief.join(", ") + "." : "");
    $("#wi-bars").innerHTML = rows.map(function (r) {
      if (!r.open) return '<div class="pair-row lv0"><span class="nm">' + E(r.f.short) + '</span><div class="pair-bars"><div class="bar" style="width:0"></div></div><div class="pair-val"><span class="lvl lv0">Closed</span></div></div>';
      var dl = Math.round(r.d), cls = dl > 1 ? "up" : dl < -1 ? "down" : "flat";
      return '<div class="pair-row lv' + Util.level(r.s) + '"><span class="nm">' + E(r.f.short) + '</span><div class="pair-bars"><div class="bar" style="width:' + Math.min(100, r.b) + '%"></div><div class="bar scn" style="width:' + Math.min(100, r.s) + '%"></div></div>' +
        '<div class="pair-val"><span>' + Math.round(r.s) + '%</span><span class="delta ' + cls + '">' + (dl > 0 ? "+" : dl < 0 ? "\u2212" : "") + Math.abs(dl) + "</span></div></div>";
    }).join("");
    var f = d.facilities.filter(function (x) { return x.id === w.fac; })[0];
    H.pills($("#wi-facs"), S.order, w.fac, function (id) { w.fac = id; wiRender(); });
    Charts.line($("#wi-chart"), { height: 260, label: "Baseline versus scenario", cursor: h,
      series: [{ name: "Normal day", data: H.lineSeries(f.base, f.open), color: C.GREY, dash: true, width: 2.2 }, { name: "Scenario", data: H.lineSeries(f.scenario, f.open), color: C.INK, width: 3 }] });
  }

  INIT.whatif = function () {
    S.wi = Object.assign({ date: H.todayIso(), fac: "ground", data: null }, WI_DEFAULT, PRESETS[1].set);   // open with a meaningful scenario
    $("#wi-presets").innerHTML = PRESETS.map(function (p, i) { return '<button type="button" class="preset" data-i="' + i + '"><b>' + E(p.t) + "</b><span>" + E(p.d) + "</span></button>"; }).join("");
    $("#wi-presets").addEventListener("click", function (e) {
      var b = e.target.closest(".preset"); if (!b) return;
      S.wi = Object.assign({}, S.wi, WI_DEFAULT, PRESETS[+b.dataset.i].set); wiSync(); wiRun(); toast("Scenario loaded: " + PRESETS[+b.dataset.i].t);
    });
    $("#wi-reset").addEventListener("click", function () { S.wi = Object.assign({}, S.wi, WI_DEFAULT); wiSync(); wiRun(); });
    $("#wi-date").addEventListener("change", function () { S.wi.date = this.value; wiRun(); });
    $("#wi-temp-on").addEventListener("change", function () { S.wi.tempOn = this.checked; $("#wi-temp").disabled = !this.checked; $("#wi-temp-out").textContent = this.checked ? S.wi.temp + "\u00b0C" : "forecast"; wiRun(); });
    $("#wi-temp").addEventListener("input", function () { S.wi.temp = +this.value; $("#wi-temp-out").textContent = this.value + "\u00b0C"; wiRun(); });
    $("#wi-ev-on").addEventListener("change", function () { S.wi.evOn = this.checked; wiRun(); });
    $("#wi-ev-fac").addEventListener("change", function () { S.wi.evFac = this.value; if (S.wi.evOn) wiRun(); });
    $("#wi-ev-start").addEventListener("change", function () { S.wi.evStart = +this.value; if (S.wi.evOn) wiRun(); });
    $("#wi-ev-end").addEventListener("change", function () { S.wi.evEnd = +this.value; if (S.wi.evOn) wiRun(); });
    $("#wi-hour").addEventListener("input", function () { S.wi.hour = +this.value; $("#wi-hour-out").textContent = hh(S.wi.hour); wiRender(); });
    wiSync(); wiRun();
  };
  REFRESH.whatif = function () { wiRun(); };

  /* ================================================================== PLANNER */
  var DURATIONS = [15, 30, 45, 60, 90, 120, 150, 180, 240];
  function toMin(t) { var p = t.split(":"); return +p[0] * 60 + +p[1]; }
  function renderActs() {
    $("#pl-acts").innerHTML = S.plan.map(function (a, i) {
      var fo = S.order.map(function (id) { return '<option value="' + id + '"' + (id === a.facility ? " selected" : "") + ">" + E(H.facName(id)) + "</option>"; }).join("");
      var dO = DURATIONS.map(function (m) { return '<option value="' + m + '"' + (m === a.minutes ? " selected" : "") + ">" + (m >= 60 ? (m / 60) + (m === 60 ? " hour" : m % 60 ? " h" : " hours") : m + " min").replace(".5 h", "\u00bd h") + "</option>"; }).join("");
      return '<div class="act-row"><span class="n">' + (i + 1) + '</span><select data-k="facility" data-i="' + i + '" aria-label="Place ' + (i + 1) + '">' + fo + '</select><select data-k="minutes" data-i="' + i + '" aria-label="Duration ' + (i + 1) + '">' + dO + '</select><button type="button" class="x" data-rm="' + i + '" aria-label="Remove activity ' + (i + 1) + '">\u00d7</button></div>';
    }).join("");
    $("#pl-add").disabled = S.plan.length >= 5;
  }
  function timeline(plan, s, e, cls) {
    var span = e - s, axis = "", lines = "", t;
    for (t = Math.ceil(s / 60) * 60; t <= e; t += 60) { var left = (t - s) / span * 100; axis += '<span style="left:' + left + '%">' + String(t / 60).padStart(2, "0") + "</span>"; lines += '<i class="tl-hline" style="left:' + left + '%"></i>'; }
    var blocks = plan.items.map(function (it) {
      var a = toMin(it.start), b = toMin(it.end);
      return '<div class="tl-block lv' + it.level + '" style="left:' + ((a - s) / span * 100) + "%;width:" + ((b - a) / span * 100) + '%" title="' + E(it.name) + " " + it.start + "\u2013" + it.end + " (" + Math.round(it.avg_pct) + '%)">' + E(it.name) + "<small>" + it.start + " \u00b7 " + Math.round(it.avg_pct) + "%</small></div>";
    }).join("");
    return '<div class="tl ' + (cls || "") + '"><div class="tl-axis">' + axis + '</div><div class="tl-track">' + lines + blocks + "</div></div>";
  }
  function renderPlan(r, s, e) {
    var host = $("#pl-result");
    if (!r.ok) { host.innerHTML = '<div class="empty"><h3>No plan fits</h3><p>' + E(r.message) + "</p></div>"; return; }
    var b = r.best, g = r.improvement_pct;
    var head = g && g > 0.5 ? '<div class="gain"><b>' + Math.round(g) + "%</b><span>less crowding than doing the same things in your listed order, as early as possible.</span></div>"
      : '<div class="gain"><b>' + Math.round(b.avg_pct) + "%</b><span>average crowd level. Your listed order was already close to the best available.</span></div>";
    host.innerHTML = '<div class="panel-head"><div><h2>Your least-crowded day</h2><p class="sub">Average crowd level across your activities: ' + Math.round(b.avg_pct) + "%" + (r.naive ? " versus " + Math.round(r.naive.avg_pct) + "% for the naive plan." : ".") + "</p></div></div>" + head +
      '<div class="tl-label"><span>Recommended</span><span>' + Util.dayLabel(r.date) + "</span></div>" + timeline(b, s, e) +
      '<ul class="plan-list">' + b.items.map(function (it) { return '<li><span class="t">' + it.start + "\u2013" + it.end + "</span><span><b>" + E(it.name) + "</b> \u00b7 " + it.minutes + ' min</span><span class="lvl lv' + it.level + '">' + Math.round(it.avg_pct) + "% \u00b7 " + Util.levelName(it.avg_pct) + "</span></li>"; }).join("") + "</ul>" +
      (r.naive ? '<div class="tl-label"><span>For comparison: listed order, as early as possible</span><span>' + Math.round(r.naive.avg_pct) + "% average</span></div>" + timeline(r.naive, s, e, "naive") : "") +
      (r.alternatives.length ? '<details class="alt-plans"><summary>Other good plans</summary><ol>' + r.alternatives.map(function (p) { return "<li>" + p.items.map(function (it) { return E(it.name) + " " + it.start; }).join(" \u2192 ") + " \u00b7 average " + Math.round(p.avg_pct) + "%</li>"; }).join("") + "</ol></details>" : "");
  }
  INIT.planner = function () {
    H.dayOptions($("#pl-date"), H.todayIso()); renderActs();
    $("#pl-acts").addEventListener("change", function (e) { var k = e.target.dataset.k, i = e.target.dataset.i; if (k) S.plan[i][k] = k === "minutes" ? +e.target.value : e.target.value; });
    $("#pl-acts").addEventListener("click", function (e) { var b = e.target.closest("[data-rm]"); if (b && S.plan.length > 1) { S.plan.splice(+b.dataset.rm, 1); renderActs(); } });
    $("#pl-add").addEventListener("click", function () { if (S.plan.length < 5) { S.plan.push({ facility: "cafe", minutes: 30 }); renderActs(); } });
    $("#pl-run").addEventListener("click", function () {
      var s = toMin($("#pl-start").value || "08:00"), e = toMin($("#pl-end").value || "21:00");
      if (e - s < 30) { msg("#pl-msg", "Your free window must be at least 30 minutes.", "bad"); return; }
      msg("#pl-msg", "Comparing every order and start time...");
      api("/api/plan", { method: "POST", body: { date: $("#pl-date").value, start: $("#pl-start").value, end: $("#pl-end").value, buffer: +$("#pl-buffer").value, activities: S.plan } })
        .then(function (r) { msg("#pl-msg", ""); renderPlan(r, s, e); }).catch(function (err) { msg("#pl-msg", err.message, "bad"); });
    });
  };

  /* ================================================================== REPORTS */
  var LEVEL_HINTS = [{ v: 1, t: "Quiet", h: "Plenty of room" }, { v: 2, t: "Moderate", h: "Getting full" }, { v: 3, t: "Busy", h: "Crowded" }, { v: 4, t: "Packed", h: "No space" }];
  function loadReports() {
    return api("/api/reports").then(function (d) {
      $("#rp-table").innerHTML = "<thead><tr><th>Place</th><th class=\"num\">Model</th><th class=\"num\">Students</th><th class=\"num\">Live estimate</th></tr></thead><tbody>" + d.summary.map(function (r) {
        return "<tr><td><b>" + E(r.name) + '</b></td><td class="num">' + (r.open ? Math.round(r.model) + "%" : "\u2013") + '</td><td class="num">' + (r.students !== null ? Math.round(r.students) + "% <small class=\"muted\">(" + r.n + ")</small>" : '<span class="muted">no reports</span>') +
          '</td><td class="num">' + (r.open ? "<b>" + Math.round(r.blended) + "%</b> " + H.lvl(r.blended) : H.lvl(0, false)) + "</td></tr>";
      }).join("") + "</tbody>";
      $("#rp-feed").innerHTML = d.feed.length ? d.feed.map(function (r) {
        return '<li><span class="fn">' + E(H.facShort(r.facility)) + '</span><div><div class="nt">' + (r.note ? E(r.note) : '<span class="muted">No note</span>') + '</div><div class="who2">' + E(r.who) + " \u00b7 " + Util.relTime(r.age_min) + "</div></div>" + H.lvl([15, 42, 68, 92][r.level - 1]) + "</li>";
      }).join("") : '<li class="muted">No reports yet. Be the first to tell campus how it feels.</li>';
    }).catch(fail);
  }
  function renderReportForm() {
    H.pills($("#rp-facs"), S.order, S.rp.fac, function (id) { S.rp.fac = id; }, "radio");
    $("#rp-levels").innerHTML = LEVEL_HINTS.map(function (l) { return '<button type="button" class="level-btn lv' + l.v + '" role="radio" aria-checked="' + (l.v === S.rp.level) + '" data-v="' + l.v + '"><i></i>' + l.t + "<small>" + l.h + "</small></button>"; }).join("");
  }
  INIT.reports = function () {
    renderReportForm(); loadReports();
    $("#rp-levels").addEventListener("click", function (e) { var b = e.target.closest(".level-btn"); if (!b) return; S.rp.level = +b.dataset.v; $$(".level-btn").forEach(function (x) { x.setAttribute("aria-checked", x === b); }); });
    $("#rp-send").addEventListener("click", function () {
      api("/api/reports", { method: "POST", body: { facility: S.rp.fac, level: S.rp.level, note: $("#rp-note").value } })
        .then(function () { msg("#rp-msg", "Thanks! Your report was added.", "good"); toast("Report added for " + H.facName(S.rp.fac)); $("#rp-note").value = ""; loadReports(); CT.poll(); S.dirty = true; })
        .catch(function (err) { msg("#rp-msg", err.message, "bad"); });
    });
  };
  REFRESH.reports = function () { renderReportForm(); loadReports(); };

  /* ================================================================== ALERTS */
  function loadAlerts() {
    return api("/api/alerts").then(function (d) {
      var active = d.alerts.filter(function (a) { return a.active; }).length;
      $("#al-sub").textContent = d.alerts.length ? active + " of " + d.alerts.length + " active. The bell in the top bar lights up when a rule is met." : "You have no alerts yet.";
      $("#al-list").innerHTML = d.alerts.length ? d.alerts.map(function (a) {
        var hit = S.notes.filter(function (n) { return n.id === a.id; })[0];
        return "<li><div><div class=\"rn\">" + E(H.facName(a.facility)) + " " + (a.condition === "below" ? "drops below " : "rises above ") + a.threshold + "%</div><div class=\"rs\">" +
          (a.lookahead ? "Looks ahead " + a.lookahead + " h" : "Live estimate only") + " \u00b7 " + (a.last_triggered ? "last triggered " + stamp(a.last_triggered) : "not triggered yet") + "</div>" +
          (hit && a.active ? '<div class="rs on-now">Active: ' + E(hit.message) + "</div>" : "") + '</div><label class="switch" title="Turn on or off"><input type="checkbox" data-toggle="' + a.id + '" ' + (a.active ? "checked" : "") + ' aria-label="Alert active"><span></span></label>' +
          '<button class="icon-btn" data-del="' + a.id + '" aria-label="Delete alert">\u00d7</button></li>';
      }).join("") : '<li class="muted">Create an alert to hear about quiet spells before they start.</li>';
    }).catch(fail);
  }
  INIT.alerts = function () {
    H.facOptions($("#al-fac"), "gym");
    var cond = "below";
    H.seg($("#al-cond"), [{ t: "Drops below", v: "below" }, { t: "Rises above", v: "above" }], cond, function (v) { cond = v; });
    $("#al-thr").addEventListener("input", function () { $("#al-thr-out").textContent = this.value + "%"; });
    $("#al-add").addEventListener("click", function () {
      api("/api/alerts", { method: "POST", body: { facility: $("#al-fac").value, condition: cond, threshold: +$("#al-thr").value, lookahead: +$("#al-look").value } })
        .then(function () { msg("#al-msg", "Alert created.", "good"); loadAlerts(); CT.poll().then(loadAlerts); }).catch(function (e) { msg("#al-msg", e.message, "bad"); });
    });
    $("#al-list").addEventListener("change", function (e) { var t = e.target.dataset.toggle; if (t) api("/api/alerts/" + t, { method: "PATCH", body: { active: e.target.checked } }).then(function () { CT.poll().then(loadAlerts); }).catch(fail); });
    $("#al-list").addEventListener("click", function (e) { var d = e.target.closest("[data-del]"); if (d) api("/api/alerts/" + d.dataset.del, { method: "DELETE" }).then(function () { toast("Alert deleted"); CT.poll().then(loadAlerts); }).catch(fail); });
    loadAlerts();
  };
  REFRESH.alerts = function () { loadAlerts(); };

  /* ================================================================== MODEL LAB */
  var MODEL_SHORT = { linear: "Ridge", random_forest: "Forest", gradient_boosting: "Boosting" };
  function renderModel() {
    var d = S.ml.data, ids = S.order, maes = ids.map(function (id) { return d.facilities[id].metrics[d.facilities[id].best].mae; });
    $("#ml-facts").innerHTML = [[d.rows.toLocaleString(), "hourly records"], [fullDate(d.date_from) + " to " + fullDate(d.date_to), "training period"], [d.features.length, "input features"], [avg(maes).toFixed(1) + " pts", "average error (MAE)"], [stamp(d.trained_at), "last trained"]]
      .map(function (f, i) { return '<div class="fact"><b' + (i === 1 ? ' style="font-size:17px;letter-spacing:-0.02em;line-height:1.35"' : "") + ">" + E(f[0]) + "</b><span>" + f[1] + "</span></div>"; }).join("");
    $("#ml-table").innerHTML = '<thead><tr><th>Place</th><th>Winning model</th><th class="num">MAE</th><th class="num">R\u00b2</th><th>Error by model (lower is better)</th><th class="num">vs baseline</th></tr></thead><tbody>' + ids.map(function (id) {
      var f = d.facilities[id], m = f.metrics, best = m[f.best], mx = Math.max(m.linear.mae, m.random_forest.mae, m.gradient_boosting.mae), gain = Math.round((1 - best.mae / m.linear.mae) * 100);
      return "<tr><td><b>" + E(d.facility_names[id]) + "</b></td><td>" + E(f.best_label) + '</td><td class="num"><b>' + best.mae.toFixed(2) + '</b></td><td class="num">' + best.r2.toFixed(3) + '</td><td><div class="mae-bars">' +
        ["linear", "random_forest", "gradient_boosting"].map(function (k) { return '<div class="' + (k === f.best ? "best" : "") + '"><span>' + MODEL_SHORT[k] + '</span><i style="width:' + (m[k].mae / mx * 100) + '%"></i><b>' + m[k].mae.toFixed(1) + "</b></div>"; }).join("") +
        '</div></td><td class="num"><b>' + (gain > 0 ? "\u2212" + gain + "% error" : "same") + "</b></td></tr>";
    }).join("") + "</tbody>";
    H.pills($("#ml-facs"), ids, S.ml.fac, function (id) { S.ml.fac = id; renderModelFac(); });
    renderModelFac();
    $("#ml-runs").innerHTML = d.runs.length ? d.runs.map(function (r) {
      var m = Object.keys(r.summary).map(function (k) { return r.summary[k].mae; });
      return "<li><span>" + stamp(r.trained_at) + "</span><span>" + r.rows.toLocaleString() + " rows \u00b7 mean MAE " + avg(m).toFixed(2) + "</span></li>";
    }).join("") : '<li class="muted">No runs yet.</li>';
  }
  function renderModelFac() {
    var d = S.ml.data, f = d.facilities[S.ml.fac], mx = f.importance[0].value || 1;
    $("#ml-imp").innerHTML = f.importance.map(function (r) { return '<div class="imp-row"><span>' + E(r.label) + '</span><span class="trk"><i style="width:' + (r.value / mx * 100) + '%"></i></span><b>' + Math.round(r.value * 100) + "%</b></div>"; }).join("");
    var ho = f.holdout, n = ho.ts.length;
    $("#ml-chart-sub").textContent = d.facility_names[S.ml.fac] + ": " + f.best_label + " on " + f.n_test.toLocaleString() + " unseen hours (last " + d.holdout_days + " days). MAE " + f.metrics[f.best].mae + ", R\u00b2 " + f.metrics[f.best].r2 + ".";
    Charts.line($("#ml-chart"), { height: 250, xStep: Math.max(1, Math.floor(n / 6)), xLabels: ho.ts.map(function (t) { return t.slice(8, 10) + "/" + t.slice(5, 7); }), label: "Predicted versus actual",
      series: [{ name: "Actual", data: ho.actual, color: C.INK, width: 2 }, { name: "Predicted", data: ho.pred, color: C.Q3, width: 2 }],
      tip: function (i) { return "<strong>" + ho.ts[i] + "</strong><br>Actual " + ho.actual[i] + "%<br>Predicted " + ho.pred[i] + "%"; } });
  }
  function loadModel() { return api("/api/model").then(function (d) { S.ml.data = d; renderModel(); }).catch(fail); }
  INIT.model = function () {
    if (H.IS_ADMIN) {
      var b = $("#ml-retrain"); b.hidden = false;
      b.addEventListener("click", function () {
        b.disabled = true; b.textContent = "Training...";
        api("/api/admin/retrain", { method: "POST" }).then(function () { toast("Models retrained"); S.dirty = true; return loadModel(); }).catch(fail).then(function () { b.disabled = false; b.textContent = "Retrain models"; });
      });
    }
    loadModel();
  };

  /* ================================================================== ADMIN */
  function loadAdmin() {
    return api("/api/admin/summary").then(function (d) {
      $("#ad-stats").innerHTML = [[d.stats.users, "registered users"], [d.stats.reports_24h, "crowd reports in 24 h"], [d.stats.alerts, "active alert rules"], [d.stats.events, "upcoming events"]]
        .map(function (f) { return '<div class="fact"><b>' + f[0] + "</b><span>" + f[1] + "</span></div>"; }).join("");
      $("#ad-risks").innerHTML = d.risks.length ? d.risks.map(function (r) {
        return '<li><span class="rk-n">' + E(r.name) + " at " + r.time + '</span><span class="lvl lv' + (r.severity === "high" ? 4 : 3) + '">' + Math.round(r.pct) + "% \u00b7 " + (r.severity === "high" ? "Packed" : "Watch") + '</span><span class="rk-a">Suggested action: ' + E(r.action) + ".</span></li>";
      }).join("") : '<li class="muted">No congestion expected. Every place stays below 72% for the next eight hours.</li>';
      $("#ad-staff").innerHTML = '<thead><tr><th>Place</th><th>Role</th><th class="num">Now</th><th class="num">Peak, next 6 h</th></tr></thead><tbody>' + d.staffing.map(function (s) {
        return "<tr><td><b>" + E(s.name) + "</b></td><td>" + E(s.role) + '</td><td class="num">' + (s.now || "\u2013") + '</td><td class="num">' + (s.peak ? "<b>" + s.peak + "</b> <small class=\"muted\">at " + s.peak_hour + "</small>" : "\u2013") + "</td></tr>";
      }).join("") + "</tbody>";
      $("#ad-events").innerHTML = d.events.length ? d.events.map(function (e) {
        return "<li><div><b>" + E(e.title) + "</b><small>" + E(H.facName(e.facility)) + " \u00b7 " + Util.dayLabel(e.event_date) + " \u00b7 " + hh(e.start_hour) + "\u2013" + hh(e.end_hour) + '</small></div><button class="icon-btn" data-ev="' + e.id + '" aria-label="Delete event">\u00d7</button></li>';
      }).join("") : '<li class="muted">No upcoming events. Add one to see the forecasts react.</li>';
      $("#ad-log").innerHTML = d.logs.map(function (l) { return "<li><span><b>" + E(l.who) + "</b> " + E(l.action) + (l.detail ? " \u00b7 " + E(l.detail) : "") + "</span><small>" + stamp(l.created_at) + "</small></li>"; }).join("");
      $("#ad-users").innerHTML = '<thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Role</th><th>Last login</th></tr></thead><tbody>' + d.users.map(function (u) {
        return "<tr><td><b>" + E(u.name) + "</b></td><td>" + E(u.email) + "</td><td>" + E(u.department) + " Y" + u.year + "</td><td>" + E(u.role) + "</td><td>" + (u.last_login ? stamp(u.last_login) : "\u2013") + "</td></tr>";
      }).join("") + "</tbody>";
    }).catch(fail);
  }
  INIT.admin = function () {
    H.facOptions($("#ev-fac"), "ground"); H.hourOptions($("#ev-start"), 0, 23, 16); H.hourOptions($("#ev-end"), 1, 24, 20);
    $("#ev-date").value = H.todayIso();
    $("#ev-add").addEventListener("click", function () {
      api("/api/admin/events", { method: "POST", body: { title: $("#ev-title").value, facility: $("#ev-fac").value, date: $("#ev-date").value, start: +$("#ev-start").value, end: +$("#ev-end").value } })
        .then(function () { msg("#ev-msg", "Event added. Forecasts now include it.", "good"); $("#ev-title").value = ""; S.dirty = true; S.loaded.forecast = false; loadAdmin(); })
        .catch(function (e) { msg("#ev-msg", e.message, "bad"); });
    });
    $("#ad-events").addEventListener("click", function (e) { var b = e.target.closest("[data-ev]"); if (b) api("/api/admin/events/" + b.dataset.ev, { method: "DELETE" }).then(function () { toast("Event removed"); S.dirty = true; S.loaded.forecast = false; loadAdmin(); }).catch(fail); });
    loadAdmin();
  };
  REFRESH.admin = function () { loadAdmin(); };

  /* ================================================================== START */
  Promise.all([api("/api/config"), api("/api/me"), api("/api/twin")]).then(function (r) {
    S.cfg = r[0]; S.cfg.facilities.forEach(function (f) { S.facs[f.id] = f; S.order.push(f.id); });
    r[1].favorites.forEach(function (id) { S.favs[id] = true; });
    S.home = r[2]; S.twin = r[2]; S.offset = new Date(r[0].now) - Date.now();
    CT.renderChips();
    CT.show(location.hash.slice(1) || "twin");
    CT.poll();
    setInterval(CT.poll, 60000);
    var flash = document.body.dataset.flash; if (flash) toast(flash);
  }).catch(function (e) { fail(e); });
})();

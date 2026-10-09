/* landing.js - live map, legend and "Today across campus" table for the public home page */
(function () {
  "use strict";
  var E = Util.esc;

  function get(url) { return fetch(url, { headers: { Accept: "application/json" } }).then(function (r) { return r.json(); }); }

  Promise.all([get("/api/config"), get("/api/public/snapshot")]).then(function (res) {
    var cfg = res[0], snap = res[1];
    var twin = CampusTwin.create(document.getElementById("hero-map"), { facilities: cfg.facilities });
    CampusTwin.legend(document.getElementById("hero-legend"));

    var values = {};
    snap.facilities.forEach(function (f) { values[f.id] = { pct: f.pct, open: f.open, hc: f.hc }; });
    // one orchestrated moment: the buildings "fill in" one after another
    var ids = Object.keys(values), partial = {};
    ids.forEach(function (id, i) {
      setTimeout(function () { partial[id] = values[id]; twin.update(partial); }, 140 + i * 110);
    });

    var t = new Date(snap.now);
    document.getElementById("hero-clock").textContent = "Live " + Util.dayLabel(snap.now) +
      " \u00b7 " + String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
    var p = snap.pulse;
    document.getElementById("hero-pulse").innerHTML = "Campus pulse <b>" + Math.round(p.value) + "</b> \u00b7 " + E(p.label) +
      (snap.context.label !== "Regular teaching day" ? " \u00b7 " + E(snap.context.label) : "");

    var nowH = t.getHours(), byId = {};
    cfg.facilities.forEach(function (f) { byId[f.id] = f; });
    var rows = snap.facilities.map(function (f) {
      var c = byId[f.id], lv = f.open ? Util.level(f.pct) : 0;
      var nowCell = f.open
        ? '<div class="now"><b>' + Math.round(f.pct) + '%</b><span class="lvl lv' + lv + '">' + Util.levelName(f.pct) + "</span></div>"
        : '<div class="now"><span class="lvl lv0">Closed</span></div>';
      var best = f.best ? "<b>" + Util.hh(f.best.start) + "&ndash;" + Util.hh(f.best.end) + "</b> <small>" + Math.round(f.best.pct) + "% full</small>" : "&ndash;";
      return "<tr><td class=\"place\">" + E(c.name) + "<small>Capacity " + c.capacity.toLocaleString() + "</small></td><td>" + nowCell +
        "</td><td class=\"best\">" + best + "</td><td>" + Charts.spark(f.pct_day, f.open_hours, nowH, 190, 38) + "</td></tr>";
    });
    document.querySelector("#today-board tbody").innerHTML = rows.join("");
  }).catch(function () {
    document.querySelector("#today-board tbody").innerHTML = '<tr><td colspan="4" class="muted">Could not load live data. Make sure the server is running.</td></tr>';
    document.getElementById("hero-clock").textContent = "Offline";
  });
})();

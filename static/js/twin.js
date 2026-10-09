/* twin.js - the plan-view "digital twin" of the campus.
 *
 * CampusTwin.create(hostElement, { facilities: [...], onSelect(id) })
 *   .update({ library: {pct, open, hc}, ... })   colour every zone from data
 *   .setPinned(['gym'])  .select('library')
 * Everything is drawn as inline SVG so it works offline and can be styled from CSS.
 */
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var W = 960, H = 560;

  // Zone geometry in map units (960 x 540). depth = height of the extruded "slab".
  var ZONES = {
    labs:    { x: 108, y: 90,  w: 252, h: 112, depth: 9,  kind: "block", dots: 64 },
    library: { x: 108, y: 236, w: 252, h: 112, depth: 15, kind: "block", dots: 84 },
    ground:  { x: 108, y: 380, w: 312, h: 116, depth: 0,  kind: "oval",  dots: 60 },
    mess:    { x: 560, y: 90,  w: 292, h: 112, depth: 10, kind: "block", dots: 96 },
    cafe:    { x: 560, y: 236, w: 136, h: 112, depth: 8,  kind: "block", dots: 40 },
    gym:     { x: 716, y: 236, w: 136, h: 112, depth: 12, kind: "block", dots: 40 },
    parking: { x: 520, y: 380, w: 332, h: 116, depth: 0,  kind: "lot",   dots: 0 }
  };
  var SHORT = { library: "Library", labs: "Labs", mess: "Mess", cafe: "Food Court", gym: "Gym", ground: "Ground", parking: "Parking" };
  var LEVEL_NAMES = ["Closed", "Quiet", "Moderate", "Busy", "Packed"];

  function rng(seed) {                       // small deterministic PRNG so the map never "jitters"
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function el(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function levelOf(p) { p = Math.round(p); return p < 30 ? 1 : p < 55 ? 2 : p < 80 ? 3 : 4; }

  // subtle interior drawings that tell the zones apart (shelves, desks, tables...)
  function drawDetail(g, id, z) {
    var x = z.x, y = z.y, w = z.w, h = z.h, i, j;
    if (id === "library") {
      for (i = 0; i < 9; i++) el("rect", { x: x + 16 + i * 26, y: y + 30, width: 8, height: h - 44, rx: 2, class: "dt" }, g);
      el("rect", { x: x + 10, y: y + 10, width: 56, height: 12, rx: 3, class: "dt" }, g);
    } else if (id === "labs") {
      for (i = 0; i < 8; i++) for (j = 0; j < 3; j++) el("rect", { x: x + 16 + i * 29, y: y + 26 + j * 27, width: 18, height: 12, rx: 2, class: "dt" }, g);
    } else if (id === "mess") {
      for (i = 0; i < 4; i++) for (j = 0; j < 8; j++) el("rect", { x: x + 16 + j * 34, y: y + 24 + i * 22, width: 26, height: 9, rx: 4, class: "dt" }, g);
    } else if (id === "cafe") {
      for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) el("circle", { cx: x + 26 + i * 42, cy: y + 34 + j * 26, r: 8, class: "dt" }, g);
    } else if (id === "gym") {
      for (i = 0; i < 4; i++) for (j = 0; j < 3; j++) el("rect", { x: x + 14 + i * 29, y: y + 28 + j * 26, width: 20, height: 10, rx: 3, class: "dt" }, g);
    }
  }

  function create(host, opts) {
    opts = opts || {};
    var facs = {}, order = [];
    (opts.facilities || []).forEach(function (f) { facs[f.id] = f; order.push(f.id); });
    if (!order.length) order = Object.keys(ZONES);

    host.innerHTML = "";
    host.classList.add("twin-host");
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, class: "twin-svg", role: "group",
      "aria-label": "Plan view of the campus. Each building is coloured by how crowded it is." });
    host.appendChild(svg);

    // ---- base layer ----------------------------------------------------------------
    el("rect", { x: 0, y: 0, width: W, height: H, rx: 16, class: "m-ground" }, svg);
    var base = el("g", {}, svg);
    el("rect", { x: 64, y: 44, width: 832, height: 472, rx: 40, class: "m-road-edge", fill: "none", "stroke-width": 30 }, base);
    el("line", { x1: 77, y1: 221, x2: 883, y2: 221, class: "m-road-edge", "stroke-width": 22 }, base);
    el("line", { x1: 77, y1: 364, x2: 883, y2: 364, class: "m-road-edge", "stroke-width": 22 }, base);
    el("line", { x1: 460, y1: 57, x2: 460, y2: 503, class: "m-road-edge", "stroke-width": 26 }, base);
    el("rect", { x: 64, y: 44, width: 832, height: 472, rx: 40, class: "m-road", fill: "none", "stroke-width": 26 }, base);
    el("line", { x1: 77, y1: 221, x2: 883, y2: 221, class: "m-road", "stroke-width": 18 }, base);
    el("line", { x1: 77, y1: 364, x2: 883, y2: 364, class: "m-road", "stroke-width": 18 }, base);
    el("line", { x1: 460, y1: 57, x2: 460, y2: 503, class: "m-road", "stroke-width": 22 }, base);
    // lane markings
    ["221", "364"].forEach(function (yy) { el("line", { x1: 90, y1: yy, x2: 870, y2: yy, class: "m-lane" }, base); });
    el("line", { x1: 460, y1: 70, x2: 460, y2: 490, class: "m-lane" }, base);
    // plaza with fountain
    el("circle", { cx: 460, cy: 292, r: 40, class: "m-plaza" }, base);
    el("circle", { cx: 460, cy: 292, r: 22, class: "m-water" }, base);
    el("circle", { cx: 460, cy: 292, r: 8, class: "m-plaza" }, base);
    // footpaths from plaza to the buildings
    [[360, 292, 420, 292], [500, 292, 560, 292]].forEach(function (p) { el("line", { x1: p[0], y1: p[1], x2: p[2], y2: p[3], class: "m-path" }, base); });

    // trees (rejection sampling so they never land on buildings/roads)
    var r = rng(7), zonesArr = Object.keys(ZONES).map(function (k) { return ZONES[k]; }), tries = 0, placed = 0;
    while (placed < 46 && tries < 900) {
      tries++;
      var tx = 96 + r() * 768, ty = 66 + r() * 428, bad = false;
      zonesArr.forEach(function (z) { if (tx > z.x - 16 && tx < z.x + z.w + 26 && ty > z.y - 26 && ty < z.y + z.h + 28) bad = true; });
      if (Math.abs(ty - 221) < 20 || Math.abs(ty - 364) < 20 || Math.abs(tx - 460) < 22 || Math.hypot(tx - 460, ty - 292) < 48) bad = true;
      if (tx < 88 || tx > 872 || ty < 68 || ty > 492) bad = true;
      if (bad) continue;
      placed++;
      el("circle", { cx: tx, cy: ty, r: 5 + r() * 4, class: "m-tree" }, base);
    }
    // gate + compass
    var gate = el("g", { transform: "translate(250,516)" }, base);
    el("rect", { x: -26, y: -7, width: 52, height: 14, rx: 3, class: "m-gate" }, gate);
    var gt = el("text", { x: 0, y: 3.5, "text-anchor": "middle", class: "m-gate-t" }, gate); gt.textContent = "MAIN GATE";
    var comp = el("g", { transform: "translate(926,74)", class: "m-compass" }, base);
    el("path", { d: "M0,-12 L6,6 L0,2 L-6,6 Z" }, comp);
    var nt = el("text", { x: 0, y: 21, "text-anchor": "middle" }, comp); nt.textContent = "N";

    // ---- zones ------------------------------------------------------------------------
    var zoneEls = {}, tagEls = {}, dotSets = {}, bayEls = {};
    var zLayer = el("g", {}, svg), tLayer = el("g", {}, svg);

    order.forEach(function (id, idx) {
      var z = ZONES[id]; if (!z) return;
      var g = el("g", { class: "zone lv0", "data-id": id, tabindex: opts.interactive === false ? "-1" : "0", role: "button",
        "aria-label": (facs[id] ? facs[id].name : id) }, zLayer);
      var rr = rng(101 + idx * 17);
      if (z.kind === "block") {
        el("rect", { x: z.x + 3, y: z.y + z.depth, width: z.w, height: z.h, rx: 8, class: "slab" }, g);
        el("rect", { x: z.x, y: z.y, width: z.w, height: z.h, rx: 8, class: "face" }, g);
        var dg = el("g", {}, g); drawDetail(dg, id, z);
        var dots = [], k;
        for (k = 0; k < z.dots; k++) dots.push(el("circle", { cx: z.x + 12 + rr() * (z.w - 24), cy: z.y + 14 + rr() * (z.h - 26), r: 2.7, class: "dot" }, g));
        dotSets[id] = dots;
      } else if (z.kind === "oval") {
        el("rect", { x: z.x, y: z.y, width: z.w, height: z.h, rx: 14, class: "face" }, g);
        var cx = z.x + z.w / 2, cy = z.y + z.h / 2;
        el("ellipse", { cx: cx, cy: cy, rx: z.w / 2 - 14, ry: z.h / 2 - 12, class: "track" }, g);
        el("ellipse", { cx: cx, cy: cy, rx: z.w / 2 - 44, ry: z.h / 2 - 32, class: "pitch" }, g);
        el("line", { x1: cx, y1: cy - z.h / 2 + 32, x2: cx, y2: cy + z.h / 2 - 32, class: "dt" }, g);
        el("circle", { cx: cx, cy: cy, r: 12, class: "dt", fill: "none" }, g);
        var od = [];
        for (k = 0; k < z.dots; k++) {
          var a = rr() * Math.PI * 2, inField = rr() < 0.45, s = inField ? rr() * 0.72 : 0.80 + rr() * 0.16;
          od.push(el("circle", { cx: cx + Math.cos(a) * (z.w / 2 - 14) * s, cy: cy + Math.sin(a) * (z.h / 2 - 12) * s, r: 2.7, class: "dot" }, g));
        }
        dotSets[id] = od;
      } else {                                               // parking lot with 64 bays
        el("rect", { x: z.x, y: z.y, width: z.w, height: z.h, rx: 8, class: "face" }, g);
        var bays = [], rows = [10, 32, 70, 92], cols = 16, pitch = (z.w - 24) / cols, c, rw;
        for (rw = 0; rw < rows.length; rw++) for (c = 0; c < cols; c++)
          bays.push(el("rect", { x: z.x + 12 + c * pitch + 1, y: z.y + rows[rw], width: pitch - 4, height: 18, rx: 2, class: "bay" }, g));
        // deterministic shuffle: which bays fill first
        var sh = rng(55), n = bays.length;
        for (k = n - 1; k > 0; k--) { var j = Math.floor(sh() * (k + 1)); var t = bays[k]; bays[k] = bays[j]; bays[j] = t; }
        bayEls[id] = bays;
      }
      zoneEls[id] = g;

      // name/percent tag (drawn in a separate layer so neighbours never cover it)
      var label = SHORT[id] || id;
      var tg = el("g", { class: "tag lv0", "data-id": id, transform: "translate(" + (z.x + 8) + "," + (z.y - 12) + ")" }, tLayer);
      var nameW = Math.round(label.length * 6.9 + 30);
      el("rect", { width: nameW, height: 23, rx: 11.5, class: "tag-name" }, tg);
      el("circle", { cx: 12, cy: 11.5, r: 4.2, class: "tag-dot" }, tg);
      var t1 = el("text", { x: 22, y: 15.6, class: "tag-t" }, tg); t1.textContent = label;
      var pr = el("rect", { x: nameW + 2, width: 44, height: 23, rx: 11.5, class: "tag-pct" }, tg);
      var t2 = el("text", { x: nameW + 24, y: 15.6, "text-anchor": "middle", class: "tag-p" }, tg); t2.textContent = "--";
      var pin = el("text", { x: nameW + 52, y: 16, class: "tag-pin", visibility: "hidden" }, tg); pin.textContent = "\u2605";
      tagEls[id] = { g: tg, pct: t2, rect: pr, pin: pin };
    });

    // ---- tooltip + events -------------------------------------------------------------
    var tip = document.createElement("div"); tip.className = "twin-tip"; tip.hidden = true; host.appendChild(tip);
    var state = { values: {}, pinned: {}, selected: null, hover: null };

    function showTip(id, ev) {
      var v = state.values[id], f = facs[id] || {}, hb = host.getBoundingClientRect();
      if (!v) return;
      state.hover = { id: id, ev: ev };
      tip.innerHTML = "<strong>" + (f.name || id) + "</strong><br>" +
        (v.open === false ? "Closed at this hour" :
          Math.round(v.pct) + "% full \u00b7 " + LEVEL_NAMES[levelOf(v.pct)] +
          (f.capacity ? "<br><span>" + Math.round(v.pct / 100 * f.capacity).toLocaleString() + " of " + f.capacity.toLocaleString() + " people</span>" : ""));
      tip.hidden = false;
      var x = ev.clientX - hb.left + 14, y = ev.clientY - hb.top + 14;
      tip.style.left = Math.min(x, hb.width - tip.offsetWidth - 6) + "px";
      tip.style.top = Math.min(y, hb.height - tip.offsetHeight - 6) + "px";
    }
    Object.keys(zoneEls).forEach(function (id) {
      var g = zoneEls[id];
      g.addEventListener("mousemove", function (e) { showTip(id, e); });
      g.addEventListener("mouseleave", function () { tip.hidden = true; state.hover = null; });
      g.addEventListener("click", function () { api.select(id); if (opts.onSelect) opts.onSelect(id); });
      g.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); g.dispatchEvent(new Event("click")); } });
      g.addEventListener("focus", function () { var b = g.getBoundingClientRect(), hb = host.getBoundingClientRect(); showTip(id, { clientX: b.left + b.width / 2, clientY: b.top + 10 }); });
      g.addEventListener("blur", function () { tip.hidden = true; state.hover = null; });
    });

    var api = {
      svg: svg,
      update: function (values) {
        state.values = values || {};
        Object.keys(zoneEls).forEach(function (id) {
          var v = state.values[id], z = ZONES[id], open = v && v.open !== false, pct = v ? v.pct : 0;
          var lv = !v || !open ? 0 : levelOf(pct);
          [zoneEls[id], tagEls[id].g].forEach(function (n) { n.setAttribute("class", n.getAttribute("class").replace(/lv\d/, "lv" + lv)); });
          tagEls[id].pct.textContent = !v ? "--" : open ? Math.round(pct) + "%" : "Closed";
          var w = !open && v ? 52 : 44;
          tagEls[id].rect.setAttribute("width", w);
          tagEls[id].pct.setAttribute("x", parseFloat(tagEls[id].rect.getAttribute("x")) + w / 2);
          tagEls[id].pin.setAttribute("x", parseFloat(tagEls[id].rect.getAttribute("x")) + w + 6);
          var n, i;
          if (dotSets[id]) {
            n = open ? Math.round(pct / 100 * dotSets[id].length) : 0;
            for (i = 0; i < dotSets[id].length; i++) dotSets[id][i].setAttribute("class", i < n ? "dot on" : "dot");
          }
          if (bayEls[id]) {
            n = open ? Math.round(pct / 100 * bayEls[id].length) : 0;
            for (i = 0; i < bayEls[id].length; i++) bayEls[id][i].setAttribute("class", i < n ? "bay on" : "bay");
          }
          var f = facs[id];
          zoneEls[id].setAttribute("aria-label", (f ? f.name : id) + ": " + (!v ? "no data" : open ? Math.round(pct) + " percent full, " + LEVEL_NAMES[lv] : "closed"));
        });
        if (state.hover && !tip.hidden) showTip(state.hover.id, state.hover.ev);   // keep an open tooltip in sync with the data
      },
      setPinned: function (list) {
        state.pinned = {}; (list || []).forEach(function (id) { state.pinned[id] = true; });
        Object.keys(tagEls).forEach(function (id) { tagEls[id].pin.setAttribute("visibility", state.pinned[id] ? "visible" : "hidden"); });
      },
      select: function (id) {
        state.selected = id;
        Object.keys(zoneEls).forEach(function (k) {
          var c = zoneEls[k].getAttribute("class").replace(/\s*selected/, "");
          zoneEls[k].setAttribute("class", k === id ? c + " selected" : c);
        });
      }
    };
    return api;
  }

  function legend(host) {
    host.innerHTML = ["1|Quiet|under 30%", "2|Moderate|30-54%", "3|Busy|55-79%", "4|Packed|80%+"].map(function (s) {
      var p = s.split("|");
      return '<span class="lg"><i class="sw lv' + p[0] + '"></i>' + p[1] + ' <small>' + p[2] + '</small></span>';
    }).join("") + '<span class="lg"><i class="sw lv0"></i>Closed</span>';
  }

  window.CampusTwin = { create: create, legend: legend, levelOf: levelOf, levelNames: LEVEL_NAMES };
})();

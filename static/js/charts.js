/* charts.js - tiny dependency-free SVG charts + shared helpers.
 *   Charts.line(host, cfg)    line/area chart with confidence band, hover read-out, "now" marker
 *   Charts.heat(host, cfg)    day x hour heat-map
 *   Charts.spark(vals, open, nowHour)   returns an inline <svg> string
 *   Util                      escaping, formatting, colour ramp
 */
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";

  var Util = {
    esc: function (s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    },
    level: function (p) { p = Math.round(p); return p < 30 ? 1 : p < 55 ? 2 : p < 80 ? 3 : 4; },   // follows the number the user sees
    levelName: function (p) { return ["Quiet", "Moderate", "Busy", "Packed"][Util.level(p) - 1]; },
    hh: function (h) { return (h < 10 ? "0" : "") + h + ":00"; },
    pct: function (v) { return Math.round(v) + "%"; },
    // continuous thermal ramp used by the heat-map and bars
    ramp: (function () {
      var stops = [[0, [205, 235, 227]], [28, [88, 184, 164]], [45, [241, 209, 90]], [62, [240, 150, 74]], [80, [220, 90, 60]], [100, [168, 29, 72]]];
      return function (p) {
        p = Math.max(0, Math.min(100, p));
        for (var i = 1; i < stops.length; i++) {
          if (p <= stops[i][0]) {
            var a = stops[i - 1], b = stops[i], t = (p - a[0]) / (b[0] - a[0]);
            return "rgb(" + [0, 1, 2].map(function (k) { return Math.round(a[1][k] + (b[1][k] - a[1][k]) * t); }).join(",") + ")";
          }
        }
        return "rgb(168,29,72)";
      };
    })(),
    inkOn: function (p) { return p > 50 ? "#fff" : "#0e2b36"; },
    DAYS: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    MONTHS: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    parse: function (iso) { var p = iso.slice(0, 10).split("-"); return new Date(+p[0], +p[1] - 1, +p[2], 12); },
    dayLabel: function (iso) { var d = Util.parse(iso); return Util.DAYS[d.getDay()] + " " + d.getDate() + " " + Util.MONTHS[d.getMonth()]; },
    addDays: function (iso, n) {
      var d = Util.parse(iso); d.setDate(d.getDate() + n);
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    },
    relTime: function (min) { return min < 1 ? "just now" : min < 60 ? min + " min ago" : Math.round(min / 60) + " h ago"; }
  };

  function n(tag, attrs, parent, text) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  // shared floating tooltip
  var tipEl;
  function tip() {
    if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "chart-tip"; tipEl.hidden = true; document.body.appendChild(tipEl); }
    return tipEl;
  }
  function showTip(html, ev) {
    var t = tip(); t.innerHTML = html; t.hidden = false;
    var x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + t.offsetWidth > window.innerWidth - 8) x = ev.clientX - t.offsetWidth - 14;
    if (y + t.offsetHeight > window.innerHeight - 8) y = ev.clientY - t.offsetHeight - 14;
    t.style.left = x + "px"; t.style.top = y + "px";
  }
  function hideTip() { if (tipEl) tipEl.hidden = true; }

  /* ---------------------------------------------------------------- line chart */
  function line(host, cfg) {
    host._cfg = cfg;
    if (!host._ro && window.ResizeObserver) {
      host._ro = new ResizeObserver(function () { if (host.clientWidth !== host._w) draw(); });
      host._ro.observe(host);
    }
    draw();

    function draw() {
      var cfg = host._cfg, W = host.clientWidth || 640, H = cfg.height || 240;
      host._w = W;
      var m = { l: 40, r: 16, t: 16, b: 28 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
      var count = cfg.series[0].data.length, yMax = cfg.yMax || 100;
      var X = function (i) { return m.l + (count === 1 ? 0 : i / (count - 1)) * iw; };
      var Y = function (v) { return m.t + ih - (v / yMax) * ih; };
      host.innerHTML = "";
      var svg = n("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, class: "chart-svg", role: "img", "aria-label": cfg.label || "Chart" }, host);

      // level grid
      var ticks = cfg.ticks || [0, 30, 55, 80, 100];
      ticks.forEach(function (t) {
        n("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: t === 0 ? "ax-base" : "ax-grid" }, svg);
        n("text", { x: m.l - 8, y: Y(t) + 3.5, "text-anchor": "end", class: "ax-t" }, svg, t + (cfg.unit === undefined ? "%" : cfg.unit));
      });
      // x labels
      var step = cfg.xStep || 3;
      for (var i = 0; i < count; i += step) {
        var lab = cfg.xLabels ? cfg.xLabels[i] : (i < 10 ? "0" : "") + i;
        n("text", { x: X(i), y: H - 8, "text-anchor": "middle", class: "ax-t" }, svg, lab);
      }
      // shaded ranges (e.g. best window)
      (cfg.shade || []).forEach(function (s) {
        n("rect", { x: X(s.from), y: m.t, width: Math.max(2, X(s.to) - X(s.from)), height: ih, class: "shade", fill: s.color || "#4FBFAA" }, svg);
        if (s.label) n("text", { x: X(s.from) + 4, y: m.t + 12, class: "shade-t" }, svg, s.label);
      });

      cfg.series.forEach(function (s) {
        // split at nulls (closed hours)
        var segs = [], cur = [];
        s.data.forEach(function (v, i) { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(i); });
        if (cur.length) segs.push(cur);
        segs.forEach(function (seg) {
          if (s.band) {
            var up = seg.map(function (i) { return X(i) + "," + Y(s.band.hi[i]); });
            var dn = seg.slice().reverse().map(function (i) { return X(i) + "," + Y(s.band.lo[i]); });
            n("polygon", { points: up.concat(dn).join(" "), class: "ci-band", fill: s.color }, svg);
          }
          var d = seg.map(function (i, k) { return (k ? "L" : "M") + X(i).toFixed(1) + " " + Y(s.data[i]).toFixed(1); }).join(" ");
          if (s.area) n("path", { d: d + " L" + X(seg[seg.length - 1]) + " " + Y(0) + " L" + X(seg[0]) + " " + Y(0) + " Z", fill: s.color, class: "area" }, svg);
          n("path", { d: d, fill: "none", stroke: s.color, "stroke-width": s.width || 2.6, "stroke-dasharray": s.dash ? "6 5" : "none", "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
          if (s.dots) seg.forEach(function (i) { n("circle", { cx: X(i), cy: Y(s.data[i]), r: 2.6, fill: s.color }, svg); });
        });
      });

      // markers (peak etc.)
      (cfg.marks || []).forEach(function (mk) {
        n("circle", { cx: X(mk.x), cy: Y(mk.y), r: 5, class: "mark", stroke: mk.color || "#0E2B36" }, svg);
        if (mk.label) {
          var right = X(mk.x) > W - 90;
          n("text", { x: X(mk.x) + (right ? -9 : 9), y: Y(mk.y) - 8, "text-anchor": right ? "end" : "start", class: "mark-t" }, svg, mk.label);
        }
      });
      // now / cursor lines
      [["now", cfg.now, "Now"], ["cursor", cfg.cursor, ""]].forEach(function (p) {
        if (p[1] == null || p[1] < 0 || p[1] > count - 1) return;
        n("line", { x1: X(p[1]), x2: X(p[1]), y1: m.t, y2: m.t + ih, class: "v-" + p[0] }, svg);
        if (p[2]) {
          n("rect", { x: X(p[1]) - 16, y: m.t - 12, width: 32, height: 15, rx: 7.5, class: "now-pill" }, svg);
          n("text", { x: X(p[1]), y: m.t - 1.5, "text-anchor": "middle", class: "now-t" }, svg, p[2]);
        }
      });

      // hover
      var hoverLine = n("line", { y1: m.t, y2: m.t + ih, class: "v-hover", visibility: "hidden" }, svg);
      var hit = n("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent", style: "cursor:" + (cfg.onPick ? "pointer" : "crosshair") }, svg);
      function idxFrom(ev) {
        var b = svg.getBoundingClientRect(), px = (ev.clientX - b.left) * (W / b.width);
        return Math.max(0, Math.min(count - 1, Math.round((px - m.l) / iw * (count - 1))));
      }
      hit.addEventListener("mousemove", function (ev) {
        var i = idxFrom(ev);
        hoverLine.setAttribute("x1", X(i)); hoverLine.setAttribute("x2", X(i)); hoverLine.setAttribute("visibility", "visible");
        var html = cfg.tip ? cfg.tip(i) : "<strong>" + (cfg.xLabels ? cfg.xLabels[i] : Util.hh(i)) + "</strong>" + cfg.series.map(function (s) {
          return s.data[i] == null ? "" : '<br><i style="background:' + s.color + '"></i>' + Util.esc(s.name || "") + " " + Math.round(s.data[i]) + "%";
        }).join("");
        if (html) showTip(html, ev);
      });
      hit.addEventListener("mouseleave", function () { hoverLine.setAttribute("visibility", "hidden"); hideTip(); });
      if (cfg.onPick) hit.addEventListener("click", function (ev) { cfg.onPick(idxFrom(ev)); });
    }
  }

  /* ---------------------------------------------------------------- heat-map */
  function heat(host, cfg) {
    host._cfg = cfg;
    if (!host._ro && window.ResizeObserver) {
      host._ro = new ResizeObserver(function () { if (host.clientWidth !== host._w) draw(); });
      host._ro.observe(host);
    }
    draw();
    function draw() {
      var cfg = host._cfg, W = host.clientWidth || 700, labW = 96, top = 22, ch = cfg.cellH || 34;
      host._w = W;
      var cw = (W - labW - 4) / 24, H = top + cfg.rows.length * ch + 4;
      host.innerHTML = "";
      var svg = n("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, class: "chart-svg", role: "img", "aria-label": cfg.label || "Heat-map" }, host);
      var defs = n("defs", {}, svg), pat = n("pattern", { id: "hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
      n("rect", { width: 6, height: 6, fill: "#EEF2F2" }, pat); n("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "#D3DCDD", "stroke-width": 2 }, pat);
      for (var c = 0; c < 24; c += 3) n("text", { x: labW + c * cw + cw / 2, y: 13, "text-anchor": "middle", class: "ax-t" }, svg, (c < 10 ? "0" : "") + c);
      cfg.rows.forEach(function (row, r) {
        var y = top + r * ch;
        n("text", { x: 0, y: y + ch / 2 - 1, class: "hm-lab" }, svg, row.label);
        if (row.sub) n("text", { x: 0, y: y + ch / 2 + 11, class: "hm-sub" }, svg, row.sub);
        for (var h = 0; h < 24; h++) {
          var open = row.open[h], v = row.vals[h], x = labW + h * cw;
          var rect = n("rect", { x: x + 1, y: y + 1, width: cw - 2, height: ch - 2, rx: 3, fill: open ? Util.ramp(v) : "url(#hatch)", class: "hm-cell" }, svg);
          if (open && cw >= 27) n("text", { x: x + cw / 2, y: y + ch / 2 + 3.6, "text-anchor": "middle", class: "hm-v", fill: Util.inkOn(v) }, svg, Math.round(v));
          (function (rr, hh, vv, oo, rw) {
            rect.addEventListener("mousemove", function (ev) {
              showTip("<strong>" + Util.esc(rw.label) + " \u00b7 " + Util.hh(hh) + "</strong><br>" + (oo ? Math.round(vv) + "% \u00b7 " + Util.levelName(vv) : "Closed"), ev);
            });
            rect.addEventListener("mouseleave", hideTip);
            if (cfg.onCell) rect.addEventListener("click", function () { cfg.onCell(rr, hh); });
          })(r, h, v, open, row);
        }
      });
      if (cfg.best) {
        n("rect", { x: labW + cfg.best.col * cw - 0.5, y: top + cfg.best.row * ch - 0.5, width: cw + 1, height: ch + 1, rx: 4, class: "hm-best" }, svg);
      }
    }
  }

  /* ---------------------------------------------------------------- sparkline */
  function spark(vals, open, nowHour, w, h) {
    w = w || 150; h = h || 34;
    var X = function (i) { return 2 + i / 23 * (w - 4); }, Y = function (v) { return h - 3 - v / 100 * (h - 8); };
    var d = "", pen = false;
    vals.forEach(function (v, i) {
      if (!open[i]) { pen = false; return; }
      d += (pen ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1) + " "; pen = true;
    });
    var dot = nowHour != null && open[nowHour] ? '<circle cx="' + X(nowHour).toFixed(1) + '" cy="' + Y(vals[nowHour]).toFixed(1) + '" r="3.2" class="sp-dot"/>' : "";
    var now = nowHour != null ? '<line x1="' + X(nowHour).toFixed(1) + '" x2="' + X(nowHour).toFixed(1) + '" y1="2" y2="' + (h - 2) + '" class="sp-now"/>' : "";
    return '<svg class="spark" viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h + '" aria-hidden="true">' + now +
      '<path d="' + d + '" fill="none" class="sp-line"/>' + dot + "</svg>";
  }

  window.Charts = { line: line, heat: heat, spark: spark, hideTip: hideTip };
  window.Util = Util;
})();

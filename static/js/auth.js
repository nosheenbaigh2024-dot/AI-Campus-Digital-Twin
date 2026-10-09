/* auth.js - login/register behaviour: live map, show-password, strength meter, client-side validation */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };

  // ---- live map on the left ---------------------------------------------------------
  var host = $("#auth-map");
  if (host) {
    Promise.all([fetch("/api/config").then(function (r) { return r.json(); }), fetch("/api/public/snapshot").then(function (r) { return r.json(); })])
      .then(function (res) {
        var twin = CampusTwin.create(host, { facilities: res[0].facilities, interactive: false });
        var values = {}, open = [];
        res[1].facilities.forEach(function (f) { values[f.id] = { pct: f.pct, open: f.open, hc: f.hc }; if (f.open) open.push(f); });
        twin.update(values);
        var byId = {}; res[0].facilities.forEach(function (f) { byId[f.id] = f; });
        if (open.length) {
          open.sort(function (a, b) { return a.pct - b.pct; });
          var q = open[0], b = open[open.length - 1];
          $("#auth-caption").innerHTML = "Right now the <b>" + Util.esc(byId[q.id].short) + "</b> is the quietest place on campus (" + Math.round(q.pct) +
            "%) and the <b>" + Util.esc(byId[b.id].short) + "</b> is the busiest (" + Math.round(b.pct) + "%).";
        }
      }).catch(function () { $("#auth-caption").textContent = "Live campus data is unavailable right now."; });
  }

  // ---- show / hide password ------------------------------------------------------------
  document.querySelectorAll(".pw-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var input = document.getElementById(btn.dataset.target), show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Hide" : "Show";
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
  });

  // ---- demo accounts on the login page ------------------------------------------------
  document.querySelectorAll("[data-fill]").forEach(function (b) {
    b.addEventListener("click", function () {
      var p = b.dataset.fill.split("|");
      $("#email").value = p[0]; $("#password").value = p[1]; $("#password").focus();
    });
  });

  // ---- register form ---------------------------------------------------------------------
  var form = $("#register-form");
  if (!form) return;
  var pw = $("#password"), meter = $(".meter"), hint = $("#pw-hint");

  function strength(v) {
    var s = 0;
    if (v.length >= 8) s++;
    if (/[A-Za-z]/.test(v) && /\d/.test(v)) s++;
    if (v.length >= 12) s++;
    if (/[^A-Za-z0-9]/.test(v) && v.length >= 8) s++;
    return v.length ? Math.max(1, s) : 0;
  }
  pw.addEventListener("input", function () {
    var s = strength(pw.value);
    meter.dataset.s = s;
    hint.textContent = ["Use letters and numbers. A short phrase works well.", "Too weak. Add more characters.", "Okay. Add a few more characters.", "Good password.", "Strong password."][s];
  });

  function setErr(name, msg) {
    var small = form.querySelector('.err[data-for="' + name + '"]');
    if (!small) return;
    small.textContent = msg || "";
    small.closest(".field").classList.toggle("has-error", !!msg);
  }
  var rules = {
    name: function (v) { return v.trim().length >= 2 ? "" : "Enter your full name (2-60 characters)."; },
    email: function (v) { return /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(v.trim()) ? "" : "Enter a valid email address."; },
    password: function (v) { return v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v) ? "" : "Use at least 8 characters with letters and numbers."; },
    confirm: function (v) { return v === pw.value ? "" : "Passwords do not match."; }
  };
  Object.keys(rules).forEach(function (k) {
    var input = $("#" + k);
    input.addEventListener("blur", function () { if (input.value || k === "confirm" && pw.value) setErr(k, rules[k](input.value)); });
    input.addEventListener("input", function () { if (input.closest(".field").classList.contains("has-error")) setErr(k, rules[k](input.value)); });
  });
  form.addEventListener("submit", function (e) {
    var bad = false;
    Object.keys(rules).forEach(function (k) { var m = rules[k]($("#" + k).value); setErr(k, m); if (m) bad = true; });
    if (bad) { e.preventDefault(); var first = form.querySelector(".has-error input"); if (first) first.focus(); }
  });
})();

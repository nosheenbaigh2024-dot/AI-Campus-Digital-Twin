"""
app.py  -  Flask web server for the AI Campus Digital Twin
===========================================================
Run:   python app.py        then open   http://127.0.0.1:5000

Pages      /  /register  /login  /dashboard  /logout
JSON API   /api/config /api/public/snapshot /api/twin /api/live /api/forecast
           /api/whatif /api/plan /api/reports /api/alerts /api/favorites
           /api/model /api/admin/*
Demo accounts (created on first run - change them before deploying):
           admin@campus.edu / Admin@123      student@campus.edu / Student@123
"""
import functools
import os
import re
import secrets
import time
from datetime import date, datetime, timedelta

from flask import (Flask, abort, flash, g, jsonify, redirect, render_template,
                   request, session, url_for)

import database as dbm
from data import prediction as pred

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEPARTMENTS = ["CSE", "IT", "ECE", "EEE", "MECH", "CIVIL", "AI & DS", "MBA"]
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")

app = Flask(__name__)


def _secret_key() -> str:
    """Env var wins; otherwise a random key is generated once and stored next to app.py."""
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    path = os.path.join(BASE_DIR, ".secret_key")
    if not os.path.exists(path):
        with open(path, "w") as fh:
            fh.write(secrets.token_hex(32))
    with open(path) as fh:
        return fh.read().strip()


app.config.update(SECRET_KEY=_secret_key(), SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                  PERMANENT_SESSION_LIFETIME=timedelta(days=7), MAX_CONTENT_LENGTH=64 * 1024)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def now() -> datetime:
    """Server clock. Set CAMPUS_NOW="2026-09-19 12:40" to demo any moment (lunch rush, exam night...)."""
    fake = os.environ.get("CAMPUS_NOW")
    if fake:
        try:
            return datetime.fromisoformat(fake)
        except ValueError:
            pass
    return datetime.now()


def predictor() -> pred.CampusPredictor:
    return pred.get_predictor()


def current_user():
    if "user" not in g:
        uid = session.get("uid")
        g.user = dbm.get_user(uid) if uid else None
        if uid and g.user is None:
            session.clear()
    return g.user


def csrf_token() -> str:
    if "csrf" not in session:
        session["csrf"] = secrets.token_hex(16)
    return session["csrf"]


app.jinja_env.globals["csrf_token"] = csrf_token


def is_api() -> bool:
    return request.path.startswith("/api/")


def login_required(fn):
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        if not current_user():
            if is_api():
                return jsonify(error="Please log in first."), 401
            return redirect(url_for("login", next=request.path))
        return fn(*a, **kw)
    return wrapper


def admin_required(fn):
    @functools.wraps(fn)
    @login_required
    def wrapper(*a, **kw):
        if current_user()["role"] != "admin":
            return jsonify(error="Admin access only."), 403
        return fn(*a, **kw)
    return wrapper


@app.before_request
def csrf_protect():
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        sent = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
        if not sent or not secrets.compare_digest(sent, session.get("csrf", "")):
            if is_api():
                return jsonify(error="Security token missing or expired. Refresh the page."), 400
            abort(400, "Security token missing or expired. Go back, refresh, and try again.")


@app.after_request
def security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["Content-Security-Policy"] = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                                               "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
    if is_api():
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.errorhandler(400)
def bad_request(e):
    if is_api():
        return jsonify(error=getattr(e, "description", "Bad request")), 400
    msg = getattr(e, "description", "Bad request")
    return (f"<h1>Request blocked</h1><p>{msg}</p><p><a href='/'>Back to the home page</a></p>", 400)


@app.errorhandler(404)
def not_found(e):
    if is_api():
        return jsonify(error="Not found"), 404
    return redirect(url_for("index"))


@app.errorhandler(500)
def server_error(e):
    if is_api():
        return jsonify(error="Something went wrong on the server."), 500
    return "Something went wrong. Check the terminal for the error message.", 500


def parse_date(s, default: date) -> date:
    if not s:
        return default
    try:
        d = date.fromisoformat(s)
    except ValueError:
        abort(400, "Invalid date. Use YYYY-MM-DD.")
    if abs((d - default).days) > 400:
        abort(400, "Date is out of the supported range.")
    return d


def check_facility(fac):
    if fac not in pred.FACILITIES:
        abort(400, "Unknown facility.")
    return fac


def day_preds(d: date, overrides=None, extra_events=None) -> dict:
    """Predictions for every facility on date d (DB events are fed to the model automatically)."""
    ev = {k: set(v) for k, v in dbm.event_hours_for(d.isoformat()).items()}
    for e in extra_events or []:
        ev.setdefault(e["facility"], set()).update(range(e["start"], e["end"]))
    return {f: predictor().predict_day(f, d, overrides, ev.get(f, ())) for f in pred.FACILITY_ORDER}


def facility_now(fac: str, p: dict, n: datetime, reports: list) -> dict:
    """Blend the model estimate for 'right now' with recent student reports."""
    h, m = n.hour, n.minute
    opn = p["open"]
    if not opn[h]:
        nxt = next((x for x in list(range(h + 1, 24)) + list(range(0, h)) if opn[x]), None)
        return dict(id=fac, pct=0.0, level=0, open=False, opens_at=nxt, n_reports=0, source="closed", hc=0)
    base = p["pct"][h]
    if h < 23 and opn[h + 1]:
        base = p["pct"][h] * (1 - m / 60) + p["pct"][h + 1] * (m / 60)
    mine = [r for r in reports if r["facility"] == fac]
    b = pred.blend_live(base, mine)
    cap = pred.FACILITIES[fac]["capacity"]
    return dict(id=fac, pct=b["pct"], level=pred.level_of(b["pct"]), open=True, model_pct=round(base, 1),
                n_reports=b["n"], source=b["source"], weight=b["weight"], hc=int(round(b["pct"] / 100 * cap)))


def live_all(n: datetime) -> dict:
    preds = day_preds(n.date())
    reports = dbm.recent_reports(n, 60)
    return {f: facility_now(f, preds[f], n, reports) for f in pred.FACILITY_ORDER}, preds


def facility_config() -> list:
    return [dict(id=f, name=pred.FACILITIES[f]["name"], short=pred.FACILITIES[f]["short"],
                 capacity=pred.FACILITIES[f]["capacity"], open=pred.FACILITIES[f]["open"],
                 staff_role=pred.FACILITIES[f]["staff_role"]) for f in pred.FACILITY_ORDER]


# ---------------------------------------------------------------------------
# pages
# ---------------------------------------------------------------------------
@app.get("/")
def index():
    return render_template("index.html", user=current_user())


@app.route("/register", methods=["GET", "POST"])
def register():
    if current_user():
        return redirect(url_for("dashboard"))
    form = dict(name="", email="", department="CSE", year="2")
    errors = {}
    if request.method == "POST":
        form = {k: request.form.get(k, "").strip() for k in ("name", "email", "department", "year")}
        pw, pw2 = request.form.get("password", ""), request.form.get("confirm", "")
        if not 2 <= len(form["name"]) <= 60:
            errors["name"] = "Enter your full name (2-60 characters)."
        if not EMAIL_RE.match(form["email"]) or len(form["email"]) > 120:
            errors["email"] = "Enter a valid email address."
        elif dbm.get_user_by_email(form["email"]):
            errors["email"] = "This email is already registered. Try logging in."
        if len(pw) < 8 or not re.search(r"[A-Za-z]", pw) or not re.search(r"\d", pw):
            errors["password"] = "Use at least 8 characters with letters and numbers."
        if pw != pw2:
            errors["confirm"] = "Passwords do not match."
        if form["department"] not in DEPARTMENTS:
            errors["department"] = "Choose your department."
        if form["year"] not in ("1", "2", "3", "4"):
            errors["year"] = "Choose your year."
        if not errors:
            uid = dbm.create_user(form["name"], form["email"], pw, form["department"], int(form["year"]))
            dbm.log_action(uid, "register", form["email"])
            session.clear()
            session["uid"], session.permanent = uid, True
            flash("Welcome to Campus Twin! Your account is ready.", "ok")
            return redirect(url_for("dashboard"))
    return render_template("register.html", form=form, errors=errors, departments=DEPARTMENTS)


_attempts: dict = {}


@app.route("/login", methods=["GET", "POST"])
def login():
    if current_user():
        return redirect(url_for("dashboard"))
    next_url = request.values.get("next", "")
    if not (next_url.startswith("/") and not next_url.startswith("//")):
        next_url = ""
    error, email = None, ""
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        key = (request.remote_addr, email)
        recent = [t for t in _attempts.get(key, []) if time.time() - t < 600]
        if len(recent) >= 5:
            error = "Too many failed attempts. Wait a few minutes and try again."
        else:
            u = dbm.verify_login(email, request.form.get("password", ""))
            if u:
                _attempts.pop(key, None)
                session.clear()
                session["uid"], session.permanent = u["id"], True
                dbm.log_action(u["id"], "login", "")
                return redirect(next_url or url_for("dashboard"))
            _attempts[key] = recent + [time.time()]
            error = "Email or password is incorrect."
    return render_template("login.html", error=error, email=email, next_url=next_url)


@app.post("/logout")
def logout():
    session.clear()
    flash("You have been logged out.", "ok")
    return redirect(url_for("index"))


@app.get("/dashboard")
@login_required
def dashboard():
    return render_template("dashboard.html", user=current_user())


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
@app.get("/api/config")
def api_config():
    n = now()
    return jsonify(now=n.isoformat(timespec="seconds"), facilities=facility_config(),
                   levels=[dict(level=i + 1, name=l[2], min=l[0]) for i, l in enumerate(pred.LEVELS)],
                   departments=DEPARTMENTS)


_snapshot_cache = dict(t=0, data=None)


@app.get("/api/public/snapshot")
def api_public_snapshot():
    if time.time() - _snapshot_cache["t"] > 20 or _snapshot_cache["data"] is None:
        n = now()
        live, preds = live_all(n)
        items, vals = [], []
        for f in pred.FACILITY_ORDER:
            p = preds[f]
            bw = pred.best_window(p["pct"], p["open"], 1)
            items.append(dict(live[f], id=f, pct_day=p["pct"], open_hours=p["open"], best=bw))
            if live[f]["open"]:
                vals.append(live[f]["pct"])
        _snapshot_cache.update(t=time.time(), data=dict(now=n.isoformat(timespec="seconds"), facilities=items,
                                                        pulse=pred.campus_pulse(vals),
                                                        context=pred.academic_context(n.date())))
    return jsonify(_snapshot_cache["data"])


# ---------------------------------------------------------------------------
# dashboard API
# ---------------------------------------------------------------------------
@app.get("/api/me")
@login_required
def api_me():
    u = current_user()
    return jsonify(user=dict(id=u["id"], name=u["name"], email=u["email"], role=u["role"],
                             department=u["department"], year=u["year"]),
                   favorites=dbm.list_favorites(u["id"]))


@app.get("/api/twin")
@login_required
def api_twin():
    n = now()
    d = parse_date(request.args.get("date"), n.date())
    preds = day_preds(d)
    ctx, wx = pred.academic_context(d), pred.sim_weather(d)
    live, _ = live_all(n) if d == n.date() else ({}, None)
    facs, pulse_vals = [], [[] for _ in range(24)]
    for f in pred.FACILITY_ORDER:
        p, cfg = preds[f], pred.FACILITIES[f]
        for h in range(24):
            if p["open"][h]:
                pulse_vals[h].append(p["pct"][h])
        start = n.hour if d == n.date() else 0
        facs.append(dict(id=f, name=cfg["name"], short=cfg["short"], capacity=cfg["capacity"], open=p["open"],
                         pct=p["pct"], lo=p["lo"], hi=p["hi"], hc=p["hc"],
                         best=pred.best_window(p["pct"], p["open"], 1), peak=pred.peak_hour(p["pct"], p["open"]),
                         next_good=pred.next_good_window(p["pct"], p["open"], start),
                         live=live.get(f)))
    pulse = [round(sum(v) / len(v), 1) if v else 0 for v in pulse_vals]
    return jsonify(date=d.isoformat(), weekday=d.strftime("%A"), is_today=(d == n.date()),
                   now=n.isoformat(timespec="seconds"), context=ctx, temp=wx["temp"], rain=wx["rain"],
                   facilities=facs, pulse=pulse,
                   pulse_now=pred.campus_pulse([v["pct"] for v in live.values() if v["open"]]) if live else None,
                   events=[e for e in dbm.list_events(d.isoformat()) if e["event_date"] == d.isoformat()])


@app.get("/api/live")
@login_required
def api_live():
    """Polled every 60 s: live estimates + this user's alert rules that are currently satisfied."""
    n, u = now(), current_user()
    live, preds = live_all(n)
    notes = []
    for a in dbm.list_alerts(u["id"]):
        if not a["active"]:
            continue
        f, p = a["facility"], preds[a["facility"]]
        cond = (lambda v: v < a["threshold"]) if a["condition"] == "below" else (lambda v: v > a["threshold"])
        hit = None
        if live[f]["open"] and cond(live[f]["pct"]):
            hit = ("now", live[f]["pct"])
        else:
            for h in range(n.hour + 1, min(24, n.hour + 1 + a["lookahead"])):
                if p["open"][h] and cond(p["pct"][h]):
                    hit = (f"{h:02d}:00", p["pct"][h])
                    break
        if hit:
            word = "below" if a["condition"] == "below" else "above"
            when = "right now" if hit[0] == "now" else f"around {hit[0]}"
            notes.append(dict(id=a["id"], facility=f, when=hit[0],
                              message=f"{pred.FACILITIES[f]['short']} is expected {word} {a['threshold']}% {when} ({hit[1]:.0f}%)."))
            last = a["last_triggered"]
            if not last or (n - datetime.fromisoformat(last)).total_seconds() > 3600:
                dbm.mark_alert_triggered(a["id"], n.isoformat(timespec="seconds"))
    vals = [v["pct"] for v in live.values() if v["open"]]
    return jsonify(now=n.isoformat(timespec="seconds"), live=live, pulse=pred.campus_pulse(vals), notifications=notes)


@app.get("/api/forecast")
@login_required
def api_forecast():
    fac = check_facility(request.args.get("facility", "library"))
    n = now()
    start = parse_date(request.args.get("date"), n.date())
    days = []
    for i in range(7):
        d = start + timedelta(days=i)
        ev = dbm.event_hours_for(d.isoformat()).get(fac, ())
        p = predictor().predict_day(fac, d, None, ev)
        ctx = pred.academic_context(d)
        days.append(dict(date=d.isoformat(), label=d.strftime("%a %d %b"), short=d.strftime("%a"), context=ctx,
                         has_event=bool(ev), pct=p["pct"], lo=p["lo"], hi=p["hi"], open=p["open"], hc=p["hc"],
                         best=pred.best_window(p["pct"], p["open"], 1), best2=pred.best_window(p["pct"], p["open"], 2),
                         peak=pred.peak_hour(p["pct"], p["open"])))
    quiet = min((dict(day=x["label"], date=x["date"], **x["best"]) for x in days if x["best"]), key=lambda z: z["pct"], default=None)
    return jsonify(facility=fac, name=pred.FACILITIES[fac]["name"], capacity=pred.FACILITIES[fac]["capacity"],
                   now=n.isoformat(timespec="seconds"), days=days, quietest=quiet)


def parse_overrides(body: dict) -> dict:
    ov = {}
    for k in ("exam", "holiday", "vacation", "rain"):
        if body.get(k) in (True, False):
            ov[k] = body[k]
    t = body.get("temp")
    if isinstance(t, (int, float)) and not isinstance(t, bool) and 10 <= t <= 48:
        ov["temp"] = float(t)
    if body.get("daytype") in ("weekday", "weekend"):
        ov["daytype"] = body["daytype"]
    return ov


@app.post("/api/whatif")
@login_required
def api_whatif():
    body = request.get_json(silent=True) or {}
    n = now()
    d = parse_date(body.get("date"), n.date())
    ov = parse_overrides(body)
    extra = []
    for e in (body.get("events") or [])[:3]:
        try:
            s, en = int(e["start"]), int(e["end"])
            if e["facility"] in pred.FACILITIES and 0 <= s < en <= 24:
                extra.append(dict(facility=e["facility"], start=s, end=en))
        except (KeyError, TypeError, ValueError):
            abort(400, "Invalid event.")
    base, scen = day_preds(d), day_preds(d, ov, extra)
    return jsonify(date=d.isoformat(), context=pred.academic_context(d),
                   facilities=[dict(id=f, name=pred.FACILITIES[f]["name"], short=pred.FACILITIES[f]["short"],
                                    open=base[f]["open"], base=base[f]["pct"], scenario=scen[f]["pct"],
                                    base_hc=base[f]["hc"], scenario_hc=scen[f]["hc"]) for f in pred.FACILITY_ORDER])


def _to_min(s, default):
    try:
        h, m = s.split(":")
        v = int(h) * 60 + int(m)
        return v if 0 <= v <= 1440 else default
    except (AttributeError, ValueError):
        return default


@app.post("/api/plan")
@login_required
def api_plan():
    body = request.get_json(silent=True) or {}
    n = now()
    d = parse_date(body.get("date"), n.date())
    acts = body.get("activities") or []
    if not 1 <= len(acts) <= 5:
        abort(400, "Add between 1 and 5 activities.")
    clean = []
    for a in acts:
        fac = check_facility(a.get("facility"))
        mins = a.get("minutes")
        if not isinstance(mins, int) or not 15 <= mins <= 240 or mins % 15:
            abort(400, "Duration must be a multiple of 15 minutes (15-240).")
        clean.append(dict(facility=fac, minutes=mins))
    start, end = _to_min(body.get("start"), 8 * 60), _to_min(body.get("end"), 21 * 60)
    if end - start < 30:
        abort(400, "Your time window is too short.")
    buf = body.get("buffer", 15)
    buf = buf if isinstance(buf, int) and 0 <= buf <= 60 else 15
    preds = day_preds(d)
    res = pred.plan_day(preds, clean, start, end, buf)
    if res.get("ok"):
        for plan in [res["best"], res["naive"], *res["alternatives"]]:
            for it in (plan or {}).get("items", []):
                it["name"] = pred.FACILITIES[it["facility"]]["short"]
                it["level"] = pred.level_of(it["avg_pct"])
    res["date"] = d.isoformat()
    return jsonify(res)


@app.route("/api/reports", methods=["GET", "POST"])
@login_required
def api_reports():
    u, n = current_user(), now()
    if request.method == "POST":
        body = request.get_json(silent=True) or {}
        fac, level = check_facility(body.get("facility")), body.get("level")
        note = str(body.get("note", "")).strip()
        if level not in (1, 2, 3, 4):
            abort(400, "Choose how busy it feels (1-4).")
        last = dbm.last_report_time(u["id"], fac)
        if last and (n - last).total_seconds() < 600 and not os.environ.get("CAMPUS_NOW"):
            abort(400, "You already reported this place in the last 10 minutes. Thanks!")
        dbm.add_report(u["id"], fac, level, note)
        dbm.log_action(u["id"], "report", f"{fac}: level {level}")
        live, _ = live_all(n)
        return jsonify(ok=True, live=live[fac])
    live, preds = live_all(n)
    reports = dbm.recent_reports(n, 60)
    summary = []
    for f in pred.FACILITY_ORDER:
        mine = [r for r in reports if r["facility"] == f]
        summary.append(dict(id=f, name=pred.FACILITIES[f]["short"], model=live[f].get("model_pct", 0), blended=live[f]["pct"],
                            n=len(mine), open=live[f]["open"],
                            students=round(sum(pred.REPORT_LEVEL_PCT[r["level"]] for r in mine) / len(mine), 1) if mine else None))
    return jsonify(feed=dbm.reports_feed(n, 12), summary=summary)


@app.route("/api/alerts", methods=["GET", "POST"])
@login_required
def api_alerts():
    u = current_user()
    if request.method == "POST":
        b = request.get_json(silent=True) or {}
        fac = check_facility(b.get("facility"))
        cond, thr, look = b.get("condition"), b.get("threshold"), b.get("lookahead", 0)
        if cond not in ("below", "above") or not isinstance(thr, int) or not 5 <= thr <= 100 \
                or not isinstance(look, int) or not 0 <= look <= 6:
            abort(400, "Check the alert values.")
        if len(dbm.list_alerts(u["id"])) >= 12:
            abort(400, "You can have at most 12 alerts. Delete one first.")
        dbm.add_alert(u["id"], fac, cond, thr, look)
        return jsonify(ok=True), 201
    return jsonify(alerts=dbm.list_alerts(u["id"]))


@app.route("/api/alerts/<int:alert_id>", methods=["PATCH", "DELETE"])
@login_required
def api_alert_item(alert_id):
    u = current_user()
    if request.method == "DELETE":
        dbm.delete_alert(u["id"], alert_id)
    else:
        dbm.set_alert_active(u["id"], alert_id, bool((request.get_json(silent=True) or {}).get("active")))
    return jsonify(ok=True)


@app.post("/api/favorites")
@login_required
def api_favorite():
    fac = check_facility((request.get_json(silent=True) or {}).get("facility"))
    pinned = dbm.toggle_favorite(current_user()["id"], fac)
    return jsonify(pinned=pinned, favorites=dbm.list_favorites(current_user()["id"]))


@app.get("/api/model")
@login_required
def api_model():
    s = predictor().summary()
    s["runs"] = dbm.model_runs(5)
    s["facility_names"] = {f: pred.FACILITIES[f]["name"] for f in pred.FACILITY_ORDER}
    return jsonify(s)


# ---------------------------------------------------------------------------
# admin API
# ---------------------------------------------------------------------------
def _upcoming(fac_preds: dict, n: datetime, hours: int):
    """Yield (datetime, {fac: (pct, hc, open)}) for the next `hours` hours (crosses midnight)."""
    tomorrow = None
    for k in range(1, hours + 1):
        t = n.replace(minute=0, second=0, microsecond=0) + timedelta(hours=k)
        if t.date() == n.date():
            src = fac_preds
        else:
            tomorrow = tomorrow or day_preds(t.date())
            src = tomorrow
        yield t, {f: (src[f]["pct"][t.hour], src[f]["hc"][t.hour], src[f]["open"][t.hour]) for f in pred.FACILITY_ORDER}


@app.get("/api/admin/summary")
@admin_required
def api_admin_summary():
    n = now()
    preds = day_preds(n.date())
    risks, staff = [], {f: dict(id=f, name=pred.FACILITIES[f]["short"], role=pred.FACILITIES[f]["staff_role"],
                                now=0, peak=0, peak_hour=None) for f in pred.FACILITY_ORDER}
    for f in pred.FACILITY_ORDER:
        if preds[f]["open"][n.hour]:
            staff[f]["now"] = pred.staffing(f, preds[f]["hc"][n.hour])
    worst = {}
    for t, vals in _upcoming(preds, n, 8):
        for f, (pct, hc, opn) in vals.items():
            if not opn:
                continue
            need = pred.staffing(f, hc)
            if t <= n + timedelta(hours=6) and need > staff[f]["peak"]:
                staff[f]["peak"], staff[f]["peak_hour"] = need, t.strftime("%H:00")
            if pct >= 72 and (f not in worst or pct > worst[f]["pct"]):
                worst[f] = dict(facility=f, name=pred.FACILITIES[f]["name"], time=t.strftime("%H:00"), pct=pct,
                                severity="high" if pct >= 85 else "watch", action=pred.FACILITIES[f]["action"])
    risks = sorted(worst.values(), key=lambda r: -r["pct"])
    return jsonify(
        stats=dict(users=dbm.count_users(), reports_24h=dbm.count_reports_since(24), alerts=dbm.count_active_alerts(),
                   events=len(dbm.list_events(n.date().isoformat()))),
        risks=risks, staffing=list(staff.values()), events=dbm.list_events(n.date().isoformat()),
        logs=dbm.recent_logs(10), users=dbm.list_users()[:8])


@app.post("/api/admin/events")
@admin_required
def api_admin_event_add():
    b = request.get_json(silent=True) or {}
    title = str(b.get("title", "")).strip()
    fac = check_facility(b.get("facility"))
    d = parse_date(b.get("date"), now().date())
    try:
        s, e = int(b.get("start")), int(b.get("end"))
    except (TypeError, ValueError):
        abort(400, "Start and end hours must be numbers.")
    if not 3 <= len(title) <= 80 or not (0 <= s < e <= 24):
        abort(400, "Give the event a title (3-80 characters) and a valid hour range.")
    eid = dbm.add_event(title, fac, d.isoformat(), s, e, current_user()["id"])
    dbm.log_action(current_user()["id"], "event+", f"{title} @ {fac} {d} {s}-{e}h")
    return jsonify(ok=True, id=eid), 201


@app.delete("/api/admin/events/<int:event_id>")
@admin_required
def api_admin_event_delete(event_id):
    dbm.delete_event(event_id)
    dbm.log_action(current_user()["id"], "event-", str(event_id))
    return jsonify(ok=True)


@app.post("/api/admin/retrain")
@admin_required
def api_admin_retrain():
    s = predictor().retrain(log=app.logger.info)
    dbm.save_model_run(s)
    dbm.log_action(current_user()["id"], "retrain", f"{s['rows']} rows")
    _snapshot_cache["data"] = None
    return jsonify(ok=True, trained_at=s["trained_at"])


# ---------------------------------------------------------------------------
# start-up
# ---------------------------------------------------------------------------
def bootstrap():
    dbm.set_clock(now)
    dbm.init_db()
    dbm.seed_demo(now())
    p = predictor()
    p.ensure_ready(log=lambda m: print(m, flush=True))
    if not dbm.model_runs(1):
        dbm.save_model_run(p.summary())


bootstrap()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"\n  AI Campus Digital Twin is running ->  http://127.0.0.1:{port}\n")
    # use_reloader=False: the ML models are trained once at start-up, we do not want two copies
    app.run(host="127.0.0.1", port=port, debug=os.environ.get("FLASK_DEBUG") == "1", use_reloader=False)

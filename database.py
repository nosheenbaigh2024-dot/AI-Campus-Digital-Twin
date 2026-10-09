"""
database.py  -  SQLite storage for the AI Campus Digital Twin
==============================================================
Tables
  users        accounts (students + admins), hashed passwords
  reports      student crowd check-ins ("the Mess feels Busy right now")
  events       admin-created campus events that feed the ML model
  alerts       per-user smart alert rules (drop below / rise above X %)
  favorites    facilities a user has pinned
  model_runs   history of ML training runs (metrics per facility)
  activity_log audit trail of important actions
The file campus.db is created automatically the first time the app starts.
"""
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta

from werkzeug.security import check_password_hash, generate_password_hash

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "campus.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
    department    TEXT    NOT NULL DEFAULT 'General',
    year          INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL,
    last_login    TEXT
);
CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    facility   TEXT    NOT NULL,
    level      INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
    note       TEXT    DEFAULT '',
    created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_time ON reports (created_at);
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    facility   TEXT    NOT NULL,
    event_date TEXT    NOT NULL,
    start_hour INTEGER NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
    end_hour   INTEGER NOT NULL CHECK (end_hour BETWEEN 1 AND 24),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    facility       TEXT    NOT NULL,
    condition      TEXT    NOT NULL CHECK (condition IN ('below', 'above')),
    threshold      INTEGER NOT NULL CHECK (threshold BETWEEN 5 AND 100),
    lookahead      INTEGER NOT NULL DEFAULT 0 CHECK (lookahead BETWEEN 0 AND 6),
    active         INTEGER NOT NULL DEFAULT 1,
    last_triggered TEXT,
    created_at     TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    facility TEXT    NOT NULL,
    PRIMARY KEY (user_id, facility)
);
CREATE TABLE IF NOT EXISTS model_runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    trained_at TEXT NOT NULL,
    rows       INTEGER NOT NULL,
    summary    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    detail     TEXT DEFAULT '',
    created_at TEXT NOT NULL
);
"""


_clock = datetime.now          # app.py swaps this for its own clock so a demo time (CAMPUS_NOW) is respected


def set_clock(fn):
    global _clock
    _clock = fn


def _now() -> str:
    return _clock().isoformat(timespec="seconds")


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def rows(sql, args=()):
    with db() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def one(sql, args=()):
    with db() as c:
        r = c.execute(sql, args).fetchone()
        return dict(r) if r else None


def init_db():
    with db() as c:
        c.executescript(SCHEMA)


# ------------------------------ users ---------------------------------------
def create_user(name, email, password, department="General", year=1, role="student"):
    with db() as c:
        cur = c.execute(
            "INSERT INTO users (name, email, password_hash, role, department, year, created_at) VALUES (?,?,?,?,?,?,?)",
            (name.strip(), email.strip().lower(), generate_password_hash(password), role, department, int(year), _now()))
        return cur.lastrowid


def get_user_by_email(email):
    return one("SELECT * FROM users WHERE email = ?", (email.strip().lower(),))


def get_user(uid):
    return one("SELECT id, name, email, role, department, year, created_at, last_login FROM users WHERE id = ?", (uid,))


def verify_login(email, password):
    u = get_user_by_email(email)
    if u and check_password_hash(u["password_hash"], password):
        with db() as c:
            c.execute("UPDATE users SET last_login = ? WHERE id = ?", (_now(), u["id"]))
        return u
    return None


def list_users():
    return rows("SELECT id, name, email, role, department, year, created_at, last_login FROM users ORDER BY id DESC")


def count_users():
    return one("SELECT COUNT(*) AS n FROM users")["n"]


# ------------------------------ reports -------------------------------------
def add_report(user_id, facility, level, note=""):
    with db() as c:
        c.execute("INSERT INTO reports (user_id, facility, level, note, created_at) VALUES (?,?,?,?,?)",
                  (user_id, facility, level, note[:140], _now()))


def last_report_time(user_id, facility):
    r = one("SELECT created_at FROM reports WHERE user_id = ? AND facility = ? ORDER BY id DESC LIMIT 1", (user_id, facility))
    return datetime.fromisoformat(r["created_at"]) if r else None


def recent_reports(now, minutes=60):
    """Reports in the last `minutes`, with their age in minutes."""
    since = (now - timedelta(minutes=minutes)).isoformat(timespec="seconds")
    out = rows("SELECT facility, level, created_at FROM reports WHERE created_at >= ?", (since,))
    for r in out:
        r["age_min"] = max(0.0, (now - datetime.fromisoformat(r["created_at"])).total_seconds() / 60)
    return out


def reports_feed(now, limit=15):
    out = rows("""SELECT r.id, r.facility, r.level, r.note, r.created_at, u.department, u.year, u.name
                  FROM reports r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT ?""", (limit,))
    for r in out:
        t = datetime.fromisoformat(r["created_at"])
        r["age_min"] = max(0, int((now - t).total_seconds() // 60))
        r["who"] = f"{r.pop('name').split()[0]} · {r['department']} Y{r['year']}"   # first name only (privacy)
    return out


def count_reports_since(hours=24):
    since = (_clock() - timedelta(hours=hours)).isoformat(timespec="seconds")
    return one("SELECT COUNT(*) AS n FROM reports WHERE created_at >= ?", (since,))["n"]


# ------------------------------ events --------------------------------------
def add_event(title, facility, event_date, start_hour, end_hour, user_id):
    with db() as c:
        cur = c.execute("INSERT INTO events (title, facility, event_date, start_hour, end_hour, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
                        (title.strip(), facility, event_date, start_hour, end_hour, user_id, _now()))
        return cur.lastrowid


def delete_event(event_id):
    with db() as c:
        c.execute("DELETE FROM events WHERE id = ?", (event_id,))


def list_events(from_date=None):
    if from_date:
        return rows("SELECT * FROM events WHERE event_date >= ? ORDER BY event_date, start_hour", (from_date,))
    return rows("SELECT * FROM events ORDER BY event_date DESC, start_hour")


def event_hours_for(iso_date):
    """{facility: set(hours)} for one date - used as the 'event' feature of the ML model."""
    out = {}
    for e in rows("SELECT facility, start_hour, end_hour FROM events WHERE event_date = ?", (iso_date,)):
        out.setdefault(e["facility"], set()).update(range(e["start_hour"], e["end_hour"]))
    return out


# ------------------------------ alerts / favorites ----------------------------
def add_alert(user_id, facility, condition, threshold, lookahead):
    with db() as c:
        cur = c.execute("INSERT INTO alerts (user_id, facility, condition, threshold, lookahead, created_at) VALUES (?,?,?,?,?,?)",
                        (user_id, facility, condition, threshold, lookahead, _now()))
        return cur.lastrowid


def list_alerts(user_id):
    return rows("SELECT * FROM alerts WHERE user_id = ? ORDER BY id DESC", (user_id,))


def delete_alert(user_id, alert_id):
    with db() as c:
        c.execute("DELETE FROM alerts WHERE id = ? AND user_id = ?", (alert_id, user_id))


def set_alert_active(user_id, alert_id, active):
    with db() as c:
        c.execute("UPDATE alerts SET active = ? WHERE id = ? AND user_id = ?", (1 if active else 0, alert_id, user_id))


def mark_alert_triggered(alert_id, when):
    with db() as c:
        c.execute("UPDATE alerts SET last_triggered = ? WHERE id = ?", (when, alert_id))


def count_active_alerts():
    return one("SELECT COUNT(*) AS n FROM alerts WHERE active = 1")["n"]


def toggle_favorite(user_id, facility):
    with db() as c:
        cur = c.execute("DELETE FROM favorites WHERE user_id = ? AND facility = ?", (user_id, facility))
        if cur.rowcount == 0:
            c.execute("INSERT INTO favorites (user_id, facility) VALUES (?,?)", (user_id, facility))
            return True
        return False


def list_favorites(user_id):
    return [r["facility"] for r in rows("SELECT facility FROM favorites WHERE user_id = ?", (user_id,))]


# ------------------------------ model runs / log -----------------------------
def save_model_run(summary: dict):
    with db() as c:
        c.execute("INSERT INTO model_runs (trained_at, rows, summary) VALUES (?,?,?)",
                  (summary["trained_at"], summary["rows"], json.dumps({k: v["metrics"][v["best"]] | {"model": v["best_label"]}
                                                                        for k, v in summary["facilities"].items()})))


def model_runs(limit=5):
    out = rows("SELECT * FROM model_runs ORDER BY id DESC LIMIT ?", (limit,))
    for r in out:
        r["summary"] = json.loads(r["summary"])
    return out


def log_action(user_id, action, detail=""):
    with db() as c:
        c.execute("INSERT INTO activity_log (user_id, action, detail, created_at) VALUES (?,?,?,?)",
                  (user_id, action, detail[:200], _now()))


def recent_logs(limit=12):
    return rows("""SELECT l.action, l.detail, l.created_at, COALESCE(u.name, 'system') AS who
                   FROM activity_log l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT ?""", (limit,))


# ------------------------------ demo data -----------------------------------
def seed_demo(now=None):
    """Create a demo admin + student and a few crowd reports so the UI is not empty on first run."""
    if count_users() > 0:
        return
    now = now or datetime.now()
    admin = create_user("Campus Admin", "admin@campus.edu", "Admin@123", "Administration", 4, role="admin")
    stu = create_user("Aarav Menon", "student@campus.edu", "Student@123", "CSE", 3)
    others = [create_user(n, f"{n.split()[0].lower()}@campus.edu", "Student@123", d, y)
              for n, d, y in [("Diya Nair", "ECE", 2), ("Rohan Iyer", "MECH", 4), ("Sana Khan", "IT", 1), ("Kavin Raj", "CSE", 2)]]
    seeds = [(others[0], "mess", 3, "Long queue at counter 2", 4), (others[1], "library", 4, "No seats on floor 2", 7),
             (others[2], "gym", 2, "Free weights are open", 11), (others[3], "parking", 4, "Lot A is completely full", 14),
             (others[1], "cafe", 2, "", 19), (others[0], "labs", 1, "Empty, good time for lab 3", 26)]
    with db() as c:
        for uid, fac, lvl, note, ago in seeds:
            t = (now - timedelta(minutes=ago)).isoformat(timespec="seconds")
            c.execute("INSERT INTO reports (user_id, facility, level, note, created_at) VALUES (?,?,?,?,?)", (uid, fac, lvl, note, t))
        c.execute("INSERT INTO favorites (user_id, facility) VALUES (?, 'library'), (?, 'gym')", (stu, stu))
        c.execute("INSERT INTO alerts (user_id, facility, condition, threshold, lookahead, created_at) VALUES (?,?,?,?,?,?)",
                  (stu, "gym", "below", 30, 3, _now()))
        c.execute("INSERT INTO alerts (user_id, facility, condition, threshold, lookahead, created_at) VALUES (?,?,?,?,?,?)",
                  (stu, "mess", "below", 40, 2, _now()))
    log_action(admin, "seed", "Demo accounts created")


if __name__ == "__main__":
    init_db()
    seed_demo()
    print("database ready:", DB_PATH, "| users:", count_users())

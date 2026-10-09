"""
prediction.py  -  Machine-learning core of the AI Campus Digital Twin
=====================================================================

What this module does
---------------------
1. generate_dataset()  Builds data/campus_data.csv, a year-long hourly history of
                       how full each campus facility was (simulated from realistic
                       behaviour patterns: meal times, exam weeks, rain, events...).
                       Replace this CSV with real gate/Wi-Fi/turnstile logs and
                       the rest of the project works unchanged.
2. CampusPredictor     Trains THREE algorithms per facility (Ridge baseline,
                       Random Forest, Gradient Boosting), picks the best one on a
                       chronological hold-out set, and serves predictions with an
                       80 % confidence band.
3. best_window(), plan_day(), blend_live()
                       The "smart" layer: best time to visit, a multi-stop day
                       planner that minimises crowd exposure, and a live estimate
                       that blends the model with student crowd reports.

Run it directly for a quick demo / viva:
    python data/prediction.py generate     # rebuild the CSV
    python data/prediction.py train        # train + print the metrics table
    python data/prediction.py predict library 2026-09-19
"""
from __future__ import annotations

import itertools
import math
import os
import random
import sys
import threading
from datetime import date, datetime, timedelta
from functools import lru_cache

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(BASE_DIR, "campus_data.csv")
MODEL_PATH = os.path.join(BASE_DIR, "model_cache.joblib")
MODEL_VERSION = 4

# --------------------------------------------------------------------------
# 1. Campus configuration (the "digital twin" definition)
# --------------------------------------------------------------------------
# open: list of (start_hour, end_hour) windows. end is exclusive.
FACILITIES = {
    "library": dict(name="Central Library", short="Library", capacity=1200, open=[(8, 24)],
                    staff_role="desk staff", staff_per=300, action="Open the 24x7 reading room and extend desk hours"),
    "labs":    dict(name="Computer Labs", short="Labs", capacity=320, open=[(8, 22)],
                    staff_role="lab assistants", staff_per=60, action="Unlock overflow lab 3 and pause system updates"),
    "mess":    dict(name="Mess Hall", short="Mess", capacity=900, open=[(7, 10), (12, 15), (19, 22)],
                    staff_role="serving counters", staff_per=120, action="Open the extra serving counters and stagger batches"),
    "cafe":    dict(name="Food Court", short="Food Court", capacity=350, open=[(8, 23)],
                    staff_role="counters", staff_per=70, action="Add a counter and pre-stock beverages"),
    "gym":     dict(name="Fitness Centre", short="Gym", capacity=180, open=[(5, 22)],
                    staff_role="trainers on floor", staff_per=45, action="Cap the session length and open the outdoor zone"),
    "ground":  dict(name="Sports Ground", short="Ground", capacity=400, open=[(5, 20)],
                    staff_role="coordinators", staff_per=100, action="Split fields between teams and open Court B"),
    "parking": dict(name="Parking Lot A", short="Parking", capacity=650, open=[(0, 24)],
                    staff_role="marshals", staff_per=200, action="Open overflow Lot B and redirect visitors"),
}
FACILITY_ORDER = ["library", "labs", "mess", "cafe", "gym", "ground", "parking"]

LEVELS = [(0, 30, "Quiet"), (30, 55, "Moderate"), (55, 80, "Busy"), (80, 1000, "Packed")]
REPORT_LEVEL_PCT = {1: 15.0, 2: 42.0, 3: 68.0, 4: 92.0}   # what a student report "means" in %

FEATURES = ["hour", "dow", "weekend", "exam", "holiday", "vacation", "event",
            "temp", "rain", "hour_sin", "hour_cos", "dow_sin", "dow_cos"]
FEATURE_LABELS = {
    "hour": "Hour of day", "dow": "Day of week", "weekend": "Weekend", "exam": "Exam week",
    "holiday": "Public holiday", "vacation": "Vacation", "event": "Campus event",
    "temp": "Temperature", "rain": "Rain", "hour_sin": "Hour (cycle sin)", "hour_cos": "Hour (cycle cos)",
    "dow_sin": "Weekday (cycle sin)", "dow_cos": "Weekday (cycle cos)",
}


def level_of(pct: float) -> int:
    """1 = Quiet ... 4 = Packed"""
    for i, (lo, hi, _) in enumerate(LEVELS, start=1):
        if lo <= pct < hi:
            return i
    return 4


def level_name(pct: float) -> str:
    return LEVELS[level_of(pct) - 1][2]


def open_hours(fac: str) -> list[bool]:
    wins = FACILITIES[fac]["open"]
    return [any(a <= h < b for a, b in wins) for h in range(24)]


# --------------------------------------------------------------------------
# 2. Academic calendar + simulated weather (deterministic, works for any date)
# --------------------------------------------------------------------------
EXAM_WINDOWS = [((2, 9), (2, 20)), ((4, 20), (5, 8)), ((9, 14), (9, 25)), ((11, 16), (12, 4))]
VACATION_WINDOWS = [((5, 9), (6, 22)), ((12, 5), (12, 31)), ((1, 1), (1, 4))]
HOLIDAYS = {(1, 1): "New Year", (1, 26): "Republic Day", (8, 15): "Independence Day",
            (10, 2): "Gandhi Jayanti", (12, 25): "Christmas"}
MONTH_TEMP = [26, 28, 31, 34, 36, 34, 32, 31, 31, 29, 27, 26]                   # mean daily temp, C
MONTH_RAIN = [.02, .02, .04, .08, .10, .18, .22, .24, .28, .40, .42, .20]       # P(rainy day)


def _in_window(d: date, windows) -> bool:
    md = (d.month, d.day)
    return any(a <= md <= b for a, b in windows)


def academic_context(d: date) -> dict:
    exam = _in_window(d, EXAM_WINDOWS)
    vacation = _in_window(d, VACATION_WINDOWS)
    holiday = (d.month, d.day) in HOLIDAYS
    weekend = d.weekday() >= 5
    if holiday:
        label = HOLIDAYS[(d.month, d.day)]
    elif vacation:
        label = "Vacation"
    elif exam:
        label = "Exam week"
    elif weekend:
        label = "Weekend"
    else:
        label = "Regular teaching day"
    return dict(exam=exam, vacation=vacation, holiday=holiday, weekend=weekend, label=label)


def sim_weather(d: date) -> dict:
    """Deterministic pseudo-weather. Swap for a real API (e.g. OpenWeather) in production."""
    rng = random.Random(d.toordinal() * 7919 + 11)
    base = MONTH_TEMP[d.month - 1] + rng.gauss(0, 1.6)
    rainy = rng.random() < MONTH_RAIN[d.month - 1]
    start, length = rng.randint(6, 19), rng.choice([1, 2, 2, 3, 4, 5])
    temps, rain = [], []
    for h in range(24):
        raining = rainy and start <= h < start + length
        t = base + 4.2 * math.sin(2 * math.pi * (h - 9.5) / 24) - (3.5 if raining else 0)
        temps.append(round(t, 1))
        rain.append(1 if raining else 0)
    return dict(temp=temps, rain=rain, rainy_day=rainy)


# --------------------------------------------------------------------------
# 3. Behavioural simulator used to build the historical dataset
# --------------------------------------------------------------------------
def _B(h, mu, sigma):
    return math.exp(-0.5 * ((h - mu) / sigma) ** 2)


def _sig(x):
    return 1 / (1 + math.exp(-x))


def _parking_weekday(h):
    return 0.11 + 0.80 * (_sig((h - 8.0) / 0.55) - _sig((h - 17.0) / 0.9)) + 0.10 * _B(h, 19.5, 1.3)


def _parking_weekend(h):
    return 0.10 + 0.32 * (_sig((h - 9.5) / 1.0) - _sig((h - 19) / 1.3))


# each profile: base level, weekday bumps, weekend bumps (amp, centre-hour, width),
# multipliers for context, additive bumps for exam nights / events
PROFILES = {
    "library": dict(base=.08, wd=[(.42, 10.6, 1.7), (.50, 15.6, 2.0), (.38, 20.8, 2.1)],
                    we=[(.30, 11.5, 2.0), (.36, 16.0, 2.4), (.26, 20.8, 2.0)],
                    mult=dict(exam=1.50, holiday=.40, vacation=.22, rain=1.10, hot=1.06),
                    exam_add=[(.26, 22.3, 1.7)], event_add=.08),
    "labs": dict(base=.05, wd=[(.62, 11.0, 1.7), (.55, 15.2, 1.6), (.12, 20.0, 1.5)],
                 we=[(.16, 13.0, 3.0)],
                 mult=dict(exam=.80, holiday=.10, vacation=.10, rain=1.05, hot=1.0),
                 exam_add=[], event_add=.22),
    "mess": dict(base=.02, wd=[(.72, 8.2, .55), (.92, 13.1, .60), (.88, 20.2, .70)],
                 we=[(.52, 9.3, .80), (.82, 13.6, .75), (.78, 20.4, .70)],
                 mult=dict(exam=.96, holiday=.55, vacation=.15, rain=1.08, hot=1.0),
                 exam_add=[], event_add=.14),
    "cafe": dict(base=.06, wd=[(.36, 10.7, .9), (.44, 13.6, 1.0), (.62, 16.7, 1.1), (.44, 21.4, 1.3)],
                 we=[(.30, 11.0, 1.4), (.52, 17.0, 1.7), (.55, 21.5, 1.5)],
                 mult=dict(exam=1.15, holiday=.60, vacation=.20, rain=1.25, hot=1.10),
                 exam_add=[(.10, 23.0, 1.2)], event_add=.24),
    "gym": dict(base=.05, wd=[(.50, 6.5, 1.0), (.14, 12.6, 1.4), (.80, 18.1, 1.6)],
                we=[(.55, 9.2, 1.8), (.46, 17.6, 2.0)],
                mult=dict(exam=.75, holiday=.60, vacation=.35, rain=.88, hot=.90),
                exam_add=[], event_add=.10),
    "ground": dict(base=.03, wd=[(.42, 6.2, .8), (.80, 17.3, 1.15)],
                   we=[(.58, 7.0, 1.2), (.86, 17.0, 1.5)],
                   mult=dict(exam=.62, holiday=.70, vacation=.25, rain=.08, hot=.70),
                   exam_add=[], event_add=.38),
    "parking": dict(base=0, wd=_parking_weekday, we=_parking_weekend,
                    mult=dict(exam=1.10, holiday=.30, vacation=.25, rain=1.12, hot=1.0),
                    exam_add=[], event_add=.26),
}


def _demand(fac, h, ctx, event, temp, rain):
    p = PROFILES[fac]
    shape = p["we"] if ctx["weekend"] else p["wd"]
    f = shape(h + 0.5) if callable(shape) else p["base"] + sum(a * _B(h + 0.5, mu, s) for a, mu, s in shape)
    m = p["mult"]
    if ctx["exam"]: f *= m["exam"]
    if ctx["holiday"]: f *= m["holiday"]
    if ctx["vacation"]: f *= m["vacation"]
    if rain: f *= m["rain"]
    if temp >= 34: f *= m["hot"]
    if ctx["exam"]:
        f += sum(a * _B(h + 0.5, mu, s) for a, mu, s in p["exam_add"])
    if event:
        f += p["event_add"]
    return f


CSV_COLUMNS = ["timestamp", "facility", "date", "hour", "day_of_week", "is_weekend", "is_exam_week",
               "is_holiday", "is_vacation", "is_event", "temperature_c", "is_raining",
               "occupancy_pct", "headcount", "capacity"]


def generate_dataset(csv_path: str = CSV_PATH, start=date(2025, 11, 1), end=date(2026, 8, 31), seed: int = 42) -> int:
    """Simulate the hourly history. Closed hours are omitted (they are always 0)."""
    rng = random.Random(seed)
    rows = []
    d = start
    while d <= end:
        ctx = academic_context(d)
        wx = sim_weather(d)
        # 0-2 random campus events today (fests, matches, workshops, hackathons...)
        evs = []
        if not ctx["vacation"]:
            for prob in (0.34, 0.14):
                if rng.random() < prob:
                    evs.append((rng.choice(FACILITY_ORDER), rng.randint(14, 19), rng.randint(2, 4)))
        for fac in FACILITY_ORDER:
            day_factor = rng.lognormvariate(0, 0.07)
            ar = 0.0
            hours_open = open_hours(fac)
            for h in range(24):
                ar = 0.6 * ar + rng.gauss(0, 0.045)
                if not hours_open[h]:
                    continue
                event = 1 if any(e[0] == fac and e[1] <= h < e[1] + e[2] for e in evs) else 0
                f = _demand(fac, h, ctx, event, wx["temp"][h], wx["rain"][h])
                f = f * day_factor * (1 + ar) + rng.gauss(0, 0.012)
                f = min(1.0, max(0.0, f))
                cap = FACILITIES[fac]["capacity"]
                rows.append([f"{d.isoformat()} {h:02d}:00", fac, d.isoformat(), h, d.weekday(),
                             int(ctx["weekend"]), int(ctx["exam"]), int(ctx["holiday"]), int(ctx["vacation"]),
                             event, wx["temp"][h], wx["rain"][h], round(f * 100, 1), int(round(f * cap)), cap])
        d += timedelta(days=1)
    df = pd.DataFrame(rows, columns=CSV_COLUMNS)
    os.makedirs(os.path.dirname(csv_path), exist_ok=True)
    df.to_csv(csv_path, index=False)
    return len(df)


def dataset_usable(csv_path: str = CSV_PATH) -> bool:
    """True if the CSV exists, has every expected column and enough rows to train on."""
    try:
        with open(csv_path, encoding="utf-8") as fh:
            header = fh.readline().strip().split(",")
            rows = sum(1 for _ in fh)
    except OSError:
        return False
    return all(c in header for c in CSV_COLUMNS) and rows >= 500


def ensure_dataset(csv_path: str = CSV_PATH, log=print) -> bool:
    """Make sure a usable campus_data.csv exists. Returns True if it had to be (re)generated.
    An empty file is simply replaced. A file in the wrong format is kept as campus_data.csv.bak first."""
    if dataset_usable(csv_path):
        return False
    if os.path.exists(csv_path) and os.path.getsize(csv_path) > 0:
        backup = csv_path + ".bak"
        os.replace(csv_path, backup)
        log(f"[data] campus_data.csv is not in the expected format -> kept your file as {os.path.basename(backup)}")
    log("[data] generating a fresh campus_data.csv")
    generate_dataset(csv_path)
    return True


# --------------------------------------------------------------------------
# 4. Feature engineering + model training
# --------------------------------------------------------------------------
def _add_cyclic(df: pd.DataFrame) -> pd.DataFrame:
    df["hour_sin"] = np.sin(2 * np.pi * df["hour"] / 24)
    df["hour_cos"] = np.cos(2 * np.pi * df["hour"] / 24)
    df["dow_sin"] = np.sin(2 * np.pi * df["dow"] / 7)
    df["dow_cos"] = np.cos(2 * np.pi * df["dow"] / 7)
    return df


def load_training_frame(csv_path: str = CSV_PATH) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df = df.rename(columns={"day_of_week": "dow", "is_weekend": "weekend", "is_exam_week": "exam",
                            "is_holiday": "holiday", "is_vacation": "vacation", "is_event": "event",
                            "temperature_c": "temp", "is_raining": "rain"})
    return _add_cyclic(df)


def _candidates():
    return {
        "linear": ("Ridge regression (baseline)",
                   lambda: make_pipeline(StandardScaler(), Ridge(alpha=1.0))),
        "random_forest": ("Random Forest",
                          lambda: RandomForestRegressor(n_estimators=160, min_samples_leaf=2, n_jobs=-1, random_state=42)),
        "gradient_boosting": ("Gradient Boosting",
                              lambda: GradientBoostingRegressor(n_estimators=260, learning_rate=0.06, max_depth=4,
                                                                subsample=0.9, random_state=42)),
    }


def _metrics(y, p):
    return dict(mae=round(float(mean_absolute_error(y, p)), 2),
                rmse=round(float(math.sqrt(mean_squared_error(y, p))), 2),
                r2=round(float(r2_score(y, p)), 3))


def _importance(model) -> list[dict]:
    est = model.steps[-1][1] if hasattr(model, "steps") else model
    if hasattr(est, "feature_importances_"):
        vals = np.asarray(est.feature_importances_, dtype=float)
    else:
        vals = np.abs(np.asarray(est.coef_, dtype=float))
    vals = vals / (vals.sum() or 1)
    out = [dict(feature=f, label=FEATURE_LABELS[f], value=round(float(v), 4)) for f, v in zip(FEATURES, vals)]
    return sorted(out, key=lambda r: -r["value"])


def train_all(csv_path: str = CSV_PATH, holdout_days: int = 28, progress=None) -> dict:
    """Train every candidate for every facility. Returns the model bundle."""
    df = load_training_frame(csv_path)
    df["date"] = pd.to_datetime(df["date"])
    cutoff = df["date"].max() - pd.Timedelta(days=holdout_days - 1)
    bundle = dict(version=MODEL_VERSION, sklearn=sklearn.__version__,
                  trained_at=datetime.now().isoformat(timespec="seconds"),
                  rows=int(len(df)), date_from=df["date"].min().date().isoformat(),
                  date_to=df["date"].max().date().isoformat(), holdout_days=holdout_days,
                  features=FEATURES, facilities={})
    for fac in FACILITY_ORDER:
        sub = df[df["facility"] == fac].sort_values("timestamp")
        train, test = sub[sub["date"] < cutoff], sub[sub["date"] >= cutoff]
        X_tr, y_tr, X_te, y_te = train[FEATURES], train["occupancy_pct"], test[FEATURES], test["occupancy_pct"]
        results, best_key, best_mae, best_pred = {}, None, 1e9, None
        for key, (label, make) in _candidates().items():
            m = make().fit(X_tr, y_tr)
            pred = np.clip(m.predict(X_te), 0, 100)
            met = _metrics(y_te, pred)
            met["label"] = label
            results[key] = met
            if met["mae"] < best_mae:
                best_key, best_mae, best_pred = key, met["mae"], pred
        # residual spread per hour -> confidence band
        resid = pd.DataFrame(dict(hour=test["hour"].values, r=y_te.values - best_pred))
        overall = float(resid["r"].std() or 4.0)
        sig = [float(resid[resid.hour == h]["r"].std()) if (resid.hour == h).sum() > 5 else overall for h in range(24)]
        sig = [max(2.5, s if s == s else overall) for s in sig]
        # refit best model on ALL data for serving
        final = _candidates()[best_key][1]().fit(sub[FEATURES], sub["occupancy_pct"])
        if hasattr(final, "set_params") and best_key == "random_forest":
            final.set_params(n_jobs=1)
        step = max(1, len(test) // 160)
        bundle["facilities"][fac] = dict(
            model=final, best=best_key, best_label=results[best_key]["label"], metrics=results,
            sigma=sig, importance=_importance(final), n_train=int(len(train)), n_test=int(len(test)),
            holdout=dict(ts=test["timestamp"].values[::step].tolist(),
                         actual=[round(float(v), 1) for v in y_te.values[::step]],
                         pred=[round(float(v), 1) for v in best_pred[::step]]))
        if progress:
            progress(fac, best_key, results[best_key])
    return bundle


# --------------------------------------------------------------------------
# 5. Predictor service
# --------------------------------------------------------------------------
class CampusPredictor:
    def __init__(self, csv_path: str = CSV_PATH, model_path: str = MODEL_PATH):
        self.csv_path, self.model_path = csv_path, model_path
        self.bundle: dict | None = None
        self._lock = threading.Lock()

    # ---- lifecycle -------------------------------------------------------
    def ensure_ready(self, force: bool = False, log=print) -> None:
        with self._lock:
            if self.bundle is not None and not force:
                return
            if not force and os.path.exists(self.model_path):
                try:
                    b = joblib.load(self.model_path)
                    if b.get("version") == MODEL_VERSION and b.get("sklearn") == sklearn.__version__:
                        self.bundle = b
                        return
                    log("[model] cache is from a different version -> retraining")
                except Exception as exc:                                  # corrupted / incompatible cache
                    log(f"[model] could not load cache ({exc}) -> retraining")
            ensure_dataset(self.csv_path, log)
            log("[model] training models (first run only, ~20-40 s)...")
            self.bundle = train_all(self.csv_path, progress=lambda f, k, m: log(f"        {f:<8} best={k:<18} MAE={m['mae']}  R2={m['r2']}"))
            joblib.dump(self.bundle, self.model_path)
            self._cached_day.cache_clear()

    def retrain(self, log=print) -> dict:
        self.ensure_ready(force=True, log=log)
        return self.summary()

    # ---- feature builder + prediction ---------------------------------
    def _frame(self, d: date, ov: dict, ev_hours: frozenset) -> pd.DataFrame:
        ctx, wx = academic_context(d), sim_weather(d)
        exam = ctx["exam"] if ov.get("exam") is None else bool(ov["exam"])
        holiday = ctx["holiday"] if ov.get("holiday") is None else bool(ov["holiday"])
        vacation = ctx["vacation"] if ov.get("vacation") is None else bool(ov["vacation"])
        dow, weekend = d.weekday(), ctx["weekend"]
        if ov.get("daytype") == "weekend" and not weekend:
            dow, weekend = 5, True            # only change the day if it is not already a weekend
        elif ov.get("daytype") == "weekday" and weekend:
            dow, weekend = 2, False           # ...or already a weekday (keeps the real day-of-week otherwise)
        temps = list(wx["temp"])
        if ov.get("temp") is not None:
            shift = float(ov["temp"]) - max(temps)
            temps = [round(t + shift, 1) for t in temps]
        rain = [1] * 24 if ov.get("rain") is True else [0] * 24 if ov.get("rain") is False else list(wx["rain"])
        rows = []
        for h in range(24):
            rows.append([h, dow, int(weekend), int(exam), int(holiday), int(vacation),
                         int(h in ev_hours), temps[h], rain[h]])
        df = pd.DataFrame(rows, columns=["hour", "dow", "weekend", "exam", "holiday", "vacation", "event", "temp", "rain"])
        return _add_cyclic(df)[FEATURES]

    @lru_cache(maxsize=1024)
    def _cached_day(self, fac: str, iso: str, ov_key: tuple, ev_hours: frozenset) -> tuple:
        d = date.fromisoformat(iso)
        ov = dict(ov_key)
        X = self._frame(d, ov, ev_hours)
        f = self.bundle["facilities"][fac]
        raw = np.clip(f["model"].predict(X), 0, 100)
        opn = open_hours(fac)
        cap = FACILITIES[fac]["capacity"]
        pct, lo, hi, hc = [], [], [], []
        for h in range(24):
            if not opn[h]:
                pct.append(0.0); lo.append(0.0); hi.append(0.0); hc.append(0)
                continue
            p, s = float(raw[h]), f["sigma"][h] * 1.28
            pct.append(round(p, 1)); lo.append(round(max(0, p - s), 1)); hi.append(round(min(100, p + s), 1))
            hc.append(int(round(p / 100 * cap)))
        return tuple(pct), tuple(lo), tuple(hi), tuple(hc)

    def predict_day(self, fac: str, d: date, overrides: dict | None = None, event_hours=()) -> dict:
        """24 hourly predictions for one facility on one date."""
        self.ensure_ready()
        ov = {k: v for k, v in (overrides or {}).items() if v is not None and k != "event"}
        pct, lo, hi, hc = self._cached_day(fac, d.isoformat(), tuple(sorted(ov.items())), frozenset(event_hours))
        return dict(pct=list(pct), lo=list(lo), hi=list(hi), hc=list(hc), open=open_hours(fac))

    # ---- info ---------------------------------------------------------------
    def summary(self) -> dict:
        self.ensure_ready()
        b = self.bundle
        return dict(trained_at=b["trained_at"], rows=b["rows"], date_from=b["date_from"], date_to=b["date_to"],
                    holdout_days=b["holdout_days"], sklearn=b["sklearn"],
                    features=[dict(key=f, label=FEATURE_LABELS[f]) for f in FEATURES],
                    facilities={fac: dict(best=v["best"], best_label=v["best_label"], metrics=v["metrics"],
                                          importance=v["importance"][:8], holdout=v["holdout"],
                                          n_train=v["n_train"], n_test=v["n_test"])
                                for fac, v in b["facilities"].items()})


# --------------------------------------------------------------------------
# 6. The "smart" layer
# --------------------------------------------------------------------------
def best_window(pct: list, opn: list, length: int = 1, lo: int = 7, hi: int = 22) -> dict | None:
    """Quietest run of `length` consecutive open hours, looking only at waking hours (default 07:00-22:00)
    so we never recommend "go to the parking lot at 2 am"."""
    best = None
    for s in range(lo, hi - length + 1):
        span = range(s, s + length)
        if not all(opn[h] for h in span):
            continue
        avg = sum(pct[h] for h in span) / length
        if best is None or avg < best["pct"] - 1e-9:
            best = dict(start=s, end=s + length, pct=round(avg, 1))
    return best


def peak_hour(pct: list, opn: list) -> dict | None:
    cand = [(pct[h], h) for h in range(24) if opn[h]]
    if not cand:
        return None
    v, h = max(cand)
    return dict(hour=h, pct=round(v, 1))


def next_good_window(pct: list, opn: list, now_hour: int, threshold: float = 45.0) -> dict | None:
    """First upcoming hour (>= now) that is open and below threshold."""
    for h in range(now_hour, 24):
        if opn[h] and pct[h] < threshold:
            return dict(hour=h, pct=pct[h])
    return None


def campus_pulse(values: list[float]) -> dict:
    if not values:
        return dict(value=0, label="Closed")
    v = sum(values) / len(values)
    label = "Calm" if v < 35 else "Steady" if v < 55 else "Stretched" if v < 75 else "Overloaded"
    return dict(value=round(v, 1), label=label)


def blend_live(model_pct: float, reports: list[dict]) -> dict:
    """Blend model estimate with recent student reports (age_min, level 1-4)."""
    if not reports:
        return dict(pct=round(model_pct, 1), n=0, source="model", weight=0.0)
    ws = [math.exp(-r["age_min"] / 25.0) for r in reports]
    if sum(ws) < 0.05:
        return dict(pct=round(model_pct, 1), n=0, source="model", weight=0.0)
    rep_avg = sum(w * REPORT_LEVEL_PCT[r["level"]] for w, r in zip(ws, reports)) / sum(ws)
    weight = min(0.65, 0.22 * sum(ws))
    return dict(pct=round((1 - weight) * model_pct + weight * rep_avg, 1), n=len(reports),
                source="model + reports", weight=round(weight, 2), report_avg=round(rep_avg, 1))


def staffing(fac: str, headcount: int) -> int:
    per = FACILITIES[fac]["staff_per"]
    return max(1, math.ceil(headcount / per))


# ---- multi-stop day planner (dynamic programming over 15-minute slots) ------
def _hhmm(slot: int) -> str:
    m = slot * 15
    return f"{m // 60:02d}:{m % 60:02d}"


def plan_day(day_pct: dict, activities: list[dict], start_min: int, end_min: int, buffer_min: int = 15) -> dict:
    """
    day_pct   {facility: {'pct': [24], 'open': [24]}}
    activities [{'facility': 'gym', 'minutes': 60}, ...]   (max 5)
    Finds the visiting order + start times that minimise the *average crowd level
    you are exposed to*, subject to opening hours, the time window and a travel buffer.
    """
    S = 96
    s0, s1 = math.ceil(start_min / 15), math.floor(end_min / 15)
    buf = math.ceil(buffer_min / 15)
    acts = [dict(facility=a["facility"], slots=max(1, math.ceil(a["minutes"] / 15)), minutes=a["minutes"]) for a in activities]
    INF = float("inf")

    def cost_table(a):
        pct, opn = day_pct[a["facility"]]["pct"], day_pct[a["facility"]]["open"]
        n, table = a["slots"], [INF] * (S + 1)
        for s in range(s0, s1 - n + 1):
            hrs = [(s + k) // 4 for k in range(n)]
            if all(opn[h] for h in hrs):
                table[s] = sum(pct[h] for h in hrs) / n
        return table

    tables = {i: cost_table(a) for i, a in enumerate(acts)}

    def best_for_order(order):
        k = len(order)
        F = [[INF] * (S + 2) for _ in range(k + 1)]
        choice = [[None] * (S + 2) for _ in range(k)]
        for e in range(S + 2):
            F[k][e] = 0.0
        for i in range(k - 1, -1, -1):
            a = acts[order[i]]
            tab = tables[order[i]]
            for e in range(S, -1, -1):
                skip = F[i][e + 1] if e + 1 <= S + 1 else INF
                nxt = min(S + 1, e + a["slots"] + buf)
                take = tab[e] * a["slots"] + F[i + 1][nxt] if tab[e] < INF else INF
                if take <= skip:
                    F[i][e], choice[i][e] = take, ("take", e)
                else:
                    F[i][e], choice[i][e] = skip, ("skip", e + 1)
        total = F[0][s0]
        if total == INF:
            return None
        starts, e, i = [], s0, 0
        while i < k:
            kind, val = choice[i][e]
            if kind == "skip":
                e = val
            else:
                a = acts[order[i]]
                starts.append(e)
                e = min(S + 1, e + a["slots"] + buf)
                i += 1
        return total, starts

    def render(order, starts):
        items, weighted = [], 0.0
        total_slots = sum(acts[j]["slots"] for j in order)
        for j, s in zip(order, starts):
            a = acts[j]
            hrs = [(s + q) // 4 for q in range(a["slots"])]
            avg = sum(day_pct[a["facility"]]["pct"][h] for h in hrs) / a["slots"]
            weighted += avg * a["slots"]
            items.append(dict(facility=a["facility"], start=_hhmm(s), end=_hhmm(s + a["slots"]),
                              minutes=a["minutes"], avg_pct=round(avg, 1)))
        return dict(items=items, avg_pct=round(weighted / total_slots, 1))

    ranked = []
    for order in itertools.permutations(range(len(acts))):
        r = best_for_order(order)
        if r:
            ranked.append((r[0], order, r[1]))
    if not ranked:
        return dict(ok=False, message="No feasible plan: a facility is closed during your window or the window is too short.")
    ranked.sort(key=lambda x: x[0])
    plans = [render(o, s) for _, o, s in ranked[:3]]

    # naive plan: given order, as early as possible
    naive, e = [], s0
    feasible = True
    for a in acts:
        tab = cost_table(a)
        s = next((x for x in range(e, s1) if tab[x] < INF), None)
        if s is None:
            feasible = False
            break
        naive.append(s)
        e = s + a["slots"] + buf
    naive_plan = render(list(range(len(acts))), naive) if feasible else None
    gain = None
    if naive_plan and naive_plan["avg_pct"] > 0:
        gain = round(100 * (naive_plan["avg_pct"] - plans[0]["avg_pct"]) / naive_plan["avg_pct"], 1)
    return dict(ok=True, best=plans[0], alternatives=plans[1:], naive=naive_plan, improvement_pct=gain)


# --------------------------------------------------------------------------
# Singleton + CLI
# --------------------------------------------------------------------------
_predictor: CampusPredictor | None = None


def get_predictor() -> CampusPredictor:
    global _predictor
    if _predictor is None:
        _predictor = CampusPredictor()
    return _predictor


def _cli(argv):
    cmd = argv[1] if len(argv) > 1 else "train"
    if cmd == "generate":
        n = generate_dataset()
        print(f"wrote {n:,} rows -> {CSV_PATH}")
    elif cmd == "train":
        ensure_dataset(CSV_PATH)
        p = get_predictor()
        p.retrain()
        s = p.summary()
        print(f"\n{'facility':<10}{'model':<20}{'MAE':>6}{'RMSE':>7}{'R2':>7}   (baseline MAE)")
        for fac, v in s["facilities"].items():
            m = v["metrics"][v["best"]]
            print(f"{fac:<10}{v['best_label']:<20}{m['mae']:>6}{m['rmse']:>7}{m['r2']:>7}   ({v['metrics']['linear']['mae']})")
    elif cmd == "predict":
        fac = argv[2] if len(argv) > 2 else "library"
        d = date.fromisoformat(argv[3]) if len(argv) > 3 else date.today()
        r = get_predictor().predict_day(fac, d)
        print(f"{FACILITIES[fac]['name']} on {d} ({academic_context(d)['label']})")
        for h in range(24):
            if r["open"][h]:
                print(f"  {h:02d}:00  {r['pct'][h]:5.1f}%  {'#' * int(r['pct'][h] / 3):<34} {level_name(r['pct'][h])}")
    else:
        print(__doc__)


if __name__ == "__main__":
    _cli(sys.argv)

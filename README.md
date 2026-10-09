# AI Campus Digital Twin

A web app that models campus facilities (library, computer labs, mess, food court, gym, sports ground, parking)
as a live "digital twin" and uses machine learning to predict how crowded each one will be, hour by hour.

## Run it (Windows PowerShell)

```powershell
cd AI_Campus_Digital_Twin
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000 and keep the terminal open. If the browser says
"connection refused", the server is not running.

**First start takes about 30 seconds.** The app creates `campus.db`, generates `data/campus_data.csv`
if it is missing or empty, and trains the models (saved to `data/model_cache.joblib`).

On macOS/Linux use `source venv/bin/activate` instead of the Activate.ps1 line.

## Demo accounts (change before any real use)

| Role    | Email               | Password    |
|---------|---------------------|-------------|
| Student | student@campus.edu  | Student@123 |
| Admin   | admin@campus.edu    | Admin@123   |

## Demo clock

Show any moment (for example the lunch rush during exam week):

```powershell
$env:CAMPUS_NOW = "2026-09-21 13:10"
python app.py
```

## What is where

| File | Purpose |
|------|---------|
| `app.py` | Flask pages, login/register, CSRF, security headers, JSON API |
| `database.py` | SQLite schema (users, reports, events, alerts, favorites, model_runs, activity_log) |
| `data/prediction.py` | Data generator, 3 ML models per facility, prediction, best-time finder, day planner |
| `data/campus_data.csv` | Hourly occupancy history (simulated) |
| `templates/` | index, login, register, dashboard pages |
| `static/css/style.css` | The whole design system |
| `static/js/twin.js` | Draws the SVG campus map |
| `static/js/charts.js` | Line chart, heat-map, sparkline (no libraries) |
| `static/js/dashboard.js`, `views.js` | The eight dashboard views |
| `static/js/landing.js`, `auth.js` | Home page and login/register behaviour |

## Where is the dataset?

It is the file `data/campus_data.csv` (33,440 rows, about 2.8 MB). You do **not** need to paste anything into it.
Leave the file missing or empty and the app writes it on first start. If the file exists but has different
columns, it is kept as `campus_data.csv.bak` and a fresh one is generated. You can also create it yourself:

```powershell
python data/prediction.py generate
```

## About the data

`campus_data.csv` is **simulated** from realistic behaviour patterns (meal peaks, exam weeks, rain, events).
To use real data, replace it with a CSV using the same columns
(`timestamp, facility, date, hour, day_of_week, is_weekend, is_exam_week, is_holiday, is_vacation,
is_event, temperature_c, is_raining, occupancy_pct, headcount, capacity`), delete `data/model_cache.joblib`,
and restart. Weather is also simulated; `sim_weather()` in `prediction.py` is where a real weather API would plug in.

## Useful commands

```powershell
python data/prediction.py generate      # rebuild the CSV
python data/prediction.py train         # train and print the metrics table
python data/prediction.py predict library 2026-09-21
```

To reset all accounts and reports, stop the server and delete `campus.db`.

# Tank Reports — web dashboard

This document describes the **reporting** part of the repo: the static **Tank Reports** app (`index.html`, `app.js`, `styles.css`). It reflects the **current** behavior (including recent UI and analytics changes).

For ESP32 wiring and firmware, see [README.md](./README.md).

## What you run

| File | Role |
|------|------|
| `index.html` | Page shell, layout, Chart.js / Bootstrap includes |
| `app.js` | Data fetch, parsing, analytics, charts, `localStorage` |
| `styles.css` | Themes, layout for hero charts, KPI strip, cards |

No bundler or build step: open the folder via a **local static HTTP server** (recommended) or deploy the three files to any static host.

**Typography:** Plus Jakarta Sans (Google Fonts).

**Libraries:** Bootstrap 5.3, Chart.js 4.4 (UMD).

## Data source (Firebase only)

The app loads device data **only from the Firebase Realtime Database REST API**:

1. `GET <base>/devices.json?shallow=true` — list device IDs under `devices`.
2. For each selected device: `GET <base>/devices/<deviceId>.json` — full subtree (history, bootstrap, config, logs, errors, firmware, etc.).

`<base>` is the **REST root** (example: `https://waterlevelmonitor-95f66-default-rtdb.firebaseio.com`). It must **not** be the Firebase Console web page URL. The Admin panel explains this and links to the console data browser for convenience.

**JSON file import** is **not** present in the current code path; reporting is **Firebase-first**. If the browser cannot reach Firebase (network, CORS, or rules), startup still tries to recover using a **cached snapshot** (see below).

## Sync vs refresh

| Control | What it does |
|---------|----------------|
| **Sync devices from Firebase** (device card) | Same as Admin → **Fetch devices from Firebase**: saves the REST base to `localStorage`, re-downloads shallow device list and each device document, updates cache, repopulates dropdowns, then rebuilds the active report. |
| **Refresh report** | Rebuilds charts and KPIs from **whatever is already in memory** for the selected device/range/filters. Does **not** hit Firebase again. |
| Changing device, date range, threshold, smoothing, time window, or report mode | Triggers a **report refresh** (still using in-memory payload until you sync again). |

## Offline / failure behavior

On first load, the app calls `syncDevicesFromFirebase()`. If that throws:

- It looks for **`wtm_devices_cache`** in `localStorage` (full devices map from the last successful sync).
- If cache exists, it applies that map and sets status to something like: Firebase error — **showing last synced data from this browser**.
- If no cache, status prompts to check REST URL, network, and **RTDB read rules**.

Successful sync always writes the latest map to **`wtm_devices_cache`**.

## `localStorage` keys

| Key | Purpose |
|-----|---------|
| `wtm_firebase_base` | REST base URL |
| `wtm_device_allowlist` | Array of device ID strings (optional filter) |
| `wtm_selected_device` | Last selected device id |
| `wtm_theme` | `ocean` \| `aurora` \| `slate` \| `paper` |
| `wtm_devices_cache` | Last full devices JSON map from Firebase |

## Admin panel

- **Device allowlist** — One `device_…` ID per line. **Empty** allowlist means: use every device id returned from shallow `/devices`. **Save allowlist** reapplies filtering to the **already loaded** payload (does not fetch Firebase by itself).
- **Realtime Database REST root** — Editable URL; **Fetch devices from Firebase** runs sync with that value.

There is **no** Google Sign-In in the app today; access is whatever your **Realtime Database security rules** allow for unauthenticated REST reads from the browser.

## Device dropdown

Options are built from synced devices (after allowlist filter). Label text prefers **`bootstrap.tank_name`**, otherwise the raw device id.

When you **change device**, date selectors are rebuilt from that device’s `history` keys, and the **fill/change threshold** input is prefilled from `bootstrap.threshold` or `config.threshold` when present (fallback: current input / `2`).

## Report range

- **Single date** — One `dd-mm-yyyy` history file.
- **Last 7 days (known)** — Up to seven most recent history dates that exist on the device (sorted ascending for the merge).
- **Custom range** — From / to date chosen from the same list of known history keys (intersection only; firmware must have written those days).

**Day start / Day end** — Filters samples to a time-of-day window per day. If no sample falls inside the window, the code **synthesizes boundary points** by carrying the last known level before start and after end so charts still make sense.

## Filters

- **Fill / change threshold (%)** — Used in analytics for **counting discrete fill events** (a “fill event” when a positive step ≥ threshold starts after no active fill). Also passed into `analyze()` for summary semantics tied to fills.
- **Smoothing** — Raw, 3-point, or 5-point **moving average** overlaid on the **level** chart only (raw stepped series stays visible).

## Overview tab — layout (recent structure)

1. **Sparse-upload notice** (conditional) — When median gap > 5 min or max gap > 30 min, explains that long flat stretches are often **missing uploads when level is unchanged**, not failed hardware.
2. **KPI strip** — Horizontally scrollable chips (single card): range caption, time window, sample count, level now, water column now (cm), total consumed %, total filled %, median gap, max gap, biggest single-interval drop %, count of fills ≥ threshold.
3. **Hero chart** — One large chart area; **title updates** from the **Chart** dropdown (`Water level (%)`, `Distance…`, etc.). Only the selected chart type’s panel is visible.
4. **Largest water drops / Largest rises** — Two side-by-side **horizontal bar** charts: top **12** consumption steps and top **12** refill steps between consecutive samples. Tooltips add **from → to** timestamps and **cm** water column equivalent (uses tank height from `bootstrap.tank_height_cm` or `config.tank_height`, default **120**).
5. **Running totals** — **Cumulative** line chart: cumulative sum of all **drops** (consumed %) vs all **rises** (filled %) from first to last sample in the window.
6. **Key insights** — Bullet list generated from summary stats (range, latest reading, biggest step lines, sparse vs dense wording).

## Chart types (hero selector)

| Value | Chart |
|-------|--------|
| `level` | **Stepped** level % (holds between samples) + **smoothed** overlay line |
| `distance` | Stepped distance to surface (cm) |
| `rate` | **Bar** chart: % change per minute between consecutive points (color by sign) |
| `hourly` | 24 bars: sum of consumption % by **clock hour** of each drop |
| `gaps` | Bar chart: **minutes** between consecutive samples |
| `pie` | Doughnut: consumed vs filled vs **net stored** (clamped estimate) |

Chart colors follow **CSS variables** (`--chart-accent`, etc.) so they track the selected **theme**.

## Analytics model (how numbers are computed)

- History nodes are flattened with `normalizeDayData()`: each entry needs `timestamp`, `level_percent`, `water_height_cm`, `distance_cm` (matches firmware PATCH shape).
- **Gaps:** minutes between consecutive timestamps; median / max / average reported.
- **Consumption vs fill steps:** step delta between consecutive levels; small noise within **±0.02%** is ignored for the **events** lists (drops/rises for top-N charts).
- **Hourly consumption:** each negative step’s absolute % is added to the bucket for the **hour** of the later sample.
- **Cumulative series:** running sum of all negative step magnitudes (consumed) and positive steps (filled) for the cumulative chart.

## Other tabs

- **Device details** — Renders `bootstrap`, `config`, and pretty-printed `firmware` from the synced device object.
- **Logs** / **Errors** — Tables built from `logs` and `errors` objects (values sorted by time descending). Same shape as firmware PATCH logs.

## Firebase shape expected

The app expects each device document to include at least:

- `history`: object whose keys match **`dd-mm-yyyy`** and values are maps of time-key → `{ timestamp, level_percent, water_height_cm, distance_cm }` (as written by the ESP32 sketch).

Optional but used when present:

- `bootstrap` — `tank_name`, `tank_height_cm`, `threshold`, …
- `config` — overrides, e.g. `tank_height`, `threshold`
- `logs`, `errors`, `firmware`

## Themes

`data-theme` on `<html>`: **ocean** (default), **aurora**, **slate**, **paper**. Changing theme saves to `localStorage` and **refreshes** charts so colors re-read from CSS.

## Operational checklist

1. RTDB rules allow the reads you need from your deployment context.
2. Serve over **HTTPS/HTTP**, not `file://`, if the browser blocks `fetch`.
3. Use **Sync devices from Firebase** after changing the REST base or when you need fresh data.
4. Use **Refresh report** to recompute after tweaking filters without waiting on Firebase.

## Related firmware fields

- History date keys and payload fields must match what `normalizeDayData()` reads (`level_percent`, `distance_cm`, `timestamp`, etc.).
- `bootstrap.tank_height_cm` (or `config.tank_height`) drives **cm** translations in insights and tooltips.
- Upload sparsity (firmware threshold / upload logic) directly affects **gaps** and stepped charts; the UI is designed to make that visible rather than hiding it.

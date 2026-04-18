const DEFAULT_FIREBASE_BASE = "https://waterlevelmonitor-95f66-default-rtdb.firebaseio.com";
const DATE_KEY_REGEX = /^\d{2}-\d{2}-\d{4}$/;

const STORAGE = {
  allowlist: "wtm_device_allowlist",
  selectedDevice: "wtm_selected_device",
  firebaseBase: "wtm_firebase_base",
  theme: "wtm_theme",
  devicesCache: "wtm_devices_cache"
};

const refs = {
  themeSelect: document.getElementById("themeSelect"),
  deviceSelect: document.getElementById("deviceSelect"),
  syncDevicesBtn: document.getElementById("syncDevicesBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  reportMode: document.getElementById("reportMode"),
  dateSelect: document.getElementById("dateSelect"),
  fromDate: document.getElementById("fromDate"),
  toDate: document.getElementById("toDate"),
  changeThreshold: document.getElementById("changeThreshold"),
  windowSize: document.getElementById("windowSize"),
  startTime: document.getElementById("startTime"),
  endTime: document.getElementById("endTime"),
  chartType: document.getElementById("chartType"),
  kpiStrip: document.getElementById("kpiStrip"),
  heroChartHeading: document.getElementById("heroChartHeading"),
  insightList: document.getElementById("insightList"),
  statusText: document.getElementById("statusText"),
  sparseNote: document.getElementById("sparseNote"),
  allowlistInput: document.getElementById("allowlistInput"),
  saveAllowlistBtn: document.getElementById("saveAllowlistBtn"),
  firebaseBaseInput: document.getElementById("firebaseBaseInput"),
  fetchFirebaseBtn: document.getElementById("fetchFirebaseBtn"),
  bootstrapDl: document.getElementById("bootstrapDl"),
  configDl: document.getElementById("configDl"),
  firmwarePre: document.getElementById("firmwarePre"),
  logsBody: document.getElementById("logsBody"),
  errorsBody: document.getElementById("errorsBody"),
  panelLevel: document.getElementById("panel-level"),
  panelDistance: document.getElementById("panel-distance"),
  panelRate: document.getElementById("panel-rate"),
  panelHourly: document.getElementById("panel-hourly"),
  panelGaps: document.getElementById("panel-gaps"),
  panelPie: document.getElementById("panel-pie")
};

let levelChart;
let distanceChart;
let rateChart;
let hourlyChart;
let gapsChart;
let activityPieChart;
let topDrainsChart;
let topFillsChart;
let cumulativeChart;

const CHART_TYPE_TITLES = {
  level: "Water level (%)",
  distance: "Distance to water surface (cm)",
  rate: "Rate of change (% per minute)",
  hourly: "Hourly consumption (sum of drops)",
  gaps: "Minutes between consecutive readings",
  pie: "Tank activity split"
};
let availableDates = [];
let devicesPayload = null;

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getFirebaseBase() {
  const v = refs.firebaseBaseInput.value.trim();
  if (v) return v.replace(/\/+$/, "");
  return loadJson(STORAGE.firebaseBase, DEFAULT_FIREBASE_BASE);
}

function getAllowlist() {
  const lines = refs.allowlistInput.value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length) return lines;
  return loadJson(STORAGE.allowlist, []);
}

function persistAllowlistFromTextarea() {
  const lines = refs.allowlistInput.value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  saveJson(STORAGE.allowlist, lines);
}

function filterDeviceIds(allIds) {
  const allow = loadJson(STORAGE.allowlist, []);
  if (!allow.length) return [...allIds].sort();
  const set = new Set(allow);
  return allIds.filter((id) => set.has(id)).sort();
}

function toDateObject(dateKey) {
  const [dd, mm, yyyy] = dateKey.split("-").map(Number);
  return new Date(yyyy, mm - 1, dd);
}

function formatTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
}

function formatDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatNum(value, digits = 1) {
  if (Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(digits);
}

function formatDateKey(dateKey) {
  const d = toDateObject(dateKey);
  return d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseTimeForDate(dateKey, hhmm) {
  const [dd, mm, yyyy] = dateKey.split("-").map(Number);
  const [h, m] = (hhmm || "00:00").split(":").map(Number);
  return new Date(yyyy, mm - 1, dd, h || 0, m || 0, 0, 0);
}

function movingAverage(values, windowSize) {
  if (windowSize <= 1) return values;
  return values.map((_, i) => {
    const start = Math.max(0, i - windowSize + 1);
    const subset = values.slice(start, i + 1);
    return subset.reduce((a, v) => a + v, 0) / subset.length;
  });
}

function normalizeDayData(rawDayData) {
  return Object.values(rawDayData || {})
    .map((entry) => ({
      timestamp: entry.timestamp,
      levelPercent: Number(entry.level_percent ?? 0),
      heightCm: Number(entry.water_height_cm ?? 0),
      distanceCm: Number(entry.distance_cm ?? 0)
    }))
    .filter((row) => row.timestamp)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function subsetRowsForRange(rows, dateKey, startTime, endTime) {
  if (!rows.length) return [];
  const start = parseTimeForDate(dateKey, startTime);
  let end = parseTimeForDate(dateKey, endTime);
  if (end < start) end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);

  const result = rows.filter((r) => {
    const t = new Date(r.timestamp);
    return t >= start && t <= end;
  });

  if (!result.length) {
    const prev = [...rows].reverse().find((r) => new Date(r.timestamp) < start);
    const next = rows.find((r) => new Date(r.timestamp) > end);
    if (prev) result.push({ ...prev, timestamp: start.toISOString(), synthetic: true });
    if (next) result.push({ ...next, timestamp: end.toISOString(), synthetic: true });
  } else {
    const first = result[0];
    const last = result[result.length - 1];
    if (new Date(first.timestamp) > start) {
      const prev = [...rows].reverse().find((r) => new Date(r.timestamp) < start);
      if (prev) result.unshift({ ...prev, timestamp: start.toISOString(), synthetic: true });
    }
    if (new Date(last.timestamp) < end) {
      result.push({ ...last, timestamp: end.toISOString(), synthetic: true });
    }
  }

  return result.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function getDateKeysFromHistory(historyObj) {
  return Object.keys(historyObj || {})
    .filter((key) => DATE_KEY_REGEX.test(key))
    .sort((a, b) => toDateObject(b) - toDateObject(a));
}

function buildSelectedDateList(mode, singleDate, fromDate, toDate) {
  if (mode === "single") return [singleDate];
  if (mode === "week") {
    return availableDates.slice(0, 7).sort((a, b) => toDateObject(a) - toDateObject(b));
  }
  const start = toDateObject(fromDate);
  const end = toDateObject(toDate);
  const min = start <= end ? start : end;
  const max = start <= end ? end : start;
  return availableDates
    .filter((d) => {
      const x = toDateObject(d);
      return x >= min && x <= max;
    })
    .sort((a, b) => toDateObject(a) - toDateObject(b));
}

function mergeRowsAcrossDates(rowsByDate, startTime, endTime) {
  return rowsByDate.flatMap(({ dateKey, rows }) => subsetRowsForRange(rows, dateKey, startTime, endTime));
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function computeGaps(rows) {
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const ms = new Date(cur.timestamp) - new Date(prev.timestamp);
    const minutes = Math.max(ms / 60000, 0);
    gaps.push({
      at: cur.timestamp,
      minutes,
      levelBefore: prev.levelPercent,
      levelAfter: cur.levelPercent,
      delta: cur.levelPercent - prev.levelPercent
    });
  }
  const minutesOnly = gaps.map((g) => g.minutes);
  return {
    gaps,
    medianGap: median(minutesOnly),
    maxGap: minutesOnly.length ? Math.max(...minutesOnly) : 0,
    avgGap: minutesOnly.length ? minutesOnly.reduce((a, b) => a + b, 0) / minutesOnly.length : 0
  };
}

function buildCumulativeSeries(rows) {
  if (!rows.length) return { labels: [], consumed: [], filled: [] };
  const labels = rows.map((r) => formatTime(r.timestamp));
  let u = 0;
  let f = 0;
  const consumed = [0];
  const filled = [0];
  for (let i = 1; i < rows.length; i += 1) {
    const d = rows[i].levelPercent - rows[i - 1].levelPercent;
    if (d < 0) u += Math.abs(d);
    else if (d > 0) f += d;
    consumed.push(u);
    filled.push(f);
  }
  return { labels, consumed, filled };
}

function analyze(rows, significantChange, tankHeightCm) {
  const emptyGap = { gaps: [], medianGap: 0, maxGap: 0, avgGap: 0 };
  if (!rows.length) {
    return {
      summary: {
        minLevel: 0,
        maxLevel: 0,
        avgLevel: 0,
        samples: 0,
        totalFill: 0,
        totalUse: 0,
        totalFillCm: 0,
        totalUseCm: 0,
        waterNowCm: 0,
        fillEvents: 0,
        mostConsumedAt: null,
        mostFilledAt: null,
        lastReadingAt: null,
        biggestIntervalDrop: { percent: 0, from: null, to: null, minutes: 0 }
      },
      hourlyUsage: new Array(24).fill(0),
      gapStats: emptyGap,
      events: { consumes: [], fills: [] },
      cumulative: { labels: [], consumed: [], filled: [] }
    };
  }

  const realRows = rows.filter((r) => !r.synthetic);
  const series = realRows.length ? realRows : rows;

  let minLevel = series[0].levelPercent;
  let maxLevel = series[0].levelPercent;
  let levelTotal = 0;
  let totalFill = 0;
  let totalUse = 0;
  let fillEvents = 0;
  let activeFill = false;
  const hourlyUsage = new Array(24).fill(0);
  const consumes = [];
  const fills = [];

  let biggestDrop = { delta: 0, at: null };
  let biggestRise = { delta: 0, at: null };
  let biggestIntervalDrop = { percent: 0, from: null, to: null, minutes: 0 };

  for (let i = 0; i < series.length; i += 1) {
    const current = series[i];
    minLevel = Math.min(minLevel, current.levelPercent);
    maxLevel = Math.max(maxLevel, current.levelPercent);
    levelTotal += current.levelPercent;

    if (i === 0) continue;

    const prev = series[i - 1];
    const delta = current.levelPercent - prev.levelPercent;
    const mins = Math.max((new Date(current.timestamp) - new Date(prev.timestamp)) / 60000, 0.01);

    if (delta < -0.02) {
      consumes.push({
        from: prev.timestamp,
        to: current.timestamp,
        percent: Math.abs(delta),
        cm: (Math.abs(delta) / 100) * tankHeightCm
      });
    }
    if (delta > 0.02) {
      fills.push({
        from: prev.timestamp,
        to: current.timestamp,
        percent: delta,
        cm: (delta / 100) * tankHeightCm
      });
    }

    if (delta < 0 && Math.abs(delta) > biggestIntervalDrop.percent) {
      biggestIntervalDrop = {
        percent: Math.abs(delta),
        from: prev.timestamp,
        to: current.timestamp,
        minutes: mins
      };
    }

    if (delta > 0) {
      totalFill += delta;
      if (delta > biggestRise.delta) biggestRise = { delta, at: current.timestamp };
      if (delta >= significantChange && !activeFill) {
        fillEvents += 1;
        activeFill = true;
      }
    } else if (delta < 0) {
      totalUse += Math.abs(delta);
      if (Math.abs(delta) > biggestDrop.delta) biggestDrop = { delta: Math.abs(delta), at: current.timestamp };
      const h = new Date(current.timestamp).getHours();
      hourlyUsage[h] += Math.abs(delta);
      activeFill = false;
    } else {
      activeFill = false;
    }
  }

  const gapStats = computeGaps(series);
  const cumulative = buildCumulativeSeries(series);

  const last = series[series.length - 1];
  return {
    summary: {
      minLevel,
      maxLevel,
      avgLevel: levelTotal / series.length,
      samples: series.length,
      totalFill,
      totalUse,
      totalFillCm: (totalFill / 100) * tankHeightCm,
      totalUseCm: (totalUse / 100) * tankHeightCm,
      waterNowCm: (last.levelPercent / 100) * tankHeightCm,
      fillEvents,
      mostConsumedAt: biggestDrop.at,
      mostFilledAt: biggestRise.at,
      lastReadingAt: last.timestamp,
      currentLevelPct: last.levelPercent,
      currentDistanceCm: last.distanceCm,
      biggestIntervalDrop
    },
    hourlyUsage,
    gapStats,
    events: { consumes, fills },
    cumulative
  };
}

function chartColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    accent: g("--chart-accent", "#4fd1ff"),
    accent2: g("--chart-accent-2", "#6df5b8"),
    danger: g("--chart-danger", "#ff7f8f"),
    muted: g("--chart-muted", "#9eb4d2"),
    border: g("--chart-border", "#22416f"),
    text: g("--chart-text", "#ebf3ff")
  };
}

function renderKpiStrip(summary, dateCaption, startTime, endTime, gapStats) {
  const parts = [
    { k: "Range", v: dateCaption },
    { k: "Time", v: `${startTime}–${endTime}` },
    { k: "Samples", v: String(summary.samples) },
    { k: "Level now", v: `${formatNum(summary.currentLevelPct)}%` },
    { k: "Water", v: `${formatNum(summary.waterNowCm)} cm` },
    { k: "Consumed", v: `${formatNum(summary.totalUse)}%` },
    { k: "Filled", v: `${formatNum(summary.totalFill)}%` },
    { k: "Median gap", v: `${formatNum(gapStats.medianGap, 1)}m` },
    { k: "Max gap", v: `${formatNum(gapStats.maxGap, 1)}m` },
    { k: "Biggest drop", v: `${formatNum(summary.biggestIntervalDrop.percent)}%` },
    { k: "Fills ≥thr.", v: String(summary.fillEvents) }
  ];
  refs.kpiStrip.innerHTML = `
    <div class="kpi-strip card card-wtm">
      <div class="kpi-strip-scroll">
        ${parts
          .map(
            (p) => `
          <span class="kpi-chip">
            <span class="kpi-chip-k">${p.k}</span>
            <span class="kpi-chip-v">${escapeHtml(String(p.v))}</span>
          </span>`
          )
          .join("")}
      </div>
    </div>`;
}

function renderInsights(summary, dateCaption, gapStats, tankHeightCm, events) {
  const sparse = gapStats.medianGap > 5 || gapStats.maxGap > 30;
  const topDrop = events?.consumes?.length
    ? [...events.consumes].sort((a, b) => b.percent - a.percent)[0]
    : null;
  const topRise = events?.fills?.length ? [...events.fills].sort((a, b) => b.percent - a.percent)[0] : null;
  const dropLine = topDrop
    ? `Biggest consumption step in this range: ${formatNum(topDrop.percent)}% lost between ${formatTime(topDrop.from)} and ${formatTime(topDrop.to)} (~${formatNum(topDrop.cm)} cm water column).`
    : "No clear consumption steps (drops) detected between samples in this window.";
  const riseLine = topRise
    ? `Biggest refill / rise step: +${formatNum(topRise.percent)}% between ${formatTime(topRise.from)} and ${formatTime(topRise.to)} (~${formatNum(topRise.cm)} cm).`
    : "No clear refill steps (rises) detected between samples in this window.";

  const insights = [
    `Across ${dateCaption}, level ranged from ${formatNum(summary.minLevel)}% to ${formatNum(summary.maxLevel)}%.`,
    `Latest reading: ${formatDateTime(summary.lastReadingAt)} — tank at about ${formatNum(summary.currentLevelPct)}% (~${formatNum(summary.waterNowCm)} cm water column vs ~${formatNum(tankHeightCm)} cm configured tank height).`,
    dropLine,
    riseLine,
    `Strongest single consumption interval (by % lost): ${formatNum(summary.biggestIntervalDrop.percent)}% from ${formatTime(summary.biggestIntervalDrop.from)} to ${formatTime(summary.biggestIntervalDrop.to)} (${formatNum(summary.biggestIntervalDrop.minutes, 2)} min between readings).`,
    `Largest instantaneous drop sample vs previous point at ${formatTime(summary.mostConsumedAt)}; largest rise sample at ${formatTime(summary.mostFilledAt)}.`,
    sparse
      ? `Upload pattern looks sparse: median ${formatNum(gapStats.medianGap, 2)} min between samples (max ${formatNum(gapStats.maxGap, 2)} min). The main chart uses stepped lines so the level holds flat between uploads.`
      : `Samples arrived roughly every ${formatNum(gapStats.medianGap, 2)} min on average in this window.`
  ];

  refs.insightList.innerHTML = insights.map((msg) => `<li>${escapeHtml(msg)}</li>`).join("");

  if (sparse) {
    refs.sparseNote.hidden = false;
    refs.sparseNote.textContent =
      "This device only uploads when readings change. Intervals between points reflect silence, not missing hardware data.";
  } else {
    refs.sparseNote.hidden = true;
  }
}

function createOrUpdateChart(chartRef, targetId, config) {
  if (chartRef) {
    chartRef.data = config.data;
    chartRef.options = config.options;
    chartRef.update();
    return chartRef;
  }
  const ctx = document.getElementById(targetId);
  return new Chart(ctx, config);
}

function renderCharts(rows, smoothingWindow, gapStats) {
  const col = chartColors();
  const labels = rows.map((row) => formatTime(row.timestamp));
  const levels = rows.map((row) => row.levelPercent);
  const smoothLevels = movingAverage(levels, smoothingWindow);
  const rateData = rows.map((row, i) => {
    if (i === 0) return 0;
    const prev = rows[i - 1];
    const delta = row.levelPercent - prev.levelPercent;
    const mins = Math.max((new Date(row.timestamp) - new Date(prev.timestamp)) / 60000, 0.01);
    return delta / mins;
  });
  const distances = rows.map((row) => row.distanceCm);
  const gapLabels = gapStats.gaps.map((g) => formatTime(g.at));
  const gapMinutes = gapStats.gaps.map((g) => g.minutes);

  levelChart = createOrUpdateChart(levelChart, "levelChart", {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Level % (stepped)",
          data: levels,
          borderColor: col.accent,
          backgroundColor: `${col.accent}33`,
          fill: false,
          stepped: "before",
          pointRadius: 2,
          tension: 0
        },
        {
          label: "Smoothed %",
          data: smoothLevels,
          borderColor: col.accent2,
          borderDash: [6, 4],
          pointRadius: 0,
          stepped: false,
          tension: 0.2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: col.text } } },
      scales: {
        y: {
          min: 0,
          max: 100,
          title: { display: true, text: "Level %", color: col.muted },
          ticks: { color: col.muted },
          grid: { color: col.border }
        },
        x: {
          title: { display: true, text: "Time", color: col.muted },
          ticks: { color: col.muted, maxRotation: 45, minRotation: 0 },
          grid: { color: col.border }
        }
      }
    }
  });

  distanceChart = createOrUpdateChart(distanceChart, "distanceChart", {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Distance cm",
          data: distances,
          borderColor: col.danger,
          stepped: "before",
          pointRadius: 2,
          tension: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: col.text } } },
      scales: {
        y: {
          title: { display: true, text: "cm", color: col.muted },
          ticks: { color: col.muted },
          grid: { color: col.border }
        },
        x: {
          ticks: { color: col.muted, maxRotation: 45 },
          grid: { color: col.border }
        }
      }
    }
  });

  rateChart = createOrUpdateChart(rateChart, "rateChart", {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "% per minute",
          data: rateData,
          backgroundColor: rateData.map((v) => (v >= 0 ? `${col.accent2}aa` : `${col.danger}aa`)),
          borderColor: rateData.map((v) => (v >= 0 ? col.accent2 : col.danger)),
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: col.text } } },
      scales: {
        y: { title: { display: true, text: "% / min", color: col.muted }, ticks: { color: col.muted }, grid: { color: col.border } },
        x: { ticks: { color: col.muted, maxRotation: 45 }, grid: { color: col.border } }
      }
    }
  });

  gapsChart = createOrUpdateChart(gapsChart, "gapsChart", {
    type: "bar",
    data: {
      labels: gapLabels,
      datasets: [
        {
          label: "Minutes since previous sample",
          data: gapMinutes,
          backgroundColor: `${col.accent}88`,
          borderColor: col.accent,
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: col.text } } },
      scales: {
        y: { title: { display: true, text: "Minutes", color: col.muted }, ticks: { color: col.muted }, grid: { color: col.border } },
        x: { ticks: { color: col.muted, maxRotation: 60, autoSkip: true, maxTicksLimit: 24 }, grid: { color: col.border } }
      }
    }
  });
}

function renderHourlyChart(hourlyUsage) {
  const col = chartColors();
  hourlyChart = createOrUpdateChart(hourlyChart, "hourlyChart", {
    type: "bar",
    data: {
      labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`),
      datasets: [
        {
          label: "Hourly consumption (%)",
          data: hourlyUsage,
          backgroundColor: `${col.danger}99`,
          borderColor: col.danger,
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: col.text } } },
      scales: {
        y: { title: { display: true, text: "Consumed %", color: col.muted }, ticks: { color: col.muted }, grid: { color: col.border } },
        x: { title: { display: true, text: "Hour", color: col.muted }, ticks: { color: col.muted }, grid: { color: col.border } }
      }
    }
  });
}

function renderActivityPie(summary) {
  const col = chartColors();
  const netStored = clamp(summary.totalFill - summary.totalUse, 0, 100);
  activityPieChart = createOrUpdateChart(activityPieChart, "activityPieChart", {
    type: "doughnut",
    data: {
      labels: ["Consumed", "Filled", "Net stored est."],
      datasets: [
        {
          data: [summary.totalUse, summary.totalFill, netStored],
          backgroundColor: [col.danger, col.accent2, col.accent],
          borderColor: col.border,
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { color: col.text } } }
    }
  });
}

function renderTopEventsCharts(events) {
  const col = chartColors();
  const topN = 12;
  const drains = [...events.consumes].sort((a, b) => b.percent - a.percent).slice(0, topN).reverse();
  const fillEv = [...events.fills].sort((a, b) => b.percent - a.percent).slice(0, topN).reverse();

  const drainLabels = drains.length ? drains.map((e) => `${formatTime(e.to)} (−${formatNum(e.percent)}%)`) : ["No drops in this window"];
  const drainData = drains.length ? drains.map((e) => e.percent) : [0];
  const fillLabels = fillEv.length ? fillEv.map((e) => `${formatTime(e.to)} (+${formatNum(e.percent)}%)`) : ["No rises in this window"];
  const fillData = fillEv.length ? fillEv.map((e) => e.percent) : [0];

  topDrainsChart = createOrUpdateChart(topDrainsChart, "topDrainsChart", {
    type: "bar",
    data: {
      labels: drainLabels,
      datasets: [
        {
          label: "Drop %",
          data: drainData,
          backgroundColor: drains.length ? drains.map(() => `${col.danger}cc`) : [`${col.border}55`],
          borderColor: drains.length ? col.danger : col.border,
          borderWidth: 1,
          stepDetails: drains
        }
      ]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel(ctx) {
              const meta = ctx.dataset.stepDetails?.[ctx.dataIndex];
              if (!meta) return "";
              return `${formatDateTime(meta.from)} → ${formatDateTime(meta.to)} · ${formatNum(meta.cm)} cm column`;
            }
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: "% level lost per step", color: col.muted },
          ticks: { color: col.muted },
          grid: { color: col.border }
        },
        y: {
          ticks: { color: col.text, font: { size: 11 }, maxRotation: 0 },
          grid: { display: false }
        }
      }
    }
  });

  topFillsChart = createOrUpdateChart(topFillsChart, "topFillsChart", {
    type: "bar",
    data: {
      labels: fillLabels,
      datasets: [
        {
          label: "Rise %",
          data: fillData,
          backgroundColor: fillEv.length ? fillEv.map(() => `${col.accent2}cc`) : [`${col.border}55`],
          borderColor: fillEv.length ? col.accent2 : col.border,
          borderWidth: 1,
          stepDetails: fillEv
        }
      ]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel(ctx) {
              const meta = ctx.dataset.stepDetails?.[ctx.dataIndex];
              if (!meta) return "";
              return `${formatDateTime(meta.from)} → ${formatDateTime(meta.to)} · +${formatNum(meta.cm)} cm column`;
            }
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: "% level gained per step", color: col.muted },
          ticks: { color: col.muted },
          grid: { color: col.border }
        },
        y: {
          ticks: { color: col.text, font: { size: 11 }, maxRotation: 0 },
          grid: { display: false }
        }
      }
    }
  });
}

function renderCumulativeChart(cumulative) {
  const col = chartColors();
  const { labels, consumed, filled } = cumulative;
  if (!labels.length) {
    if (cumulativeChart) cumulativeChart.destroy();
    cumulativeChart = null;
    return;
  }

  cumulativeChart = createOrUpdateChart(cumulativeChart, "cumulativeChart", {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Cumulative consumed %",
          data: consumed,
          borderColor: col.danger,
          backgroundColor: `${col.danger}24`,
          fill: true,
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 2
        },
        {
          label: "Cumulative filled %",
          data: filled,
          borderColor: col.accent2,
          backgroundColor: `${col.accent2}20`,
          fill: true,
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "top", labels: { color: col.text, boxWidth: 12 } } },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: "Cumulative %", color: col.muted },
          ticks: { color: col.muted },
          grid: { color: col.border }
        },
        x: {
          ticks: { color: col.muted, maxTicksLimit: 14, autoSkip: true },
          grid: { color: col.border }
        }
      }
    }
  });
}

function updateGraphVisibility() {
  const selected = refs.chartType.value;
  refs.panelLevel.classList.toggle("hidden", selected !== "level");
  refs.panelDistance.classList.toggle("hidden", selected !== "distance");
  refs.panelRate.classList.toggle("hidden", selected !== "rate");
  refs.panelHourly.classList.toggle("hidden", selected !== "hourly");
  refs.panelGaps.classList.toggle("hidden", selected !== "gaps");
  refs.panelPie.classList.toggle("hidden", selected !== "pie");
  if (refs.heroChartHeading) {
    refs.heroChartHeading.textContent = CHART_TYPE_TITLES[selected] || "Chart";
  }
}

function updateModeVisibility() {
  const mode = refs.reportMode.value;
  document.querySelectorAll(".mode-single").forEach((el) => {
    el.classList.toggle("d-none", mode !== "single");
  });
  document.querySelectorAll(".mode-custom").forEach((el) => {
    el.classList.toggle("d-none", mode !== "custom");
  });
}

async function fetchJson(base, path, query = "") {
  const cleanPath = String(path || "").replace(/^\/+|\/+$/g, "");
  const urlPath = cleanPath ? `/${cleanPath}.json` : "/.json";
  const queryPart = query ? `?${query}` : "";
  const res = await fetch(`${base}${urlPath}${queryPart}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadDevicesFromFirebase() {
  const base = getFirebaseBase();
  saveJson(STORAGE.firebaseBase, base);
  const shallow = await fetchJson(base, "devices", "shallow=true");
  const keys = Object.keys(shallow || {}).filter((k) => shallow[k]);
  const filtered = filterDeviceIds(keys);
  const targetIds = filtered.length ? filtered : keys.sort();
  if (!targetIds.length) throw new Error("No devices found under /devices");

  const entries = await Promise.all(
    targetIds.map(async (id) => {
      const data = await fetchJson(base, `devices/${encodeURIComponent(id)}`);
      return [id, data];
    })
  );
  return Object.fromEntries(entries);
}

async function syncDevicesFromFirebase() {
  const base = (refs.firebaseBaseInput.value.trim() || DEFAULT_FIREBASE_BASE).replace(/\/+$/, "");
  refs.firebaseBaseInput.value = base;
  saveJson(STORAGE.firebaseBase, base);
  refs.statusText.textContent = "Fetching from Firebase…";
  const map = await loadDevicesFromFirebase();
  saveJson(STORAGE.devicesCache, map);
  await applyDevicesMap(map);
  refs.statusText.textContent = `Loaded ${Object.keys(map).length} device(s) from Firebase.`;
}

function flattenKeyedLog(mapObj) {
  if (!mapObj || typeof mapObj !== "object") return [];
  return Object.values(mapObj)
    .map((e) => ({
      time: e.time || e.timestamp,
      type: e.type || "—",
      message: e.message || ""
    }))
    .filter((e) => e.time)
    .sort((a, b) => new Date(b.time) - new Date(a.time));
}

function renderDeviceTab(device) {
  const boot = device?.bootstrap || {};
  const cfg = device?.config || {};
  const fw = device?.firmware || {};

  const bootRows = Object.entries(boot).map(
    ([k, v]) => `<dt class="col-sm-4 text-wtm-muted">${k}</dt><dd class="col-sm-8">${String(v)}</dd>`
  );
  refs.bootstrapDl.innerHTML = bootRows.length ? bootRows.join("") : '<dd class="col-12">No bootstrap block.</dd>';

  const cfgRows = Object.entries(cfg).map(
    ([k, v]) => `<dt class="col-sm-4 text-wtm-muted">${k}</dt><dd class="col-sm-8">${String(v)}</dd>`
  );
  refs.configDl.innerHTML = cfgRows.length ? cfgRows.join("") : '<dd class="col-12">No config block.</dd>';

  refs.firmwarePre.textContent = JSON.stringify(fw, null, 2);

  const logs = flattenKeyedLog(device?.logs);
  refs.logsBody.innerHTML = logs.length
    ? logs
        .map(
          (r) =>
            `<tr><td class="text-nowrap">${formatDateTime(r.time)}</td><td><span class="badge bg-info text-dark">${r.type}</span></td><td>${escapeHtml(r.message)}</td></tr>`
        )
        .join("")
    : '<tr><td colspan="3" class="text-wtm-muted px-3 py-4">No logs.</td></tr>';

  const errs = flattenKeyedLog(device?.errors);
  refs.errorsBody.innerHTML = errs.length
    ? errs
        .map(
          (r) =>
            `<tr><td class="text-nowrap">${formatDateTime(r.time)}</td><td><span class="badge bg-danger">${r.type}</span></td><td>${escapeHtml(r.message)}</td></tr>`
        )
        .join("")
    : '<tr><td colspan="3" class="text-wtm-muted px-3 py-4">No errors.</td></tr>';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function tankHeightFromDevice(device) {
  return Number(device?.bootstrap?.tank_height_cm ?? device?.config?.tank_height ?? 120);
}

function thresholdFromDevice(device) {
  return Number(device?.bootstrap?.threshold ?? device?.config?.threshold ?? refs.changeThreshold.value ?? 2);
}

function populateDeviceDropdown(ids) {
  const prev = refs.deviceSelect.value;
  refs.deviceSelect.innerHTML = ids
    .map((id) => {
      const d = devicesPayload?.[id];
      const name = d?.bootstrap?.tank_name || id;
      return `<option value="${escapeAttr(id)}">${escapeHtml(name)}</option>`;
    })
    .join("");
  if (ids.includes(prev)) refs.deviceSelect.value = prev;
  else if (ids.length) refs.deviceSelect.value = ids[0];
}

function destroyCharts() {
  [
    levelChart,
    distanceChart,
    rateChart,
    hourlyChart,
    gapsChart,
    activityPieChart,
    topDrainsChart,
    topFillsChart,
    cumulativeChart
  ].forEach((c) => {
    if (c) c.destroy();
  });
  levelChart = distanceChart = rateChart = hourlyChart = gapsChart = activityPieChart = null;
  topDrainsChart = topFillsChart = cumulativeChart = null;
}

async function refreshReport() {
  const deviceId = refs.deviceSelect.value;
  const device = devicesPayload?.[deviceId];
  if (!device) {
    refs.statusText.textContent = "No device data loaded.";
    refs.kpiStrip.innerHTML = "";
    refs.insightList.innerHTML = "<li>No device data loaded.</li>";
    refs.sparseNote.hidden = true;
    destroyCharts();
    return;
  }

  try {
    refs.statusText.textContent = "Building report…";
    const mode = refs.reportMode.value;
    const dateKey = refs.dateSelect.value;
    const fromDate = refs.fromDate.value || refs.dateSelect.value;
    const toDate = refs.toDate.value || refs.dateSelect.value;
    const threshold = Number(refs.changeThreshold.value || 2);
    const smoothingWindow = Number(refs.windowSize.value || 3);
    const startTime = refs.startTime.value || "00:00";
    const endTime = refs.endTime.value || "23:59";

    const tankHeightCm = tankHeightFromDevice(device);
    const selectedDates = buildSelectedDateList(mode, dateKey, fromDate, toDate);
    if (!selectedDates.length) {
      refs.statusText.textContent = "No dates in history for this range.";
      refs.kpiStrip.innerHTML = "";
      refs.insightList.innerHTML = "<li>No dates in history for this range.</li>";
      refs.sparseNote.hidden = true;
      destroyCharts();
      return;
    }

    const rowsByDate = selectedDates.map((d) => ({
      dateKey: d,
      rows: normalizeDayData(device.history?.[d])
    }));
    const rows = mergeRowsAcrossDates(rowsByDate, startTime, endTime);

    renderDeviceTab(device);

    if (!rows.length) {
      refs.statusText.textContent = "No readings in selected window.";
      refs.kpiStrip.innerHTML = "";
      refs.insightList.innerHTML = "<li>No samples in this time filter.</li>";
      destroyCharts();
      return;
    }

    const { summary, hourlyUsage, gapStats, events, cumulative } = analyze(rows, threshold, tankHeightCm);
    const dateCaption =
      mode === "single"
        ? formatDateKey(dateKey)
        : `${formatDateKey(selectedDates[0])} → ${formatDateKey(selectedDates[selectedDates.length - 1])}`;

    renderKpiStrip(summary, dateCaption, startTime, endTime, gapStats);
    renderInsights(summary, dateCaption, gapStats, tankHeightCm, events);
    renderCharts(rows, smoothingWindow, gapStats);
    renderHourlyChart(hourlyUsage);
    renderActivityPie(summary);
    renderTopEventsCharts(events);
    renderCumulativeChart(cumulative);
    updateGraphVisibility();

    refs.statusText.textContent = `${summary.samples} samples · device ${deviceId} · last ${formatDateTime(summary.lastReadingAt)}`;
  } catch (err) {
    refs.statusText.textContent = `Report error: ${err.message}`;
    refs.kpiStrip.innerHTML = "";
    refs.insightList.innerHTML = `<li>Report could not be built: ${escapeHtml(err.message)}</li>`;
    refs.sparseNote.hidden = true;
    destroyCharts();
  }
}

function syncDateSelectorsForDevice(device) {
  availableDates = getDateKeysFromHistory(device?.history);
  if (!availableDates.length) {
    refs.dateSelect.innerHTML = "";
    refs.fromDate.innerHTML = "";
    refs.toDate.innerHTML = "";
    return;
  }
  const opts = availableDates.map((d) => `<option value="${d}">${formatDateKey(d)}</option>`).join("");
  refs.dateSelect.innerHTML = opts;
  refs.fromDate.innerHTML = opts;
  refs.toDate.innerHTML = opts;
  refs.dateSelect.value = availableDates[0];
  refs.fromDate.value = availableDates[availableDates.length - 1];
  refs.toDate.value = availableDates[0];
  refs.changeThreshold.value = thresholdFromDevice(device);
}

function onDeviceChange() {
  const id = refs.deviceSelect.value;
  saveJson(STORAGE.selectedDevice, id);
  const dev = devicesPayload?.[id];
  syncDateSelectorsForDevice(dev);
  refreshReport();
}

async function applyDevicesMap(map) {
  devicesPayload = map || {};
  const allIds = Object.keys(devicesPayload);
  const filtered = filterDeviceIds(allIds);
  const list = filtered.length ? filtered : allIds.sort();
  if (!list.length) {
    refs.statusText.textContent = "No devices in payload.";
    populateDeviceDropdown([]);
    return;
  }
  populateDeviceDropdown(list);
  const saved = loadJson(STORAGE.selectedDevice, null);
  if (saved && list.includes(saved)) refs.deviceSelect.value = saved;
  syncDateSelectorsForDevice(devicesPayload[refs.deviceSelect.value]);
  try {
    await refreshReport();
  } catch (e) {
    refs.statusText.textContent = e.message;
  }
}

function wireEvents() {
  refs.reportMode.addEventListener("change", () => {
    updateModeVisibility();
    refreshReport();
  });
  refs.dateSelect.addEventListener("change", refreshReport);
  refs.fromDate.addEventListener("change", refreshReport);
  refs.toDate.addEventListener("change", refreshReport);
  refs.changeThreshold.addEventListener("change", refreshReport);
  refs.windowSize.addEventListener("change", refreshReport);
  refs.startTime.addEventListener("change", refreshReport);
  refs.endTime.addEventListener("change", refreshReport);
  refs.chartType.addEventListener("change", updateGraphVisibility);
  refs.refreshBtn.addEventListener("click", refreshReport);
  refs.deviceSelect.addEventListener("change", onDeviceChange);

  refs.themeSelect.addEventListener("change", () => {
    document.documentElement.setAttribute("data-theme", refs.themeSelect.value);
    saveJson(STORAGE.theme, refs.themeSelect.value);
    refreshReport();
  });

  refs.saveAllowlistBtn.addEventListener("click", () => {
    persistAllowlistFromTextarea();
    if (devicesPayload) {
      const allIds = Object.keys(devicesPayload);
      const filtered = filterDeviceIds(allIds);
      populateDeviceDropdown(filtered.length ? filtered : allIds.sort());
      onDeviceChange();
    }
  });

  const onSyncFirebase = async () => {
    try {
      await syncDevicesFromFirebase();
    } catch (e) {
      refs.statusText.textContent = `Firebase: ${e.message}`;
    }
  };

  refs.fetchFirebaseBtn.addEventListener("click", onSyncFirebase);
  refs.syncDevicesBtn.addEventListener("click", onSyncFirebase);
}

function initAdminFields() {
  const list = loadJson(STORAGE.allowlist, []);
  refs.allowlistInput.value = list.join("\n");
  refs.firebaseBaseInput.value = loadJson(STORAGE.firebaseBase, DEFAULT_FIREBASE_BASE);
  const th = loadJson(STORAGE.theme, "ocean");
  refs.themeSelect.value = th;
  document.documentElement.setAttribute("data-theme", th);
}

async function init() {
  initAdminFields();
  updateModeVisibility();
  updateGraphVisibility();
  wireEvents();

  try {
    await syncDevicesFromFirebase();
  } catch (e) {
    const cached = loadJson(STORAGE.devicesCache, null);
    if (cached && typeof cached === "object" && Object.keys(cached).length) {
      await applyDevicesMap(cached);
      refs.statusText.textContent = `Firebase: ${e.message} — showing last synced data from this browser.`;
    } else {
      refs.statusText.textContent = `Firebase: ${e.message} — check the REST URL in Admin, network, and RTDB read rules.`;
    }
  }
}

init();

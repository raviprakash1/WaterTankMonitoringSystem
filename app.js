const DEFAULT_FIREBASE_BASE = "https://waterlevelmonitor-95f66-default-rtdb.firebaseio.com";
const DATE_KEY_REGEX = /^\d{2}-\d{2}-\d{4}$/;
const STORAGE = {
  allowlist: "wtm_device_allowlist",
  selectedDevice: "wtm_selected_device",
  firebaseBase: "wtm_firebase_base",
  theme: "wtm_theme",
  devicesCache: "wtm_devices_cache",
  capacity: "wtm_tank_capacity",
  lowThreshold: "wtm_low_threshold"
};

const $ = (id) => document.getElementById(id);
const refs = {
  themeSelect: $("themeSelect"), deviceSelect: $("deviceSelect"),
  syncDevicesBtn: $("syncDevicesBtn"), refreshBtn: $("refreshBtn"),
  reportMode: $("reportMode"), dateSelect: $("dateSelect"),
  fromDate: $("fromDate"), toDate: $("toDate"),
  capacityInput: $("capacityInput"), changeThreshold: $("changeThreshold"),
  lowThreshold: $("lowThreshold"), startTime: $("startTime"), endTime: $("endTime"),
  kpiStrip: $("kpiStrip"), insightList: $("insightList"), statusText: $("statusText"),
  sparseNote: $("sparseNote"), allowlistInput: $("allowlistInput"),
  saveAllowlistBtn: $("saveAllowlistBtn"), firebaseBaseInput: $("firebaseBaseInput"),
  fetchFirebaseBtn: $("fetchFirebaseBtn"), autoRefreshToggle: $("autoRefreshToggle"),
  bootstrapDl: $("bootstrapDl"), configDl: $("configDl"), firmwarePre: $("firmwarePre"),
  logsBody: $("logsBody"), errorsBody: $("errorsBody"),
  tankCanvas: $("tankCanvas"), tankPct: $("tankPct"), tankSub: $("tankSub"),
  tankVol: $("tankVol"), tankTitle: $("tankTitle"), statusPill: $("statusPill"),
  tankTrend: $("tankTrend"), trendArrow: $("trendArrow"), trendText: $("trendText"),
  factHeight: $("factHeight"), factDistance: $("factDistance"),
  factTankHeight: $("factTankHeight"), factTds: $("factTds"), factTemp: $("factTemp"),
  factUpdated: $("factUpdated"),
  gaugeLegend: $("gaugeLegend"), vitals: $("vitals"),
  livePill: $("livePill"), livePillText: $("livePillText"),
  fillEvents: $("fillEvents"), drainEvents: $("drainEvents"), lowEvents: $("lowEvents")
};

let devicesPayload = {};
let availableDates = [];
let charts = {};
let tankAnimation = null;
let autoRefreshTimer = null;

function loadJson(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function saveJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, Number(v) || 0)); }
function number(v, digits = 1) { return Number.isFinite(Number(v)) ? Number(v).toFixed(digits) : "—"; }
function litersFromPct(pct) { return (clamp(pct, 0, 100) / 100) * Number(refs.capacityInput.value || 0); }
function toDateObject(key) {
  const [d, m, y] = String(key).split("-").map(Number);
  return new Date(y, m - 1, d);
}
function formatDateKey(key) {
  const d = toDateObject(key);
  return Number.isNaN(d.getTime()) ? key : d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}
function formatDateTime(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
function formatTime(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function durationText(minutes) {
  if (!Number.isFinite(minutes)) return "—";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}
function relativeTime(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}
function getFirebaseBase() {
  return (refs.firebaseBaseInput.value.trim() || loadJson(STORAGE.firebaseBase, DEFAULT_FIREBASE_BASE)).replace(/\/+$/, "");
}
function getAllowlist() {
  return refs.allowlistInput.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}
function chartColors() {
  const s = getComputedStyle(document.documentElement);
  const g = (n, f) => s.getPropertyValue(n).trim() || f;
  return {
    blue: g("--chart-accent", "#4fd1ff"), green: g("--chart-accent-2", "#6df5b8"),
    red: g("--chart-danger", "#ff8b9a"), muted: g("--chart-muted", "#b4c6e0"),
    grid: g("--chart-border", "#2a4a78"), text: g("--chart-text", "#f4f8ff"),
    amber: "#f6c760", purple: "#a78bfa"
  };
}

async function fetchJson(base, path, query = "") {
  const clean = String(path).replace(/^\/+|\/+$/g, "");
  const res = await fetch(`${base}/${clean}.json${query ? `?${query}` : ""}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Firebase HTTP ${res.status}`);
  return res.json();
}
async function loadDevicesFromFirebase() {
  const base = getFirebaseBase();
  saveJson(STORAGE.firebaseBase, base);
  const shallow = await fetchJson(base, "devices", "shallow=true");
  let ids = Object.keys(shallow || {}).filter((id) => shallow[id]);
  const allow = loadJson(STORAGE.allowlist, []);
  if (allow.length) ids = ids.filter((id) => allow.includes(id));
  if (!ids.length) throw new Error("No devices found under /devices");
  return Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await fetchJson(base, `devices/${encodeURIComponent(id)}`)])));
}
async function syncDevicesFromFirebase({ quiet = false } = {}) {
  if (!quiet) refs.statusText.textContent = "Fetching fresh readings from Firebase…";
  const map = await loadDevicesFromFirebase();
  devicesPayload = map;
  saveJson(STORAGE.devicesCache, map);
  applyDevicesMap(map);
  refs.statusText.textContent = `Synced ${Object.keys(map).length} device(s) · ${new Date().toLocaleTimeString()}`;
}

function normalizeDayData(rawDay, dateKey) {
  return Object.values(rawDay || {}).map((e) => ({
    timestamp: e.timestamp, dateKey,
    levelPercent: Number(e.level_percent),
    heightCm: Number(e.water_height_cm),
    distanceCm: Number(e.distance_cm),
    tdsPpm: Number(e.tds_ppm),
    tempC: Number(e.temperature_c)
  })).filter((r) => r.timestamp && Number.isFinite(r.levelPercent))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}
function selectedDateKeys() {
  const mode = refs.reportMode.value;
  if (mode === "single") return refs.dateSelect.value ? [refs.dateSelect.value] : [];
  const asc = [...availableDates].sort((a, b) => toDateObject(a) - toDateObject(b));
  if (mode === "week") return asc.slice(-7);
  if (mode === "month") return asc.slice(-30);
  if (mode === "all") return asc;
  let start = toDateObject(refs.fromDate.value);
  let end = toDateObject(refs.toDate.value);
  if (start > end) [start, end] = [end, start];
  return asc.filter((k) => { const d = toDateObject(k); return d >= start && d <= end; });
}
function rowsForSelection(device) {
  const start = refs.startTime.value || "00:00";
  const end = refs.endTime.value || "23:59";
  return selectedDateKeys().flatMap((dateKey) => normalizeDayData(device.history?.[dateKey], dateKey))
    .filter((r) => {
      const hhmm = new Date(r.timestamp).toTimeString().slice(0, 5);
      return start <= end ? hhmm >= start && hhmm <= end : hhmm >= start || hhmm <= end;
    }).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function groupRuns(steps, kind, threshold) {
  // Group consecutive movement first, then apply the event threshold to the
  // whole run. This catches gradual refills (for example five +1% samples).
  const wanted = kind === "fill" ? (d) => d > 0.05 : (d) => d < -0.05;
  const groups = [];
  let current = null;
  steps.forEach((s) => {
    if (wanted(s.delta)) {
      if (!current) {
        current = { kind, from: s.from, to: s.to, startLevel: s.before, endLevel: s.after, delta: s.delta, steps: 1 };
      } else {
        current.to = s.to; current.endLevel = s.after; current.delta += s.delta; current.steps += 1;
      }
    } else if (current) {
      groups.push(current); current = null;
    }
  });
  if (current) groups.push(current);
  return groups.map((g) => ({
    ...g,
    percent: Math.abs(g.endLevel - g.startLevel),
    liters: litersFromPct(Math.abs(g.endLevel - g.startLevel)),
    minutes: Math.max(0, (new Date(g.to) - new Date(g.from)) / 60000)
  })).filter((g) => g.percent >= threshold);
}

function detectLowEpisodes(rows, threshold) {
  const episodes = [];
  let active = null;
  rows.forEach((r) => {
    if (r.levelPercent <= threshold) {
      if (!active) active = { from: r.timestamp, to: r.timestamp, min: r.levelPercent, end: r.levelPercent };
      active.to = r.timestamp; active.min = Math.min(active.min, r.levelPercent); active.end = r.levelPercent;
    } else if (active) { episodes.push(active); active = null; }
  });
  if (active) episodes.push(active);
  return episodes.map((e) => ({ ...e, minutes: Math.max(0, (new Date(e.to) - new Date(e.from)) / 60000) }));
}

function analyze(rows, eventThreshold, lowThreshold) {
  const steps = [];
  const allGaps = [];
  const gapLabels = [];
  const hourly = Array(24).fill(0);
  const timeParts = [0, 0, 0, 0];
  let totalFill = 0, totalUse = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1], cur = rows[i];
    const delta = cur.levelPercent - prev.levelPercent;
    const mins = Math.max(0, (new Date(cur.timestamp) - new Date(prev.timestamp)) / 60000);
    allGaps.push(mins);
    gapLabels.push(formatDateTime(cur.timestamp));
    // A change across different history days or a long silent period is not
    // observable as a real fill/drain event. Keep it out of usage totals.
    if (prev.dateKey !== cur.dateKey || mins > 180) continue;
    const s = { from: prev.timestamp, to: cur.timestamp, before: prev.levelPercent, after: cur.levelPercent, delta, minutes: mins };
    steps.push(s);
    if (delta > 0) totalFill += delta;
    if (delta < 0) {
      const amount = Math.abs(delta);
      totalUse += amount;
      const hour = new Date(cur.timestamp).getHours();
      hourly[hour] += amount;
      timeParts[Math.floor(hour / 6)] += amount;
    }
  }
  const fillRuns = groupRuns(steps, "fill", eventThreshold);
  const drainRuns = groupRuns(steps, "drain", eventThreshold);
  const levels = rows.map((r) => r.levelPercent);
  const gaps = allGaps;
  const daily = {};
  rows.forEach((r) => {
    daily[r.dateKey] ||= { label: formatDateKey(r.dateKey), fill: 0, use: 0, close: r.levelPercent };
    daily[r.dateKey].close = r.levelPercent;
  });
  steps.forEach((s) => {
    const key = rows.find((r) => r.timestamp === s.to)?.dateKey;
    if (!key || !daily[key]) return;
    if (s.delta > 0) daily[key].fill += s.delta;
    else daily[key].use += Math.abs(s.delta);
  });
  const cumulative = { labels: [], fill: [], use: [] };
  let cf = 0, cu = 0;
  rows.forEach((r, i) => {
    if (i) {
      const prev = rows[i - 1];
      const mins = (new Date(r.timestamp) - new Date(prev.timestamp)) / 60000;
      if (prev.dateKey === r.dateKey && mins <= 180) {
        const d = r.levelPercent - prev.levelPercent;
        d > 0 ? cf += d : cu += Math.abs(d);
      }
    }
    cumulative.labels.push(formatTime(r.timestamp)); cumulative.fill.push(cf); cumulative.use.push(cu);
  });
  const first = rows[0], last = rows.at(-1);
  const elapsedHours = Math.max(0.01, (new Date(last.timestamp) - new Date(first.timestamp)) / 3600000);
  const usePerDay = (totalUse / elapsedHours) * 24;
  // A few minutes of data can turn one large draw into an absurd forecast.
  // Require a meaningful observation window before showing days remaining.
  const enoughForForecast = elapsedHours >= 6 && rows.length >= 8;
  const daysRemaining = enoughForForecast && usePerDay > 0 ? last.levelPercent / usePerDay : Infinity;
  const tdsVals = rows.map((r) => r.tdsPpm).filter(Number.isFinite);
  const tempVals = rows.map((r) => r.tempC).filter(Number.isFinite);
  return {
    first, last, steps, hourly, timeParts, totalFill, totalUse, fillRuns, drainRuns,
    lowEpisodes: detectLowEpisodes(rows, lowThreshold),
    min: Math.min(...levels), max: Math.max(...levels),
    avg: levels.reduce((a, b) => a + b, 0) / levels.length,
    trend: rows.length > 1 ? last.levelPercent - rows.at(-2).levelPercent : 0,
    gaps, gapLabels, medianGap: median(gaps), maxGap: gaps.length ? Math.max(...gaps) : 0,
    daily: Object.values(daily), cumulative, usePerDay, daysRemaining, samples: rows.length,
    lastTds: Number.isFinite(last.tdsPpm) ? last.tdsPpm : NaN,
    lastTemp: Number.isFinite(last.tempC) ? last.tempC : NaN,
    avgTds: tdsVals.length ? tdsVals.reduce((a, b) => a + b, 0) / tdsVals.length : NaN,
    avgTemp: tempVals.length ? tempVals.reduce((a, b) => a + b, 0) / tempVals.length : NaN,
    minTds: tdsVals.length ? Math.min(...tdsVals) : NaN,
    maxTds: tdsVals.length ? Math.max(...tdsVals) : NaN,
    minTemp: tempVals.length ? Math.min(...tempVals) : NaN,
    maxTemp: tempVals.length ? Math.max(...tempVals) : NaN
  };
}
function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function destroyCharts() {
  Object.values(charts).forEach((chart) => chart?.destroy());
  charts = {};
}
function makeChart(name, canvasId, config) {
  charts[name]?.destroy();
  const el = $(canvasId);
  if (!el || !window.Chart) return null;
  charts[name] = new Chart(el, config);
  return charts[name];
}
function baseOptions(yTitle = "", { stacked = false, beginAtZero = true } = {}) {
  const c = chartColors();
  return {
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 700, easing: "easeOutQuart" },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: c.text, usePointStyle: true, pointStyle: "circle", boxWidth: 8 } },
      tooltip: { backgroundColor: "rgba(5,13,24,.94)", padding: 12, cornerRadius: 10 }
    },
    scales: {
      x: { stacked, ticks: { color: c.muted, maxTicksLimit: 14, maxRotation: 0 }, grid: { color: `${c.grid}70` } },
      y: { stacked, beginAtZero, ticks: { color: c.muted }, grid: { color: `${c.grid}70` },
        title: { display: !!yTitle, text: yTitle, color: c.muted } }
    }
  };
}

function renderLiveTank(device, analysis, tankHeight) {
  const live = device.tank_live || {};
  const fallback = analysis.last;
  const pct = clamp(Number(live.level_percent ?? fallback.levelPercent), 0, 100);
  const height = Number(live.water_height_cm ?? fallback.heightCm ?? pct / 100 * tankHeight);
  const distance = Number(live.distance_cm ?? fallback.distanceCm);
  const updated = live.updated_at || fallback.timestamp;
  const capacity = Number(refs.capacityInput.value || 0);
  const name = device.bootstrap?.tank_name || refs.deviceSelect.value || "Water tank";
  const low = Number(refs.lowThreshold.value || 20);

  refs.tankTitle.textContent = name;
  refs.tankPct.textContent = number(pct, 0);
  refs.tankSub.textContent = `${number(height)} cm water`;
  refs.tankVol.textContent = capacity ? `≈ ${Math.round(capacity * pct / 100).toLocaleString()} L` : "";
  refs.factHeight.textContent = `${number(height)} cm`;
  refs.factDistance.textContent = `${number(distance)} cm`;
  refs.factTankHeight.textContent = `${number(tankHeight)} cm`;
  const tds = Number(live.tds_ppm ?? fallback.tdsPpm);
  const temp = Number(live.temperature_c ?? fallback.tempC);
  refs.factTds.textContent = Number.isFinite(tds) ? `${number(tds)} ppm` : "—";
  refs.factTemp.textContent = Number.isFinite(temp) ? `${number(temp)} °C` : "—";
  refs.factUpdated.textContent = relativeTime(updated);

  const state = pct <= low ? "Low" : pct >= 90 ? "Full" : pct >= 60 ? "Healthy" : pct >= 30 ? "Moderate" : "Watch";
  refs.statusPill.textContent = state;
  refs.statusPill.className = `status-pill status-${state.toLowerCase()}`;
  refs.livePill.classList.toggle("stale", Date.now() - new Date(updated).getTime() > 2 * 3600000);
  refs.livePillText.textContent = `Updated ${relativeTime(updated)}`;

  const trend = analysis.trend;
  refs.tankTrend.hidden = false;
  refs.trendArrow.textContent = trend > 0.1 ? "↑" : trend < -0.1 ? "↓" : "→";
  refs.trendText.textContent = trend > 0.1 ? `Filling +${number(trend)}%` : trend < -0.1 ? `Draining ${number(trend)}%` : "Level steady";
  refs.tankTrend.className = `tank-trend ${trend > .1 ? "trend-up" : trend < -.1 ? "trend-down" : ""}`;
  animateTank(pct);
  renderGauge(pct, low);

  const remaining = capacity * pct / 100;
  const consumedL = litersFromPct(analysis.totalUse);
  const filledL = litersFromPct(analysis.totalFill);
  const forecast = Number.isFinite(analysis.daysRemaining) ? `${number(analysis.daysRemaining, 1)} days` : "Not enough data";
  refs.vitals.innerHTML = [
    ["Available now", capacity ? `${Math.round(remaining).toLocaleString()} L` : `${number(pct)}%`, "water"],
    ["Used in range", capacity ? `${Math.round(consumedL).toLocaleString()} L` : `${number(analysis.totalUse)}%`, "usage"],
    ["Added in range", capacity ? `${Math.round(filledL).toLocaleString()} L` : `${number(analysis.totalFill)}%`, "refill"],
    ["Est. time left", forecast, "forecast"],
    ["Low-water events", String(analysis.lowEpisodes.length), "alert"],
    ["Firmware", device.systeminfo?.firmware || device.tank_live?.firmware || "—", "firmware"],
    ["TDS", Number.isFinite(tds) ? `${number(tds)} ppm` : "—", "water"],
    ["Water temp", Number.isFinite(temp) ? `${number(temp)} °C` : "—", "forecast"]
  ].map(([k, v, icon]) => `<div class="vital"><span class="vital-icon vital-${icon}"></span><span><small>${esc(k)}</small><strong>${esc(v)}</strong></span></div>`).join("");
}

function animateTank(targetPct) {
  const canvas = refs.tankCanvas;
  if (!canvas) return;
  if (tankAnimation) cancelAnimationFrame(tankAnimation);
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 300, height = canvas.clientHeight || 330;
  canvas.width = width * dpr; canvas.height = height * dpr;
  const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const start = performance.now(), from = Number(canvas.dataset.level || 0), duration = 1100;
  function draw(now) {
    const progress = Math.min(1, (now - start) / duration);
    const ease = 1 - Math.pow(1 - progress, 3);
    const pct = from + (targetPct - from) * ease;
    ctx.clearRect(0, 0, width, height);
    const pad = 22, x = pad, y = 20, w = width - pad * 2, h = height - 42, radius = 30;
    roundedPath(ctx, x, y, w, h, radius);
    ctx.save(); ctx.clip();
    const waterY = y + h * (1 - pct / 100);
    const grad = ctx.createLinearGradient(0, waterY, 0, y + h);
    grad.addColorStop(0, "#40d9ff"); grad.addColorStop(.5, "#168fd7"); grad.addColorStop(1, "#075eae");
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, waterY);
    const t = now / 700;
    for (let px = x; px <= x + w; px += 3) {
      const wave = Math.sin((px - x) / 22 + t) * 4 + Math.sin((px - x) / 37 - t * .7) * 2;
      ctx.lineTo(px, waterY + wave);
    }
    ctx.lineTo(x + w, y + h); ctx.closePath(); ctx.fill();
    for (let i = 0; i < 9; i++) {
      const bx = x + ((i * 47 + now / 55) % w);
      const by = y + h - ((i * 71 + now / 22) % Math.max(20, h * pct / 100));
      ctx.fillStyle = `rgba(255,255,255,${.08 + (i % 3) * .03})`;
      ctx.beginPath(); ctx.arc(bx, by, 2 + (i % 3), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    const border = ctx.createLinearGradient(x, y, x + w, y + h);
    border.addColorStop(0, "rgba(255,255,255,.65)"); border.addColorStop(.5, "rgba(90,190,235,.35)"); border.addColorStop(1, "rgba(255,255,255,.55)");
    ctx.strokeStyle = border; ctx.lineWidth = 4; roundedPath(ctx, x, y, w, h, radius); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,.13)"; ctx.lineWidth = 1;
    [25, 50, 75].forEach((mark) => {
      const my = y + h * (1 - mark / 100);
      ctx.beginPath(); ctx.moveTo(x + 9, my); ctx.lineTo(x + 23, my); ctx.stroke();
    });
    if (progress < 1) tankAnimation = requestAnimationFrame(draw);
    else { canvas.dataset.level = targetPct; tankAnimation = requestAnimationFrame((n) => drawWaves(n, targetPct)); }
  }
  function drawWaves(now, pct) {
    canvas.dataset.level = pct;
    const fakeStart = performance.now() - duration;
    draw(fakeStart + duration);
  }
  tankAnimation = requestAnimationFrame(draw);
}
function roundedPath(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}

function renderGauge(pct, low) {
  const c = chartColors();
  const color = pct <= low ? c.red : pct >= 60 ? c.green : c.amber;
  makeChart("gauge", "gaugeChart", {
    type: "doughnut",
    data: { datasets: [{ data: [pct, 100 - pct], backgroundColor: [color, `${c.grid}55`], borderWidth: 0, circumference: 270, rotation: 225, borderRadius: 8 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "78%", animation: { duration: 1000 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    },
    plugins: [{
      id: "gaugeText", afterDraw(chart) {
        const { ctx, chartArea } = chart;
        ctx.save(); ctx.fillStyle = c.text; ctx.textAlign = "center";
        ctx.font = "800 34px 'Plus Jakarta Sans'"; ctx.fillText(`${number(pct, 0)}%`, (chartArea.left + chartArea.right) / 2, (chartArea.top + chartArea.bottom) / 2 + 12);
        ctx.fillStyle = c.muted; ctx.font = "600 11px 'Plus Jakarta Sans'"; ctx.fillText("CURRENT LEVEL", (chartArea.left + chartArea.right) / 2, (chartArea.top + chartArea.bottom) / 2 + 34);
        ctx.restore();
      }
    }]
  });
  refs.gaugeLegend.innerHTML = `<span>Empty</span><span class="gauge-state">${pct <= low ? "Refill recommended" : pct >= 90 ? "Tank is full" : "Normal range"}</span><span>Full</span>`;
}

function renderKpis(a, dateCaption) {
  const capacity = Number(refs.capacityInput.value || 0);
  const items = [
    ["Range", dateCaption, "neutral"],
    ["Current", `${number(a.last.levelPercent)}%`, a.last.levelPercent <= Number(refs.lowThreshold.value) ? "danger" : "good"],
    ["Lowest", `${number(a.min)}%`, "danger"],
    ["Highest", `${number(a.max)}%`, "good"],
    ["Consumed", capacity ? `${Math.round(litersFromPct(a.totalUse)).toLocaleString()} L` : `${number(a.totalUse)}%`, "danger"],
    ["Filled", capacity ? `${Math.round(litersFromPct(a.totalFill)).toLocaleString()} L` : `${number(a.totalFill)}%`, "good"],
    ["Refills", String(a.fillRuns.length), "good"],
    ["Low episodes", String(a.lowEpisodes.length), a.lowEpisodes.length ? "danger" : "neutral"],
    ["Readings", String(a.samples), "neutral"],
    ["TDS now", Number.isFinite(a.lastTds) ? `${number(a.lastTds)} ppm` : "—", "neutral"],
    ["Temp now", Number.isFinite(a.lastTemp) ? `${number(a.lastTemp)} °C` : "—", "neutral"]
  ];
  refs.kpiStrip.innerHTML = `<div class="kpi-grid">${items.map(([k, v, tone]) =>
    `<div class="kpi-card card card-wtm kpi-${tone}"><small>${esc(k)}</small><strong>${esc(v)}</strong></div>`).join("")}</div>`;
}

function downsampleRows(rows, maxPoints = 720) {
  if (rows.length <= maxPoints) return rows;
  const step = Math.ceil(rows.length / maxPoints);
  const out = [];
  for (let i = 0; i < rows.length; i += step) out.push(rows[i]);
  if (out.at(-1) !== rows.at(-1)) out.push(rows.at(-1));
  return out;
}

function renderTimeline(rows) {
  const c = chartColors();
  const labels = rows.map((r) => formatDateTime(r.timestamp));
  const segmentColor = (ctx) => {
    const d = (ctx.p1?.parsed?.y ?? 0) - (ctx.p0?.parsed?.y ?? 0);
    return d > .15 ? c.green : d < -.15 ? c.red : c.blue;
  };
  makeChart("timeline", "timelineChart", {
    type: "line",
    data: { labels, datasets: [{
      label: "Water level", data: rows.map((r) => r.levelPercent), fill: true,
      borderColor: c.blue, backgroundColor: `${c.blue}18`, borderWidth: 3,
      pointRadius: rows.length < 80 ? 2 : 0, pointHoverRadius: 5, tension: .18,
      segment: { borderColor: segmentColor }
    }] },
    options: {
      ...baseOptions("Tank level %", { beginAtZero: false }),
      scales: {
        x: { ticks: { color: c.muted, maxTicksLimit: 10, callback(value) { const label = this.getLabelForValue(value); return label.split(", ").at(-1); } }, grid: { color: `${c.grid}55` } },
        y: { min: 0, max: 100, ticks: { color: c.muted, callback: (v) => `${v}%` }, grid: { color: `${c.grid}55` } }
      },
      plugins: {
        ...baseOptions().plugins,
        tooltip: { callbacks: { label: (ctx) => ` Level: ${number(ctx.parsed.y)}% (≈ ${Math.round(litersFromPct(ctx.parsed.y))} L)` } }
      }
    }
  });
}

function renderCharts(rows, a) {
  const c = chartColors();
  const plotted = downsampleRows(rows);
  renderTimeline(plotted);
  makeChart("hourly", "hourlyChart", {
    type: "bar", data: { labels: a.hourly.map((_, h) => `${String(h).padStart(2, "0")}:00`), datasets: [{
      label: "Consumed %", data: a.hourly, backgroundColor: a.hourly.map((v) => v ? `${c.red}c8` : `${c.grid}35`), borderRadius: 6
    }] }, options: baseOptions("Level consumed %")
  });
  makeChart("todPie", "todPieChart", {
    type: "doughnut", data: { labels: ["Night 12–6", "Morning 6–12", "Afternoon 12–6", "Evening 6–12"], datasets: [{
      data: a.timeParts, backgroundColor: [c.purple, c.amber, c.blue, c.green], borderWidth: 0, hoverOffset: 8
    }] }, options: donutOptions(c)
  });
  makeChart("flow", "flowChart", {
    type: "bar", data: { labels: a.steps.map((s) => formatTime(s.to)), datasets: [{
      label: "Level change %", data: a.steps.map((s) => s.delta),
      backgroundColor: a.steps.map((s) => s.delta >= 0 ? `${c.green}c8` : `${c.red}c8`), borderRadius: 4
    }] }, options: baseOptions("Change %")
  });
  renderTopEvents(a, c);
  renderDaily(a, c);
  const stored = clamp(a.totalFill - a.totalUse, 0, 100);
  makeChart("activity", "activityDonut", {
    type: "doughnut", data: { labels: ["Consumed", "Filled", "Net stored"], datasets: [{
      data: [a.totalUse, a.totalFill, stored], backgroundColor: [c.red, c.green, c.blue], borderWidth: 0, hoverOffset: 8
    }] }, options: donutOptions(c)
  });
  const rose = Array(8).fill(0);
  a.hourly.forEach((v, h) => { rose[Math.floor(h / 3)] += v; });
  makeChart("rose", "roseChart", {
    type: "polarArea", data: { labels: ["12–3a", "3–6a", "6–9a", "9–12p", "12–3p", "3–6p", "6–9p", "9–12a"], datasets: [{
      data: rose, backgroundColor: [c.purple, `${c.purple}99`, c.amber, `${c.amber}99`, c.blue, `${c.blue}99`, c.green, `${c.green}99`], borderWidth: 0
    }] }, options: { responsive: true, maintainAspectRatio: false, scales: { r: { ticks: { display: false }, grid: { color: `${c.grid}70` }, pointLabels: { color: c.muted } } }, plugins: donutOptions(c).plugins }
  });
  makeChart("cumulative", "cumulativeChart", {
    type: "line", data: { labels: a.cumulative.labels, datasets: [
      { label: "Consumed %", data: a.cumulative.use, borderColor: c.red, backgroundColor: `${c.red}22`, fill: true, pointRadius: 0, tension: .25 },
      { label: "Filled %", data: a.cumulative.fill, borderColor: c.green, backgroundColor: `${c.green}18`, fill: true, pointRadius: 0, tension: .25 }
    ] }, options: baseOptions("Cumulative %")
  });
  makeChart("distance", "distanceChart", {
    type: "line", data: { labels: plotted.map((r) => formatTime(r.timestamp)), datasets: [{
      label: "Air gap cm", data: plotted.map((r) => r.distanceCm), borderColor: c.purple, backgroundColor: `${c.purple}18`, fill: true, pointRadius: 1, tension: .2
    }] }, options: baseOptions("Distance cm", { beginAtZero: false })
  });
  makeChart("tds", "tdsChart", {
    type: "line", data: { labels: plotted.map((r) => formatTime(r.timestamp)), datasets: [{
      label: "TDS ppm", data: plotted.map((r) => Number.isFinite(r.tdsPpm) ? r.tdsPpm : null),
      borderColor: c.amber, backgroundColor: `${c.amber}22`, fill: true, pointRadius: 1, spanGaps: true, tension: .2
    }] }, options: baseOptions("TDS ppm", { beginAtZero: true })
  });
  makeChart("temp", "tempChart", {
    type: "line", data: { labels: plotted.map((r) => formatTime(r.timestamp)), datasets: [{
      label: "Temperature °C", data: plotted.map((r) => Number.isFinite(r.tempC) ? r.tempC : null),
      borderColor: c.green, backgroundColor: `${c.green}22`, fill: true, pointRadius: 1, spanGaps: true, tension: .2
    }] }, options: baseOptions("Temperature °C", { beginAtZero: false })
  });
  makeChart("gaps", "gapsChart", {
    type: "bar", data: { labels: a.gapLabels, datasets: [{
      label: "Minutes since prior reading", data: a.gaps,
      backgroundColor: a.gaps.map((g) => g > 60 ? `${c.red}bb` : g > 35 ? `${c.amber}bb` : `${c.blue}99`), borderRadius: 4
    }] }, options: baseOptions("Minutes")
  });
}
function donutOptions(c) {
  return { responsive: true, maintainAspectRatio: false, cutout: "62%", plugins: {
    legend: { position: "bottom", labels: { color: c.text, usePointStyle: true, pointStyle: "circle", padding: 16 } }
  }};
}
function renderTopEvents(a, c) {
  const topFills = [...a.fillRuns].sort((x, y) => y.percent - x.percent).slice(0, 8).reverse();
  const topDrains = [...a.drainRuns].sort((x, y) => y.percent - x.percent).slice(0, 8).reverse();
  [["topFills", "topFillsChart", topFills, c.green], ["topDrains", "topDrainsChart", topDrains, c.red]].forEach(([name, id, arr, color]) => {
    makeChart(name, id, {
      type: "bar", data: {
        labels: arr.length ? arr.map((e) => formatDateTime(e.to)) : ["No events"],
        datasets: [{ data: arr.length ? arr.map((e) => e.percent) : [0], backgroundColor: `${color}bb`, borderRadius: 5 }]
      }, options: { ...baseOptions("Level %"), indexAxis: "y", plugins: { legend: { display: false } } }
    });
  });
}
function renderDaily(a, c) {
  makeChart("daily", "dailyChart", {
    data: { labels: a.daily.map((d) => d.label), datasets: [
      { type: "bar", label: "Filled %", data: a.daily.map((d) => d.fill), backgroundColor: `${c.green}b8`, borderRadius: 5 },
      { type: "bar", label: "Consumed %", data: a.daily.map((d) => d.use), backgroundColor: `${c.red}b8`, borderRadius: 5 },
      { type: "line", label: "Closing level %", data: a.daily.map((d) => d.close), borderColor: c.blue, pointBackgroundColor: c.blue, borderWidth: 3, tension: .25, yAxisID: "y1" }
    ] }, options: {
      ...baseOptions("Daily movement %"),
      scales: {
        x: { ticks: { color: c.muted, maxRotation: 25 }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: c.muted }, grid: { color: `${c.grid}60` } },
        y1: { min: 0, max: 100, position: "right", ticks: { color: c.blue, callback: (v) => `${v}%` }, grid: { display: false } }
      }
    }
  });
}

function eventCard(event, kind) {
  const up = kind === "fill";
  return `<article class="event-item event-${kind}">
    <span class="event-badge">${up ? "↑ Refill" : "↓ Draw-down"}</span>
    <div class="event-main"><strong>${up ? "+" : "−"}${number(event.percent)}%</strong><span>≈ ${Math.round(event.liters).toLocaleString()} L</span></div>
    <div class="event-levels"><span>${number(event.startLevel)}%</span><i></i><span>${number(event.endLevel)}%</span></div>
    <div class="event-meta"><span>${formatDateTime(event.from)}</span><span>${durationText(event.minutes)}</span></div>
  </article>`;
}
function renderEvents(a) {
  const fills = [...a.fillRuns].sort((x, y) => new Date(y.to) - new Date(x.to));
  const drains = [...a.drainRuns].sort((x, y) => new Date(y.to) - new Date(x.to));
  refs.fillEvents.innerHTML = fills.length ? fills.map((e) => eventCard(e, "fill")).join("") : emptyState("No refill events in this range.");
  refs.drainEvents.innerHTML = drains.length ? drains.map((e) => eventCard(e, "drain")).join("") : emptyState("No significant draw-down events in this range.");
  refs.lowEvents.innerHTML = a.lowEpisodes.length ? a.lowEpisodes.map((e) =>
    `<article class="event-item event-low"><span class="event-badge">Low water</span>
      <div class="event-main"><strong>${number(e.min)}%</strong><span>lowest level</span></div>
      <div class="event-meta"><span>${formatDateTime(e.from)} → ${formatDateTime(e.to)}</span><span>${durationText(e.minutes)}</span></div>
    </article>`).join("") : emptyState("Tank did not cross the low-water threshold in this range.");
}
function emptyState(text) { return `<div class="empty-state"><span class="empty-drop"></span><p>${esc(text)}</p></div>`; }

function renderInsights(a, caption) {
  const capacity = Number(refs.capacityInput.value || 0);
  const peakHour = a.hourly.indexOf(Math.max(...a.hourly));
  const biggestFill = [...a.fillRuns].sort((x, y) => y.percent - x.percent)[0];
  const biggestDrain = [...a.drainRuns].sort((x, y) => y.percent - x.percent)[0];
  const items = [
    { tone: "info", title: "Current picture", text: `The tank is at ${number(a.last.levelPercent)}%${capacity ? ` (about ${Math.round(litersFromPct(a.last.levelPercent)).toLocaleString()} litres)` : ""}. During ${caption}, it moved between ${number(a.min)}% and ${number(a.max)}%.` },
    { tone: "use", title: "Usage pattern", text: a.totalUse > 0 ? `About ${number(a.totalUse)}%${capacity ? ` (${Math.round(litersFromPct(a.totalUse)).toLocaleString()} L)` : ""} was consumed. The busiest usage hour started around ${String(peakHour).padStart(2, "0")}:00.` : "No measurable water consumption was detected in this range." },
    { tone: "fill", title: "Refilling", text: biggestFill ? `${a.fillRuns.length} refill event(s) detected. The largest added ${number(biggestFill.percent)}% (about ${Math.round(biggestFill.liters).toLocaleString()} L) starting ${formatDateTime(biggestFill.from)}.` : "No significant refill was detected." },
    { tone: "alert", title: "Low-water risk", text: a.lowEpisodes.length ? `The tank entered the low zone ${a.lowEpisodes.length} time(s), reaching ${number(a.min)}%. Consider scheduling refills before the most common high-use period.` : `The tank stayed above the ${number(refs.lowThreshold.value, 0)}% low-water threshold.` },
    { tone: "forecast", title: "Simple forecast", text: Number.isFinite(a.daysRemaining) ? `At the observed average use rate, the current water may last about ${number(a.daysRemaining, 1)} days. This is an estimate and changes with household use and refills.` : "There is not enough consumption data to estimate days remaining." },
    { tone: "data", title: "Data quality", text: `${a.samples} readings were analyzed. Typical reporting gap was ${durationText(a.medianGap)}; the longest was ${durationText(a.maxGap)}.` },
    { tone: "info", title: "Water quality", text: [
      Number.isFinite(a.lastTds) ? `Latest TDS is ${number(a.lastTds)} ppm` : "TDS is not in this range",
      Number.isFinite(a.avgTds) ? `(average ${number(a.avgTds)} ppm)` : "",
      Number.isFinite(a.lastTemp) ? `latest water temperature is ${number(a.lastTemp)} °C` : "temperature was not reported"
    ].filter(Boolean).join("; ") + "." }
  ];
  refs.insightList.innerHTML = items.map((i) => `<li class="insight-${i.tone}"><strong>${esc(i.title)}</strong><span>${esc(i.text)}</span></li>`).join("");
  refs.sparseNote.hidden = a.maxGap <= 90;
  refs.sparseNote.textContent = `Some readings are ${durationText(a.maxGap)} apart. Charts hold the last known level between uploads; long gaps reduce event timing precision.`;
}

function flattenLog(obj) {
  return Object.values(obj || {}).map((e) => ({
    time: e.time || e.timestamp, type: e.type || "—", message: e.message || "",
    tds: e.tds_ppm, temp: e.temperature_c
  })).filter((e) => e.time).sort((a, b) => new Date(b.time) - new Date(a.time));
}
function renderDeviceTab(device) {
  const makeDl = (obj) => Object.entries(obj || {}).map(([k, v]) =>
    `<dt class="col-sm-5 text-wtm-muted">${esc(k)}</dt><dd class="col-sm-7">${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd>`).join("") || "<dd>No data.</dd>";
  refs.bootstrapDl.innerHTML = makeDl(device.bootstrap);
  refs.configDl.innerHTML = makeDl(device.config);
  refs.firmwarePre.textContent = JSON.stringify(device.firmware || {}, null, 2);
  const renderRows = (rows, empty) => rows.length ? rows.map((r) =>
    `<tr><td class="text-nowrap">${formatDateTime(r.time)}</td><td><span class="badge bg-info text-dark">${esc(r.type)}</span></td><td>${esc(r.message)}</td><td>${Number.isFinite(Number(r.tds)) ? `${number(Number(r.tds))} ppm` : "—"}</td><td>${Number.isFinite(Number(r.temp)) ? `${number(Number(r.temp))} °C` : "—"}</td></tr>`).join("")
    : `<tr><td colspan="5" class="text-wtm-muted px-3 py-4">${empty}</td></tr>`;
  refs.logsBody.innerHTML = renderRows(flattenLog(device.logs), "No logs.");
  refs.errorsBody.innerHTML = renderRows(flattenLog(device.errors), "No errors.");
}

function tankHeightFromDevice(device) {
  return Number(device.bootstrap?.tank_height_cm ?? device.config?.tank_height ?? 120);
}
function reportCaption(keys) {
  if (!keys.length) return "No range";
  return keys.length === 1 ? formatDateKey(keys[0]) : `${formatDateKey(keys[0])} – ${formatDateKey(keys.at(-1))}`;
}
function refreshReport() {
  const id = refs.deviceSelect.value, device = devicesPayload[id];
  if (!device) return;
  const rows = rowsForSelection(device);
  renderDeviceTab(device);
  if (!rows.length) {
    refs.statusText.textContent = "No readings in this time range.";
    refs.kpiStrip.innerHTML = "";
    refs.insightList.innerHTML = `<li>${emptyState("No readings in this range.")}</li>`;
    destroyCharts();
    return;
  }
  const threshold = Number(refs.changeThreshold.value || 2);
  const low = Number(refs.lowThreshold.value || 20);
  const a = analyze(rows, threshold, low);
  const keys = selectedDateKeys();
  const caption = reportCaption(keys);
  renderLiveTank(device, a, tankHeightFromDevice(device));
  renderKpis(a, caption);
  renderCharts(rows, a);
  renderEvents(a);
  renderInsights(a, caption);
  refs.statusText.textContent = `${a.samples} readings · ${caption} · latest ${formatDateTime(a.last.timestamp)}`;
}

function syncDateSelectorsForDevice(device) {
  availableDates = Object.keys(device?.history || {}).filter((k) => DATE_KEY_REGEX.test(k))
    .sort((a, b) => toDateObject(b) - toDateObject(a));
  const opts = availableDates.map((k) => `<option value="${esc(k)}">${formatDateKey(k)}</option>`).join("");
  refs.dateSelect.innerHTML = opts;
  refs.fromDate.innerHTML = opts;
  refs.toDate.innerHTML = opts;
  if (availableDates.length) {
    refs.dateSelect.value = availableDates[0];
    refs.fromDate.value = availableDates.at(-1);
    refs.toDate.value = availableDates[0];
  }
  refs.changeThreshold.value = Number(device.bootstrap?.threshold ?? device.config?.threshold ?? 2);
}
function populateDeviceDropdown(ids) {
  const selected = loadJson(STORAGE.selectedDevice, ids[0]);
  refs.deviceSelect.innerHTML = ids.map((id) => {
    const name = devicesPayload[id]?.bootstrap?.tank_name || id;
    return `<option value="${esc(id)}">${esc(name)}</option>`;
  }).join("");
  if (ids.includes(selected)) refs.deviceSelect.value = selected;
}
function applyDevicesMap(map) {
  devicesPayload = map || {};
  const ids = Object.keys(devicesPayload).sort();
  if (!ids.length) return;
  populateDeviceDropdown(ids);
  syncDateSelectorsForDevice(devicesPayload[refs.deviceSelect.value]);
  refreshReport();
}
function updateModeVisibility() {
  const mode = refs.reportMode.value;
  document.querySelectorAll(".mode-single").forEach((el) => el.classList.toggle("d-none", mode !== "single"));
  document.querySelectorAll(".mode-custom").forEach((el) => el.classList.toggle("d-none", mode !== "custom"));
}
function scheduleAutoRefresh() {
  clearInterval(autoRefreshTimer);
  if (refs.autoRefreshToggle.checked) {
    autoRefreshTimer = setInterval(() => syncDevicesFromFirebase({ quiet: true }).catch(() => {}), 60000);
  }
}
function wireEvents() {
  refs.deviceSelect.addEventListener("change", () => {
    saveJson(STORAGE.selectedDevice, refs.deviceSelect.value);
    syncDateSelectorsForDevice(devicesPayload[refs.deviceSelect.value]);
    refreshReport();
  });
  refs.reportMode.addEventListener("change", () => { updateModeVisibility(); refreshReport(); });
  [refs.dateSelect, refs.fromDate, refs.toDate, refs.changeThreshold, refs.lowThreshold,
    refs.capacityInput, refs.startTime, refs.endTime].forEach((el) => el.addEventListener("change", () => {
      saveJson(STORAGE.capacity, Number(refs.capacityInput.value));
      saveJson(STORAGE.lowThreshold, Number(refs.lowThreshold.value));
      refreshReport();
    }));
  refs.refreshBtn.addEventListener("click", refreshReport);
  const sync = () => syncDevicesFromFirebase().catch((e) => { refs.statusText.textContent = `Firebase: ${e.message}`; });
  refs.syncDevicesBtn.addEventListener("click", sync);
  refs.fetchFirebaseBtn.addEventListener("click", sync);
  refs.saveAllowlistBtn.addEventListener("click", () => { saveJson(STORAGE.allowlist, getAllowlist()); sync(); });
  refs.themeSelect.addEventListener("change", () => {
    document.documentElement.dataset.theme = refs.themeSelect.value;
    saveJson(STORAGE.theme, refs.themeSelect.value);
    refreshReport();
  });
  refs.autoRefreshToggle.addEventListener("change", scheduleAutoRefresh);
  document.querySelectorAll('[data-bs-toggle="tab"]').forEach((tab) => tab.addEventListener("shown.bs.tab", () => {
    Object.values(charts).forEach((chart) => chart?.resize());
  }));
  window.addEventListener("resize", () => {
    const device = devicesPayload[refs.deviceSelect.value];
    if (device) refreshReport();
  }, { passive: true });
}
async function init() {
  const theme = loadJson(STORAGE.theme, "ocean");
  document.documentElement.dataset.theme = theme;
  refs.themeSelect.value = theme;
  refs.firebaseBaseInput.value = loadJson(STORAGE.firebaseBase, DEFAULT_FIREBASE_BASE);
  refs.allowlistInput.value = loadJson(STORAGE.allowlist, []).join("\n");
  refs.capacityInput.value = loadJson(STORAGE.capacity, 1000);
  refs.lowThreshold.value = loadJson(STORAGE.lowThreshold, 20);
  updateModeVisibility();
  wireEvents();
  scheduleAutoRefresh();
  try { await syncDevicesFromFirebase(); }
  catch (e) {
    const cached = loadJson(STORAGE.devicesCache, null);
    if (cached && Object.keys(cached).length) {
      applyDevicesMap(cached);
      refs.statusText.textContent = `Firebase unavailable (${e.message}) · showing cached data.`;
    } else refs.statusText.textContent = `Firebase: ${e.message}`;
  }
}
init();

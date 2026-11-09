/** Hand-drawn canvas charts — no chart library. */
const reduceMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function drawHomeLine(canvas, points, marks, startValue) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!points || points.length < 1) {
    ctx.strokeStyle = "rgba(235,235,245,0.3)";
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(16, h * 0.55);
    ctx.lineTo(w - 16, h * 0.55);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(235,235,245,0.6)";
    ctx.font = "13px -apple-system, system-ui, sans-serif";
    ctx.fillText("Waiting for the first trade", 16, h * 0.55 - 12);
    return;
  }
  const vals = points.map((p) => p.v);
  const min = Math.min(...vals, startValue ?? vals[0]);
  const max = Math.max(...vals, startValue ?? vals[0]);
  const pad = (max - min) * 0.08 || 1;
  const yMin = min - pad;
  const yMax = max + pad;
  const xAt = (i) => 16 + (i / Math.max(1, points.length - 1)) * (w - 32);
  const yAt = (v) => h - 20 - ((v - yMin) / (yMax - yMin)) * (h - 40);

  // gradient fill under line (spec allows fill under home line)
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "rgba(0,211,90,0.28)");
  g.addColorStop(1, "rgba(0,211,90,0)");
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xAt(i), y = yAt(p.v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(xAt(points.length - 1), h);
  ctx.lineTo(xAt(0), h);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();

  // start dashed
  if (startValue != null) {
    ctx.strokeStyle = "rgba(235,235,245,0.3)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(16, yAt(startValue));
    ctx.lineTo(w - 16, yAt(startValue));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = "#00d35a";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xAt(i), y = yAt(p.v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // marks
  (marks || []).forEach((m, mi) => {
    const i = Math.min(points.length - 1, Math.max(0, m.i ?? 0));
    const x = xAt(i);
    const y = yAt(points[i].v) - 14 - mi * 16;
    ctx.fillStyle = m.color || "#0a84ff";
    ctx.font = "11px -apple-system, system-ui, sans-serif";
    ctx.fillText(m.text, Math.min(x, w - 80), y);
  });
}

export function drawCandles(canvas, candles) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!candles || !candles.length) {
    ctx.fillStyle = "rgba(235,235,245,0.6)";
    ctx.font = "13px -apple-system, system-ui, sans-serif";
    ctx.fillText("No candles yet", 16, h / 2);
    return;
  }
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const yMin = Math.min(...lows);
  const yMax = Math.max(...highs);
  const pad = (yMax - yMin) * 0.08 || 1e-9;
  const yAt = (v) => 10 + ((yMax + pad - v) / (yMax - yMin + 2 * pad)) * (h - 36);
  const bw = Math.max(2, (w - 32) / candles.length - 2);
  candles.forEach((c, i) => {
    const x = 16 + i * ((w - 32) / candles.length) + bw / 2;
    const up = c.c >= c.o;
    ctx.strokeStyle = up ? "#00d35a" : "#ff453a";
    ctx.fillStyle = up ? "#00d35a" : "#ff453a";
    ctx.beginPath();
    ctx.moveTo(x, yAt(c.h));
    ctx.lineTo(x, yAt(c.l));
    ctx.stroke();
    const top = yAt(Math.max(c.o, c.c));
    const bot = yAt(Math.min(c.o, c.c));
    ctx.fillRect(x - bw / 2, top, bw, Math.max(1, bot - top));
  });
}

export function drawScoreRing(canvas, score) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const size = Math.min(canvas.clientWidth, canvas.clientHeight) || 80;
  canvas.width = Math.floor(size * dpr);
  canvas.height = Math.floor(size * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2, r = size * 0.36;
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#2c2c2e";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  ctx.strokeStyle = s >= 70 ? "#00d35a" : "#ffd60a";
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (s / 100) * Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = `600 ${Math.floor(size * 0.22)}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(Math.round(s)), cx, cy);
}

export { reduceMotion };

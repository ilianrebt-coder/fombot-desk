import { coinUrl, profileUrl, SIGNUP_URL } from "./links.js";
import { drawHomeLine, drawCandles, drawScoreRing, reduceMotion } from "./chart.js";

const SUPABASE_URL = "https://zklfaarybftuzmahhsxj.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Vz5OH--mu3dM_5proQFTEg_WkzrJTQX";
const REDIRECT = "https://ilianrebt-coder.github.io/fombot-desk/";
const AGENTS = ["scanner", "auditor", "analyst", "executor", "risk"];
const LAYER_LABELS = {
  1: "Mint authority",
  2: "Freeze authority",
  3: "Dev wallet",
  4: "Top 10 holders",
  5: "Liquidity",
  6: "Pool age",
  7: "Bundled",
  8: "Delegations",
};
const LEGACY_LAYER_TOKENS = ["top_holder", "lp_locked", "tradeable", "holders"];

const params = new URLSearchParams(location.search);
const MOCK_MODE = params.get("mock") === "1"; // local screenshots only — never ship enabled

const state = {
  session: null,
  owner: false,
  tab: "home",
  sub: null, // auditor | coin
  desk: null,
  scans: [],
  audits: [],
  verdicts: [],
  activity: [],
  positions: [],
  settings: {},
  chart: [],
  balancePoints: [],
  chartRange: "LIVE",
  searchQ: "",
  nightStart: null,
  err: null,
  cmdResult: "",
  loading: true,
  unread: false,
};

let sb = null;
let channels = [];
let refetchTimer = null;

const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");
const tabbar = $("#tabbar");
const errEl = $("#err");

function chartForRange(range) {
  const pts = state.balancePoints || [];
  const now = Date.now();
  const spans = { LIVE: 15 * 60e3, "1H": 3600e3, "4H": 4 * 3600e3, "1D": 86400e3, "1W": 7 * 86400e3, ALL: Infinity };
  const span = spans[range] ?? spans.LIVE;
  const filtered = pts.filter((p) => span === Infinity || now - new Date(p.t).getTime() <= span);
  if (filtered.length) return filtered.map((p, i) => ({ t: i, v: p.v, ts: p.t }));
  const bal = Number(state.desk?.balance) || 0;
  return Array.from({ length: 20 }, (_, i) => ({ t: i, v: bal }));
}

function escapeAttr(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function money(n) {
  const v = Number(n) || 0;
  return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(n) {
  const v = Number(n) || 0;
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}
function shortMint(m) {
  if (!m) return "";
  return m.length > 10 ? m.slice(0, 4) + "…" + m.slice(-4) : m;
}
function isLegacyAudit(a) {
  const text = String(a?.layers || "");
  if (text.startsWith("legacy audit")) return true;
  return LEGACY_LAYER_TOKENS.some((tok) => text.includes(tok));
}

function fmtLiq(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  if (Math.abs(v) >= 1000) return `liq $${(v / 1000).toFixed(1)}K`;
  return `liq $${v.toFixed(0)}`;
}

function formatLayerValue(n, status, detail) {
  if (detail == null || detail === "") return "";
  const s = String(detail);
  if (s.startsWith("liq ") || s.includes("%") || s.includes(" · ") || s === "Revoked" || s === "None") return s;
  if (/wallet/i.test(s) || /hold/i.test(s) || /revoked|sold|supply|data/i.test(s)) return s;
  const num = Number(s);
  if (!Number.isFinite(num)) return s;
  // Legacy: L4 was liquidity USD, L5 lp_locked pct, L7 bundled, L8 holders count
  if (n === 7) return num === 0 ? "None" : String(Number.isInteger(num) ? num : num);
  if (n === 8) return String(Math.round(num));
  if (n === 4 && num > 100) return fmtLiq(num);
  if (n === 5 && num > 100) return fmtLiq(num);
  if (n === 4 || n === 5) return num <= 100 ? `${num.toFixed(num < 10 ? 1 : 0)}%` : fmtLiq(num);
  if (n === 3 && num <= 100) return `${num.toFixed(1)}%`;
  return s;
}

function parseLayers(text) {
  if (!text) return [];
  const lines = String(text).split("\n").filter((l) => l && !l.startsWith("legacy audit"));
  const byN = {};
  for (const line of lines) {
    const m = line.match(/^L(\d+)\s+([^:]+):\s+(\S+)(?:\s*·\s*(.*))?/);
    if (!m) continue;
    const n = +m[1];
    byN[n] = {
      n,
      name: LAYER_LABELS[n] || m[2].trim(),
      status: m[3],
      detail: formatLayerValue(n, m[3], m[4] || ""),
      rawName: m[2].trim(),
    };
  }
  // Always return 1..8 with spec labels
  return [1, 2, 3, 4, 5, 6, 7, 8].map((n) => byN[n] || { n, name: LAYER_LABELS[n], status: "not checked", detail: "" });
}

function setError(msg) {
  state.err = msg;
  if (!msg) {
    errEl.classList.add("hidden");
    errEl.textContent = "";
  } else {
    errEl.classList.remove("hidden");
    errEl.textContent = msg;
  }
}

function odometerHtml(value) {
  const s = money(value);
  if (reduceMotion()) return `<span class="balance tabular">${s}</span>`;
  return (
    `<span class="balance tabular odometer">` +
    [...s]
      .map((ch, i) =>
        /\d/.test(ch)
          ? `<span class="odigit" style="animation-delay:${(s.length - i) * 30}ms">${ch}</span>`
          : `<span>${ch}</span>`
      )
      .join("") +
    `</span>`
  );
}

/* ---------- Auth / data ---------- */
function initClient() {
  if (MOCK_MODE) return null;
  if (!window.supabase) throw new Error("supabase-js missing");
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

async function checkOwner(session) {
  if (!session) return false;
  const { data, error } = await sb.from("owner_allowlist").select("email").limit(1);
  if (error) {
    // RLS: non-owner gets empty / error
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

async function loadAll() {
  if (MOCK_MODE) {
    const { MOCK } = await import("./mock-data.js");
    state.desk = MOCK.desk_state;
    state.scans = MOCK.scans;
    state.audits = MOCK.audits;
    state.verdicts = MOCK.verdicts;
    state.activity = MOCK.activity;
    state.positions = MOCK.positions;
    state.settings = MOCK.settings;
    state.balancePoints = MOCK.balance_points || MOCK.chart.map((p, i) => ({ t: new Date(Date.now() - (MOCK.chart.length - i) * 60000).toISOString(), v: p.v }));
    state.chart = chartForRange(state.chartRange);
    state.nightStart = MOCK.night_start;
    state.candles = MOCK.candles;
    state.loading = false;
    state.owner = true;
    state.session = { user: { email: "mock@local" } };
    setError(null);
    return;
  }
  try {
    const [desk, scans, audits, verdicts, activity, positions, settings, balPts] = await Promise.all([
      sb.from("desk_state").select("*").eq("id", 1).maybeSingle(),
      sb.from("scans").select("*").order("id", { ascending: false }).limit(40),
      sb.from("audits").select("*").order("id", { ascending: false }).limit(40),
      sb.from("verdicts").select("*").order("id", { ascending: false }).limit(20),
      sb.from("activity").select("*").order("id", { ascending: false }).limit(40),
      sb.from("positions").select("*").order("id", { ascending: false }).limit(20),
      sb.from("settings_view").select("*"),
      sb.from("balance_points").select("*").order("ts", { ascending: true }).limit(2000),
    ]);
    if (desk.error) throw desk.error;
    state.desk = desk.data;
    state.scans = scans.data || [];
    state.audits = audits.data || [];
    state.verdicts = verdicts.data || [];
    state.activity = activity.data || [];
    state.positions = positions.data || [];
    state.settings = Object.fromEntries((settings.data || []).map((r) => [r.key, r.value]));
    state.balancePoints = (balPts.data || []).map((r) => ({ t: r.ts, v: Number(r.balance) }));
    const bal = Number(state.desk?.balance) || 0;
    state.nightStart = state.nightStart ?? (state.balancePoints[0]?.v ?? bal);
    state.chart = chartForRange(state.chartRange);
    state.loading = false;
    setError(null);
  } catch (e) {
    setError(`Desk offline · retrying in 15s · last update ${new Date().toLocaleTimeString()}`);
    throw e;
  }
}

function subscribeRealtime() {
  if (MOCK_MODE || !sb) return;
  teardownRealtime();
  const onChange = () => {
    loadAll().then(render).catch(() => {});
  };
  for (const table of ["desk_state", "scans", "audits", "verdicts", "activity", "positions", "settings_view", "commands", "balance_points"]) {
    const ch = sb
      .channel("desk-" + table)
      .on("postgres_changes", { event: "*", schema: "public", table }, onChange)
      .subscribe();
    channels.push(ch);
  }
  refetchTimer = setInterval(() => {
    loadAll().then(render).catch(() => {});
  }, 15000);
}

function teardownRealtime() {
  channels.forEach((c) => {
    try {
      sb.removeChannel(c);
    } catch (_) {}
  });
  channels = [];
  if (refetchTimer) clearInterval(refetchTimer);
  refetchTimer = null;
}

async function sendMagicLink(email) {
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: REDIRECT },
  });
  if (error) throw error;
}

async function insertCommand(kind, payload) {
  state.cmdResult = "sending…";
  render();
  if (MOCK_MODE) {
    state.cmdResult = `mock ${kind} ok`;
    if (kind === "pause" || kind === "resume") {
      const agent = payload.agent;
      if (state.desk?.paused?.agents) {
        state.desk.paused.agents[agent] = kind === "pause";
      }
    }
    render();
    return;
  }
  const { data, error } = await sb
    .from("commands")
    .insert({ kind, payload, status: "new" })
    .select("*")
    .single();
  if (error) {
    state.cmdResult = "error: " + error.message;
    render();
    return;
  }
  state.cmdResult = "queued #" + data.id;
  render();
  // watch for result
  const watch = sb
    .channel("cmd-" + data.id)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "commands", filter: `id=eq.${data.id}` },
      (payload) => {
        const row = payload.new;
        state.cmdResult = `${row.status}: ${row.result || ""}`;
        render();
        sb.removeChannel(watch);
      }
    )
    .subscribe();
  // also poll
  const t0 = Date.now();
  const poll = setInterval(async () => {
    const { data: row } = await sb.from("commands").select("*").eq("id", data.id).maybeSingle();
    if (row && row.status !== "new") {
      state.cmdResult = `${row.status}: ${row.result || ""}`;
      render();
      clearInterval(poll);
    }
    if (Date.now() - t0 > 60000) clearInterval(poll);
  }, 2000);
}

/* ---------- Views ---------- */
function renderLogin(msg) {
  tabbar.classList.add("hidden");
  app.innerHTML = `
    <div class="login-wrap">
      <h1>Grok Bot</h1>
      <p>Private trading desk. Sign in with the owner email. Magic link opens this app.</p>
      <form id="loginForm">
        <input class="field" type="email" name="email" placeholder="you@email.com" required autocomplete="email" />
        <button class="btn btn-primary" type="submit">Send magic link</button>
      </form>
      <p class="hint" id="loginHint">${msg || ""}</p>
    </div>`;
  $("#loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const email = new FormData(e.target).get("email");
    try {
      await sendMagicLink(String(email));
      $("#loginHint").textContent = "Check your inbox for the magic link.";
    } catch (err) {
      $("#loginHint").textContent = err.message || String(err);
    }
  };
}

function skel() {
  return `<div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
}

function renderSearchResults() {
  const q = state.searchQ.trim().toLowerCase();
  if (!q) return "";
  const hits = [];
  const seen = new Set();
  const push = (mint, name, symbol, where) => {
    if (!mint || seen.has(mint)) return;
    const blob = `${mint} ${name || ""} ${symbol || ""}`.toLowerCase();
    if (!blob.includes(q)) return;
    seen.add(mint);
    hits.push({ mint, name: name || symbol || shortMint(mint), where });
  };
  for (const s of state.scans) push(s.mint, s.name, s.symbol, "scan");
  for (const a of state.audits) push(a.mint, a.name, null, "audit");
  for (const p of state.positions) push(p.mint, p.name, null, "position");
  if (!hits.length) return `<div class="card-list" style="margin:8px 0"><div class="item"><span style="color:var(--sec)">No matches for “${escapeAttr(state.searchQ)}”</span></div></div>`;
  return `<div class="card-list" style="margin:8px 0">${hits.slice(0, 12).map((h) => {
    const open = state.audits.some((a) => a.mint === h.mint) ? "auditor" : "coin";
    return `<button class="item" type="button" data-open="${open}" data-mint="${h.mint}"><span>${h.name}<div class="sub" style="color:var(--sec);font-size:12px">${shortMint(h.mint)} · ${h.where}</div></span><span class="chev">›</span></button>`;
  }).join("")}</div>`;
}

function renderHome() {
  const d = state.desk || {};
  const bal = Number(d.balance) || 0;
  const start = Number(state.nightStart) || bal || 1;
  const todayPct = ((bal - start) / start) * 100;
  const mult = bal / start;
  const mode = d.mode || state.settings.mode || "PAPER";
  const scans = state.scans.slice(0, 6);
  const auditsPass = state.audits.filter((a) => a.status === "pass").length;
  const auditsFail = state.audits.filter((a) => a.status === "fail").length;
  const lastVerd = state.verdicts[0];
  const acts = (state.activity.length ? state.activity : derivedActivity()).slice(0, 5);

  return `
  <div class="screen active" id="scr-home">
    <div class="topnav">
      <button class="avatar" data-go="account" aria-label="Account">GB</button>
      <div class="brand">Grok Bot ›</div>
      <input class="search" placeholder="Search mint / name" id="homeSearch" value="${escapeAttr(state.searchQ)}" />
      <div class="bell" aria-label="Notifications">${state.unread ? '<span class="dot"></span>' : ""}🔔</div>
    </div>
    <div class="balance-row">
      ${odometerHtml(bal)}
      ${mode === "PAPER" ? '<span class="pill pill-orange">PAPER</span>' : ""}
    </div>
    <div><span class="today tabular ${todayPct < 0 ? "neg" : ""}">${pct(todayPct)}</span>
      <span class="pill pill-green" style="margin-left:8px">${mult.toFixed(2)}×</span></div>
    <div class="chart-wrap"><canvas id="homeChart"></canvas></div>
    <div class="ranges" id="ranges">
      ${["LIVE", "1H", "4H", "1D", "1W", "ALL"].map((r) => `<button class="${state.chartRange === r ? "active" : ""}" data-range="${r}">${r}</button>`).join("")}
    </div>
    ${state.searchQ ? renderSearchResults() : ""}
    <div class="section-h"><h2>Agents · 5 running</h2></div>
    <div class="carousel">
      ${agentCardScanner(scans)}
      ${agentCardAuditor(auditsPass, auditsFail)}
      ${agentCardAnalyst(lastVerd)}
      ${agentCardExecutor()}
      ${agentCardRisk()}
    </div>
    <div class="section-h"><h2>Activity</h2><button class="link" data-go="activity">See all</button></div>
    <div class="activity-preview">${acts.map(activityRow).join("") || emptyAct()}</div>
  </div>`;
}

function emptyAct() {
  return `<p style="color:var(--sec)">Nothing yet tonight</p>`;
}
function derivedActivity() {
  // Build activity-like rows from audits/scans when activity table empty
  const rows = [];
  for (const a of state.audits.slice(0, 10)) {
    if (a.status === "fail") {
      rows.push({
        id: "a" + a.id,
        kind: "rejected",
        title: `Rejected ${shortMint(a.mint)}`,
        subtitle: `Auditor · ${a.detail || "layer " + a.fail_layer}`,
        value: "Skipped",
        mint: a.mint,
        open: "auditor",
      });
    }
  }
  for (const s of state.scans.filter((x) => x.status === "kill").slice(0, 8)) {
    rows.push({
      id: "s" + s.id,
      kind: "rejected",
      title: `Killed ${s.symbol || shortMint(s.mint)}`,
      subtitle: `Scanner · ${s.reason || ""}`,
      value: "Skipped",
      mint: s.mint,
      open: "auditor",
    });
  }
  return rows;
}

function activityRow(r) {
  if (r.message && !r.title) {
    const parts = String(r.message).split(" / ");
    r = {
      ...r,
      title: parts[0],
      subtitle: parts.slice(1).join(" · ") || r.kind,
      value: "",
      open: r.kind === "rejected" ? "auditor" : "coin",
    };
  }
  return `<div class="row" data-open="${r.open || "coin"}" data-mint="${r.mint || ""}">
    <div class="t"><div class="title">${r.title}</div><div class="sub">${r.subtitle || ""}</div></div>
    <div class="val">${r.value || ""}</div></div>`;
}

function agentCardScanner(scans) {
  const feed =
    scans
      .map((s) => {
        if (s.status === "kill") {
          return `<div class="feed-row"><span class="strike">${s.symbol || shortMint(s.mint)}</span><span class="kill-reason">${s.reason || ""}</span></div>`;
        }
        return `<div class="feed-row"><span>${s.symbol || shortMint(s.mint)}</span><span style="color:var(--cyan)">→ auditor</span></div>`;
      })
      .join("") || `<div class="meta">Listening for graduations</div>`;
  return `<div class="agent-card" style="border-top:3px solid var(--cyan)">
    <h3>Scanner</h3><div class="meta">${scans.length} pools tonight</div>${feed}</div>`;
}
function agentCardAuditor(pass, fail) {
  return `<div class="agent-card">
    <h3>Auditor</h3>
    <div class="meta">${pass + fail} taken apart · ${fail} rejected</div>
    <div class="meta">${pass ? "8/8 → Executor" : "waiting"}</div>
    <button class="btn btn-card" data-open="auditor" data-mint="${state.audits[0]?.mint || ""}" style="margin-top:12px">Open last</button>
  </div>`;
}
function agentCardAnalyst(v) {
  const score = v ? Math.round((Number(v.score) || 0) * 100) : 0;
  return `<div class="agent-card" style="border-top:3px solid var(--yellow)">
    <h3>Analyst</h3><div class="meta">Scoring</div>
    <canvas id="scoreRing" width="80" height="80" style="width:80px;height:80px"></canvas>
    <div class="meta">${v ? v.decision + " · " + (v.reason || "") : "idle"}</div>
  </div>`;
}
function agentCardExecutor() {
  const pct = state.settings.stack_pct ?? 8;
  const size = ((Number(state.desk?.balance) || 200) * Number(pct)) / 100;
  return `<div class="agent-card" style="border-top:3px solid var(--green)">
    <h3>Executor</h3>
    <div class="meta">${state.positions.filter((p) => p.status === "open").length} open · ${state.trades?.length || 0} trades</div>
    <div class="meta">${money(Math.max(size, 47.5))} · ${pct}% of stack</div>
  </div>`;
}
function agentCardRisk() {
  const stop = state.settings.stop_pct ?? 6;
  const trail = state.settings.trail_pct ?? 12;
  return `<div class="agent-card" style="border-top:3px solid var(--pink)">
    <h3>Risk</h3><div class="meta">Guarding</div>
    <div><span class="pill pill-red mono">stop -${stop}%</span>
    <span class="pill pill-green mono" style="margin-left:6px">trail ${trail}%</span></div>
  </div>`;
}

function renderAgents() {
  const paused = state.desk?.paused?.agents || {};
  return `<div class="screen active" id="scr-agents">
    <div class="topnav"><div class="brand">Agents</div></div>
    ${AGENTS.map((a) => {
      const hb = state.desk?.heartbeats?.[a] || {};
      const isPaused = !!paused[a];
      const count =
        a === "scanner"
          ? state.scans.length
          : a === "auditor"
            ? state.audits.length
            : a === "analyst"
              ? state.verdicts.length
              : a === "executor"
                ? state.positions.length
                : state.positions.filter((p) => p.status === "closed").length;
      const decisions = decisionsFor(a);
      return `<div class="agent-full">
        <div class="head">
          <span class="status-dot ${isPaused ? "paused" : ""}"></span>
          <strong style="flex:1;text-transform:capitalize">${a}</strong>
          <span class="meta tabular" style="color:var(--sec)">${count} today</span>
          <label class="switch"><input type="checkbox" data-agent="${a}" ${isPaused ? "" : "checked"} ${a === "risk" && state.positions.some((p) => p.status === "open") ? "disabled" : ""}/><span class="slider"></span></label>
        </div>
        <div class="meta" style="color:var(--sec);font-size:12px;margin-bottom:8px">${hb.status || "—"} · ${hb.at || ""}</div>
        ${decisions.map((d) => `<div class="dec"><div class="t"><div class="title">${d.t}</div><div class="sub">${d.s}</div></div></div>`).join("") || "<div class=\"meta\">No decisions yet</div>"}
        <button class="btn btn-card" data-go="account" style="margin-top:10px">Settings</button>
      </div>`;
    }).join("")}
    <div class="cmd-result">${state.cmdResult || ""}</div>
  </div>`;
}

function decisionsFor(agent) {
  if (agent === "scanner")
    return state.scans.slice(0, 8).map((s) => ({
      t: `${s.symbol || shortMint(s.mint)} · ${s.status}`,
      s: s.reason || s.ts,
    }));
  if (agent === "auditor")
    return state.audits.slice(0, 8).map((a) => ({
      t: `${shortMint(a.mint)} · ${a.status}`,
      s: a.detail || `layer ${a.fail_layer ?? "—"}`,
    }));
  if (agent === "analyst")
    return state.verdicts.slice(0, 8).map((v) => ({
      t: `${shortMint(v.mint)} · ${v.decision}`,
      s: v.reason || "",
    }));
  return [];
}

function renderActivity() {
  const rows = state.activity.length
    ? state.activity.map((r) => ({
        ...r,
        title: (r.message || "").split(" / ")[0] || r.kind,
        subtitle: (r.message || "").split(" / ").slice(1).join(" · "),
        value: "",
        open: r.kind === "rejected" || r.kind === "sell" ? (r.kind === "rejected" ? "auditor" : "coin") : "coin",
      }))
    : derivedActivity();
  return `<div class="screen active" id="scr-activity">
    <div class="topnav"><div class="brand">Activity</div></div>
    <div class="act-list">${rows.map(activityRow).join("") || emptyAct()}</div>
  </div>`;
}

function renderAccount() {
  const mode = state.desk?.mode || state.settings.mode || "PAPER";
  const handle = state.settings.fomo_handle || "";
  const groups = {
    scanner: ["min_liq_usd", "max_top10_pct", "max_h1_pct", "min_pool_age_min", "max_wait_min", "poll_s"],
    auditor: ["max_dev_pct", "max_top10_pct", "min_lp_locked_pct", "max_bundled", "max_delegated_accounts"],
    analyst: ["analyst_mode"],
    executor: ["stack_pct", "max_pool_pct", "min_ticket_usd", "below_min", "stack_usd"],
    risk: ["stop_pct", "trail_arm_pct", "trail_pct", "timeout_h", "timeout_min_pct", "risk_poll_s"],
    desk: ["mode", "rpc_url", "fomo_handle"],
  };
  return `<div class="screen active" id="scr-account">
    <div class="topnav"><div class="brand">Account</div></div>
    <div class="card-list">
      <div class="item"><span>Mode</span><span class="pill ${mode === "PAPER" ? "pill-orange" : "pill-green"}">${mode}</span></div>
      <div class="item"><span>Stack</span><span class="tabular">${money(state.settings.stack_usd ?? state.desk?.balance)}</span></div>
      <a class="item" href="${profileUrl(handle || "me")}" target="_blank" rel="noopener"><span>Your FOMO profile</span><span class="chev">›</span></a>
      <button class="item" id="inviteBtn" type="button"><span>Invite a friend</span><span class="chev">›</span></button>
    </div>
    <div class="card-list">
      <div class="item"><span>Pause scanner</span><button class="btn btn-card" style="width:auto" data-cmd="pause" data-agent="scanner">Pause</button></div>
      <div class="item"><span>Resume scanner</span><button class="btn btn-card" style="width:auto" data-cmd="resume" data-agent="scanner">Resume</button></div>
      <div class="item"><span>Mode PAPER</span><button class="btn btn-card" style="width:auto" data-cmd="mode" data-mode="PAPER">Set</button></div>
    </div>
    <div class="cmd-result">${state.cmdResult || ""}</div>
    <p class="hint">Pause / resume / mode go through the desk commands queue. Other setting changes go through Telegram (<span class="mono">set &lt;key&gt; to &lt;value&gt;</span>).</p>
    <div class="card-list">
      <div class="item"><span>Telegram</span><span style="color:var(--sec)">connected via desk</span></div>
      <div class="item"><span>Notifications</span><span style="color:var(--ter)">Telegram only (no web push on Pages)</span></div>
      <button class="item" id="signOut" type="button"><span>Sign out</span><span class="chev">›</span></button>
    </div>
    ${Object.entries(groups)
      .map(
        ([g, keys]) => `<div class="settings-group"><h3>${g}</h3>
      ${keys
        .map((k) => {
          const v = state.settings[k];
          return `<div class="set-row"><span>${k}</span><span class="val">${v === undefined || v === null || v === "" ? "—" : String(v)}</span></div>`;
        })
        .join("")}</div>`
      )
      .join("")}
  </div>`;
}

function renderAuditor(mint) {
  const a =
    state.audits.find((x) => x.mint === mint) ||
    state.audits[0] ||
    null;
  if (!a) {
    return `<div class="screen active"><button class="back" data-back>‹ Back</button>
      <p style="color:var(--sec)">No coin taken apart yet</p></div>`;
  }
  const layers = parseLayers(a.layers);
  const legacy = isLegacyAudit(a);
  const rejected = a.status === "fail";
  return `<div class="screen active" id="scr-auditor">
    <button class="back" data-back>‹ Back</button>
    <div class="brand" style="margin-bottom:8px">${shortMint(a.mint)} ${legacy ? '<span class="pill pill-orange" style="font-size:11px;vertical-align:middle">legacy audit</span>' : ""}</div>
    ${legacy ? '<p class="hint" style="margin-top:0">Recorded before the layer-map fix — labels below use the current spec; values are as stored.</p>' : ""}
    <div class="discs" id="discs">
      ${[1, 2, 3, 4, 5, 6, 7, 8]
        .map((n) => {
          const L = layers.find((x) => x.n === n) || { name: LAYER_LABELS[n] };
          return `<div class="disc" data-n="${n}">L${n} ${LAYER_LABELS[n]}</div>`;
        })
        .join("")}
    </div>
    <div class="layer-rows">
      ${layers
        .map((L) =>
          L.n
            ? `<div class="lr"><span>L${L.n} ${LAYER_LABELS[L.n]}</span><span>${L.status}${L.detail ? " · " + L.detail : ""}</span></div>`
            : ""
        )
        .join("")}
    </div>
    <p style="margin:16px 0;font-weight:600">${
      rejected
        ? `Rejected · ${a.detail || "fail"}<br><span style="color:var(--sec);font-weight:400">Grok Bot won’t buy this</span>`
        : `Cleared · 8/8 parts<br><span style="color:var(--sec);font-weight:400">Sent to Executor</span>`
    }</p>
    <a class="btn btn-primary" style="display:block;text-align:center;text-decoration:none"
       href="${coinUrl(a.mint)}" target="_blank" rel="noopener">Open on FOMO</a>
  </div>`;
}

function renderCoin(mint) {
  const scan = state.scans.find((s) => s.mint === mint);
  const pos = state.positions.find((p) => p.mint === mint && p.status === "open");
  const name = scan?.name || scan?.symbol || shortMint(mint);
  const mode = state.desk?.mode || "PAPER";
  const stop = state.settings.stop_pct ?? 6;
  const trail = state.settings.trail_pct ?? 12;
  return `<div class="screen active" id="scr-coin">
    <button class="back" data-back>‹ Back</button>
    <div class="topnav" style="padding-top:0">
      <div class="brand">${name}</div>
      ${mode === "PAPER" ? '<span class="pill pill-orange">PAPER</span>' : ""}
      <span class="pill pill-green">8/8</span>
    </div>
    <div style="color:var(--sec);font-size:13px">${scan?.symbol || "—"} · Solana</div>
    <div class="price-big tabular">${scan?.liq_at_scan != null ? money(scan.liq_at_scan) + " liq" : "—"}</div>
    <div class="chart-wrap" style="height:220px"><canvas id="coinChart"></canvas></div>
    <div class="stats-grid">
      <div class="stat"><div class="k">Status</div><div class="v">${scan?.status || "—"}</div></div>
      <div class="stat"><div class="k">Reason</div><div class="v" style="font-size:13px">${scan?.reason || "—"}</div></div>
      <div class="stat"><div class="k">Liquidity</div><div class="v">${scan?.liq_at_scan != null ? money(scan.liq_at_scan) : "—"}</div></div>
      <div class="stat"><div class="k">Holders</div><div class="v">n/a</div></div>
    </div>
    ${
      pos
        ? `<div class="exit-card">
      <div>Your position · ${money(pos.size_usd)} in · Executor</div>
      <div style="margin-top:8px"><span class="pill pill-red mono">stop -${stop}%</span>
      <span class="pill pill-green mono" style="margin-left:6px">trail ${trail}%</span></div>
    </div>`
        : ""
    }
    <a class="btn btn-primary" style="display:block;text-align:center;text-decoration:none;margin-top:12px"
       href="${coinUrl(mint)}" target="_blank" rel="noopener">${pos ? "Sell on FOMO" : "Buy on FOMO"}</a>
  </div>`;
}

function render() {
  if (!state.session || !state.owner) {
    if (!MOCK_MODE) {
      renderLogin(state.session && !state.owner ? "Signed in, but not on the owner allowlist." : "");
      return;
    }
  }
  if (state.sub === "auditor") {
    tabbar.classList.add("hidden");
    app.innerHTML = state.loading ? skel() : renderAuditor(state.subMint);
    afterPaint();
    wire();
    runAuditBeam();
    return;
  }
  if (state.sub === "coin") {
    tabbar.classList.add("hidden");
    app.innerHTML = state.loading ? skel() : renderCoin(state.subMint);
    afterPaint();
    wire();
    return;
  }
  tabbar.classList.remove("hidden");
  tabbar.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === state.tab);
  });
  if (state.loading) {
    app.innerHTML = skel();
    return;
  }
  const map = {
    home: renderHome,
    agents: renderAgents,
    activity: renderActivity,
    account: renderAccount,
  };
  app.innerHTML = (map[state.tab] || renderHome)();
  afterPaint();
  wire();
}

function afterPaint() {
  const hc = $("#homeChart");
  if (hc) {
    const marks = [];
    drawHomeLine(hc, state.chart, marks, state.nightStart);
  }
  const sr = $("#scoreRing");
  if (sr) {
    const v = state.verdicts[0];
    drawScoreRing(sr, v ? (Number(v.score) || 0) * 100 : 0);
  }
  const cc = $("#coinChart");
  if (cc) drawCandles(cc, state.candles || []);
}

function runAuditBeam() {
  const discs = [...document.querySelectorAll(".disc")];
  if (!discs.length) return;
  const a = state.audits.find((x) => x.mint === state.subMint) || state.audits[0];
  const layers = parseLayers(a?.layers);
  if (reduceMotion()) {
    discs.forEach((d) => {
      const n = +d.dataset.n;
      const L = layers.find((x) => x.n === n);
      d.classList.add(L?.status === "red" ? "bad" : L?.status === "green" ? "ok" : "");
      if (L) d.textContent = `L${n} ${LAYER_LABELS[n]}: ${L.status}`;
    });
    return;
  }
  let i = 0;
  const step = () => {
    if (i >= discs.length) return;
    const d = discs[i];
    d.classList.add("beam");
    const n = +d.dataset.n;
    const L = layers.find((x) => x.n === n);
    setTimeout(() => {
      d.classList.remove("beam");
      if (L?.status === "green") d.classList.add("ok");
      else if (L?.status === "red") d.classList.add("bad");
      if (L) d.textContent = `L${n} ${LAYER_LABELS[n]}: ${L.status}${L.detail ? " · " + L.detail : ""}`;
      i++;
      setTimeout(step, 150);
    }, 350);
  };
  step();
}

function wire() {
  document.querySelectorAll("[data-go]").forEach((el) => {
    el.onclick = () => {
      state.tab = el.dataset.go;
      state.sub = null;
      render();
    };
  });
  document.querySelectorAll("[data-back]").forEach((el) => {
    el.onclick = () => {
      state.sub = null;
      render();
    };
  });
  document.querySelectorAll("[data-open]").forEach((el) => {
    el.onclick = () => {
      state.sub = el.dataset.open;
      state.subMint = el.dataset.mint;
      render();
    };
  });
  document.querySelectorAll("input[data-agent]").forEach((el) => {
    el.onchange = () => {
      const agent = el.dataset.agent;
      insertCommand(el.checked ? "resume" : "pause", { agent });
    };
  });
  document.querySelectorAll("[data-cmd]").forEach((el) => {
    el.onclick = () => {
      const kind = el.dataset.cmd;
      if (kind === "mode") insertCommand("mode", { mode: el.dataset.mode });
      else insertCommand(kind, { agent: el.dataset.agent });
    };
  });
  const invite = $("#inviteBtn");
  if (invite) {
    invite.onclick = async () => {
      try {
        if (navigator.share) await navigator.share({ title: "FOMO", url: SIGNUP_URL });
        else {
          await navigator.clipboard.writeText(SIGNUP_URL);
          state.cmdResult = "Link copied";
          render();
        }
      } catch (_) {
        await navigator.clipboard.writeText(SIGNUP_URL);
        state.cmdResult = "Link copied";
        render();
      }
    };
  }
  const so = $("#signOut");
  if (so && !MOCK_MODE) {
    so.onclick = async () => {
      await sb.auth.signOut();
      state.session = null;
      state.owner = false;
      teardownRealtime();
      render();
    };
  }
  const search = $("#homeSearch");
  if (search) {
    search.oninput = () => {
      state.searchQ = search.value || "";
      // re-render results without losing focus: patch results container if present
      render();
      const again = $("#homeSearch");
      if (again) {
        again.focus();
        const v = again.value;
        again.setSelectionRange(v.length, v.length);
      }
    };
  }
  document.querySelectorAll("[data-range]").forEach((b) => {
    b.onclick = () => {
      state.chartRange = b.dataset.range;
      state.chart = chartForRange(state.chartRange);
      render();
    };
  });
}

tabbar.querySelectorAll("button").forEach((b) => {
  b.onclick = () => {
    state.tab = b.dataset.tab;
    state.sub = null;
    render();
  };
});

async function boot() {
  if ("serviceWorker" in navigator && !MOCK_MODE) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (_) {}
  }
  if (MOCK_MODE) {
    // screenshot helper: ?mock=1&screen=home|agents|activity|account|login|auditor|coin
    state.owner = true;
    state.session = { user: { email: "mock@local" } };
    await loadAll();
    const screen = params.get("screen") || "home";
    if (screen === "login") {
      state.session = null;
      state.owner = false;
      renderLogin("");
      return;
    }
    if (screen === "auditor") {
      state.sub = "auditor";
      state.subMint = state.audits[0]?.mint;
    } else if (screen === "coin") {
      state.sub = "coin";
      state.subMint = state.scans.find((s) => s.status === "pass")?.mint || state.scans[0]?.mint;
    } else {
      state.tab = screen;
    }
    render();
    return;
  }
  sb = initClient();
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  if (!state.session) {
    renderLogin("");
    return;
  }
  state.owner = await checkOwner(state.session);
  if (!state.owner) {
    renderLogin("Signed in, but not on the owner allowlist.");
    return;
  }
  try {
    await loadAll();
    subscribeRealtime();
  } catch (_) {}
  render();
  sb.auth.onAuthStateChange(async (_e, session) => {
    state.session = session;
    if (!session) {
      state.owner = false;
      teardownRealtime();
      render();
      return;
    }
    state.owner = await checkOwner(session);
    if (state.owner) {
      await loadAll().catch(() => {});
      subscribeRealtime();
    }
    render();
  });
}

boot();

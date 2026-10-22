// =============================================================================
// multiagents Web Control Center — frontend
// =============================================================================
// Layout: sessions + file explorer (left) · team chat and panels (center) ·
// file preview + team roster (right). State arrives over the WebSocket; every
// action goes through POST /api/*, which answers { ok, result } or
// { ok: false, error }. Actions capture the session id when they start, so
// switching sessions mid-way cannot redirect them.
// =============================================================================

"use strict";

// A dashboard server started before an update serves the new page but not
// files it doesn't know yet (i18n.js): run in English instead of stopping here.
const STALE_SERVER = typeof tr !== "function";
if (STALE_SERVER) {
  const en = (s, vars) => String(s ?? "").replace(/\{(\w+)\}/g, (all, k) => (vars && k in vars ? String(vars[k] ?? "") : all));
  Object.assign(window, {
    tr: en, LANGS: { en: "English" }, getLang: () => "en", setLang: () => {}, locale: () => "en-US",
    translateStatic: () => {}, translateTree: () => {},
  });
}

let state = null;
let activeTab = "chat";
let ws = null;
let wsAttempt = 0;
let wsKeepalive = null;

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

// --- Theme: system / light / dark ---

const THEME_ICONS = {
  system: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M5.5 14h5M8 11.5V14"/></svg>',
  light: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"/></svg>',
  dark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z"/></svg>',
};
const THEME_LABEL = { system: "Follow system", light: "Light", dark: "Dark" };
const darkQuery = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;

function themePref() {
  try { return localStorage.getItem("ma-theme") || "system"; } catch { return "system"; }
}

function applyTheme() {
  const pref = themePref();
  const dark = pref === "dark" || (pref === "system" && !!darkQuery?.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("theme-btn").innerHTML = THEME_ICONS[pref] ?? THEME_ICONS.system;
  $("theme-btn").title = tr("Theme: {name}", { name: tr(THEME_LABEL[pref] ?? pref) });
}

darkQuery?.addEventListener?.("change", applyTheme);
$("theme-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const pref = themePref();
  openMenu($("theme-btn"), ["system", "light", "dark"].map((t) => ({
    label: tr(THEME_LABEL[t]), checked: t === pref,
    onClick: () => { try { localStorage.setItem("ma-theme", t); } catch {} applyTheme(); },
  })));
});

// --- Language: English / 中文 ---

function applyLanguage() {
  document.documentElement.lang = getLang() === "zh" ? "zh-CN" : "en";
  translateStatic();
  $("lang-btn").textContent = getLang() === "zh" ? "中" : "EN";
  $("lang-btn").title = tr("Language");
  applyTheme();
}

/** Drop every render cache so the next render rebuilds all regions (language, avatars). */
function rerenderAll() {
  lastChatSignature = "";
  activity.filterSig = "";
  activity.rendered = 0;
  document.querySelectorAll("[data-html]").forEach((el) => delete el.dataset.html);
  delete $("act-approvals").dataset.sig;
  if (state) render(true);
  renderTree();
}

$("lang-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  openMenu($("lang-btn"), Object.entries(LANGS).map(([code, name]) => ({
    label: name, checked: code === getLang(),
    onClick: () => {
      if (code === getLang()) return;
      setLang(code);
      applyLanguage();
      rerenderAll();
      if (preview.path) openPreview(preview.path, preview.line);
    },
  })));
});

$("appearance-btn").addEventListener("click", () => appearanceModal());

// --- Layout: collapsible, resizable side panes ---

const narrowQuery = matchMedia("(max-width: 1100px)");
const workspace = $("workspace");

function isNarrow() { return narrowQuery.matches; }
// Drawers belong to narrow screens only
narrowQuery.addEventListener("change", () => workspace.classList.remove("left-open", "right-open"));

function applyLayout() {
  const layout = store.get("ma-layout", {});
  if (layout.leftW) workspace.style.setProperty("--left-w", `${layout.leftW}px`);
  if (layout.rightW) workspace.style.setProperty("--right-w", `${layout.rightW}px`);
  workspace.classList.toggle("left-collapsed", !!layout.leftCollapsed);
  workspace.classList.toggle("right-collapsed", !!layout.rightCollapsed);
  for (const id of layout.collapsedSections ?? []) $(id)?.classList.add("collapsed");
}

function saveLayout(patch) { store.set("ma-layout", { ...store.get("ma-layout", {}), ...patch }); }

function togglePane(side, open) {
  if (isNarrow()) {
    const cls = `${side}-open`;
    const next = open ?? !workspace.classList.contains(cls);
    workspace.classList.remove("left-open", "right-open");
    workspace.classList.toggle(cls, next);
    return;
  }
  const cls = `${side}-collapsed`;
  const collapsed = open === undefined ? !workspace.classList.contains(cls) : !open;
  workspace.classList.toggle(cls, collapsed);
  saveLayout({ [`${side}Collapsed`]: collapsed });
}

$("left-toggle").addEventListener("click", () => togglePane("left"));
$("right-toggle").addEventListener("click", () => togglePane("right"));
$("left-drawer-btn").addEventListener("click", () => togglePane("left"));
$("right-close").addEventListener("click", () => togglePane("right", false));

document.querySelectorAll("[data-resize]").forEach((handle) => {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const side = handle.dataset.resize;
    const startX = e.clientX;
    const pane = side === "left" ? $("left-pane") : $("right-pane");
    const startW = pane.getBoundingClientRect().width;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev) => {
      const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
      const w = Math.round(Math.max(side === "left" ? 190 : 300, Math.min(side === "left" ? 560 : 1000, startW + delta)));
      workspace.style.setProperty(side === "left" ? "--left-w" : "--right-w", `${w}px`);
      saveLayout({ [side === "left" ? "leftW" : "rightW"]: w });
    };
    const up = () => {
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
});

document.querySelectorAll("[data-collapse]").forEach((el) => {
  el.addEventListener("click", () => {
    const section = $(el.dataset.collapse);
    section.classList.toggle("collapsed");
    saveLayout({ collapsedSections: [...document.querySelectorAll(".side-section.collapsed")].map((s) => s.id) });
  });
});

// --- WebSocket ---

function connectWs() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    wsAttempt = 0;
    $("ws-status").textContent = tr("live");
    $("ws-status").style.color = "var(--green)";
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "state") {
        const prevSid = state?.sessionId;
        state = msg.data;
        if (prevSid !== state.sessionId) onSessionChanged();
        render();
      }
    } catch {}
  };
  ws.onclose = () => {
    $("ws-status").textContent = tr("reconnecting…");
    $("ws-status").style.color = "var(--yellow)";
    const delay = Math.min(500 * Math.pow(2, wsAttempt) + Math.random() * 1000, 30000);
    wsAttempt++;
    setTimeout(connectWs, delay);
  };
  ws.onerror = () => ws.close();
  if (!wsKeepalive) wsKeepalive = setInterval(() => { if (ws?.readyState === 1) ws.send("ping"); }, 30000);
}

// --- API ---

async function api(action, body) {
  const opts = body === undefined
    ? {}
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  let res, data;
  try {
    res = await fetch(`/api/${action}`, opts);
  } catch {
    throw new Error(tr("Dashboard server unreachable"));
  }
  try { data = await res.json(); } catch { data = { ok: false, error: `HTTP ${res.status}` }; }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data.result;
}

function fsUrl(op, sid, params) {
  const q = new URLSearchParams({ session_id: sid });
  for (const [k, v] of Object.entries(params ?? {})) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else if (v !== undefined && v !== null) q.set(k, String(v));
  }
  return `/api/fs/${op}?${q}`;
}

/** Run an action with a busy button; report the broker's answer, never a guessed success. */
async function run(btn, label, fn) {
  if (btn) btn.classList.add("busy");
  try {
    const result = await fn();
    toast(result?.message ? tr(result.message) : tr("{label}: done", { label: tr(label) }), result?.warning ? "warn" : "ok");
    return result ?? true;
  } catch (e) {
    toast(tr("{label} failed: {error}", { label: tr(label), error: tr(e.message) }), "error");
    return null;
  } finally {
    if (btn) btn.classList.remove("busy");
  }
}

function toast(text, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 9000 : 4500);
}

/** The session the user is looking at; actions need one. */
function currentSid() {
  if (state?.sessionId == null || !state.session) {
    toast(tr("No session selected — pick one on the left or start a New Team"), "warn");
    return null;
  }
  return state.sessionId;
}

function onSessionChanged() {
  lastChatSignature = "";
  fileRefCache.clear();
  expandedMessages.clear();
  resetKnowledgeForm();
  closePreview();
  explorerReset();
  activityReset();
}

// --- Tabs ---

const TABS = ["chat", "activity", "agents", "plan", "knowledge", "files", "stats"];

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll("#tab-bar .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  for (const t of TABS) $(`panel-${t}`).classList.toggle("hidden", t !== tab);
  store.set("ma-tab", tab);
  if (tab === "stats" && (!planUsage.data || Date.now() - planUsage.loadedAt > 60_000)) { planUsage.loadedAt = Date.now(); loadPlanUsage(); }
  if (state) render(true);
  if (tab === "chat") $("composer-text").focus();
}

$("tab-bar").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) switchTab(tab.dataset.tab);
});

function switchRightTab(tab) {
  document.querySelectorAll("#right-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.rtab === tab));
  $("rpanel-preview").classList.toggle("hidden", tab !== "preview");
  $("rpanel-preview").style.display = tab === "preview" ? "flex" : "none";
  $("rpanel-team").classList.toggle("hidden", tab !== "team");
  store.set("ma-rtab", tab);
  if (tab === "team" && state) renderRoster();
}

$("right-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-rtab]");
  if (tab) switchRightTab(tab.dataset.rtab);
});

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closePicker(); closeMenu(); closeModal(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) { e.preventDefault(); togglePane("left"); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === "j" || e.key === "J")) { e.preventDefault(); togglePane("right"); return; }
  if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($("modal-overlay").classList.contains("open")) return;
  const num = parseInt(e.key);
  if (num >= 1 && num <= TABS.length) switchTab(TABS[num - 1]);
});

// --- Rendering ---

/** Skip re-rendering a region the user is typing in (state pushes arrive every few seconds). */
function busyRegion(el) {
  return el && isTyping() && el.contains(document.activeElement);
}

function render(force = false) {
  if (!state) return;
  renderHeader();
  renderSidebar();
  renderSessionBar();
  renderGateBanner();
  renderQaBanner();
  renderBrokerBanner();
  renderApprovals();
  renderBadges();
  refreshAgentSelects();
  renderRoster();
  explorerSync();

  if (state.live && (state.sessionId !== liveView.sid || !liveView.at || Date.now() - liveView.at > 2_000)) {
    liveView.data = state.live; liveView.sid = state.sessionId; liveView.at = Date.now();
  }
  switch (activeTab) {
    case "chat": renderChat(force); renderLive(); break;
    case "agents": renderAgents(); break;
    case "plan": renderPlan(); break;
    case "knowledge": renderKnowledge(); break;
    case "files": renderFiles(); break;
    case "stats": renderStats(); break;
    case "activity": renderActivity(); break;
  }
}

function isSessionComplete() {
  if (!state || !state.slots.length) return false;
  if (!state.slots.every((s) => s.status === "disconnected")) return false;
  return state.slots.every((s) => s.task_state === "approved" || s.task_state === "released" || s.task_state === "done_pending_review");
}

function slotName(slot) { return slot?.display_name ?? (slot ? tr("Slot {id}", { id: slot.id }) : "?"); }
function slotById(id) { return state?.slots.find((s) => s.id === id) ?? null; }
function liveSlots() { return (state?.slots ?? []).filter((s) => s.task_state !== "released"); }
function isPaused(slot) { return slot.paused === true || slot.paused === 1; }

function renderHeader() {
  const dot = $("conn-dot");
  const status = state.session?.status;
  dot.className = "dot " + (!state.brokerAlive ? "red" : status === "paused" ? "yellow" : status === "archived" || isSessionComplete() ? "" : state.session ? "green" : "");
  $("session-name-text").textContent = state.session?.name ?? state.sessionId ?? tr("No session");

  const b = sessionBadge();
  const badge = $("session-status-badge");
  badge.classList.toggle("hidden", !b);
  if (b) { badge.textContent = b.text; badge.className = `badge ${b.cls}`; }

  const connected = state.slots.filter((s) => s.status === "connected").length;
  $("agent-count").textContent = state.session ? tr("{online}/{total} agents online", { online: connected, total: state.slots.length }) : "";

  if (state.session?.created_at) {
    let endTime = Date.now();
    if (isSessionComplete() || status === "archived") {
      const candidates = [state.session.last_active_at || 0];
      const last = state.messages[state.messages.length - 1];
      if (last?.sent_at) candidates.push(new Date(last.sent_at).getTime());
      for (const slot of state.slots) if (slot.last_disconnected) candidates.push(slot.last_disconnected);
      endTime = Math.max(state.session.created_at, ...candidates);
    }
    $("uptime").textContent = fmtDuration(endTime - state.session.created_at);
  } else {
    $("uptime").textContent = "";
  }

  $("broker-dot").className = `dot ${state.brokerAlive ? "green" : "red"}`;
  $("broker-label").textContent = state.brokerAlive
    ? tr("Broker · {sessions} sessions · {peers} peers", { sessions: state.sessions?.length ?? 0, peers: state.peerCount ?? 0 })
    : tr("Broker down");
}

function sessionBadge() {
  if (!state.session) return null;
  if (state.session.status === "archived") return { text: tr("archived"), cls: "badge-released" };
  if (state.awaitingHuman) return { text: tr("waiting for you"), cls: "badge-review" };
  if (state.session.status === "paused") return { text: tr("paused"), cls: "badge-paused" };
  if (isSessionComplete()) return { text: tr("completed"), cls: "badge-approved" };
  return { text: tr("active"), cls: "badge-connected" };
}

function renderBadges() {
  $("badge-chat").textContent = state.messages.filter((m) => !isSystemMessage(m)).length;
  $("badge-agents").textContent = state.slots.filter((s) => s.status === "connected").length;
  $("badge-plan").textContent = state.plan?.plan ? `${state.plan.completion}%` : "-";
  $("badge-knowledge").textContent = state.knowledge?.length ?? 0;
  $("badge-files").textContent = state.fileLocks.length + state.fileOwnership.length;
  $("badge-team").textContent = liveSlots().length;
  const warnings = state.guardrails.filter((g) => g.usage?.status === "warning" || g.usage?.status === "triggered").length;
  $("badge-stats").textContent = warnings > 0 ? `${warnings}!` : "";
}

// --- Sessions (left) ---

function sortedSessions(list) {
  const order = { active: 0, paused: 1, archived: 2 };
  return [...(list ?? [])].sort((a, b) => {
    const so = (order[a.status] ?? 3) - (order[b.status] ?? 3);
    if (so !== 0) return so;
    return (b.last_active_at ?? b.created_at ?? 0) - (a.last_active_at ?? a.created_at ?? 0);
  });
}

function statusDot(status) {
  return `<span class="dot ${status === "active" ? "green" : status === "paused" ? "yellow" : ""}"></span>`;
}

function renderSidebar() {
  const list = $("sidebar-list");
  const sessions = sortedSessions(state.sessions);
  if (!sessions.length) {
    list.innerHTML = `<div class="tree-empty">${state.brokerAlive ? tr("No sessions yet — use + to start a team.") : tr("Broker is not running.")}</div>`;
    return;
  }
  let html = "", last = "";
  for (const s of sessions) {
    if (s.status !== last) {
      last = s.status;
      html += `<div class="side-group">${esc(tr(s.status))}</div>`;
    }
    html += `<div class="session-row${s.id === state.sessionId ? " current" : ""}" data-sid="${esc(s.id)}" title="${esc(s.id)}\n${esc(s.project_dir)}">
      ${statusDot(s.status)}
      <span class="name">${esc(s.name || s.id)}</span>
      <span class="time">${timeSince(s.last_active_at ?? s.created_at)}</span>
      <button class="icon-btn" data-session-menu="${esc(s.id)}" title="${tr("Session actions")}">&#8943;</button>
    </div>`;
  }
  list.innerHTML = html;
}

$("sidebar-list").addEventListener("click", (e) => {
  const menuBtn = e.target.closest("[data-session-menu]");
  if (menuBtn) {
    e.stopPropagation();
    const s = state.sessions.find((x) => x.id === menuBtn.dataset.sessionMenu);
    if (s) openMenu(menuBtn, sessionMenuItems(s));
    return;
  }
  const row = e.target.closest(".session-row");
  if (row) {
    selectSession(row.dataset.sid);
    if (isNarrow()) togglePane("left", false);
  }
});

// --- Explorer (left) ---

const explorer = { sid: null, root: "", children: new Map(), expanded: new Set(), error: null };

function explorerReset() {
  explorer.sid = null;
  explorer.children.clear();
  explorer.error = null;
}

function explorerKey(sid) { return `ma-exp:${sid}`; }

/** Load the tree of the current session's project on first sight of the session. */
function explorerSync() {
  const sid = state.session ? state.sessionId : null;
  if (sid === explorer.sid) return;
  explorer.sid = sid;
  explorer.children.clear();
  explorer.error = null;
  explorer.expanded = new Set(store.get(sid == null ? "" : explorerKey(sid), []));
  explorer.expanded.add("");
  $("explorer-root").textContent = state.session ? baseName(state.session.project_dir) : "";
  $("explorer-root").title = state.session?.project_dir ?? "";
  if (sid == null) { renderTree(); return; }
  reloadExplorer();
}

async function loadDir(sid, rel) {
  const res = await fetch(fsUrl("list", sid, { path: rel }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.result.entries;
}

async function reloadExplorer() {
  const sid = explorer.sid;
  if (sid == null) return;
  const dirs = [...explorer.expanded];
  const results = await Promise.all(dirs.map((d) => loadDir(sid, d).then((e) => [d, e], (err) => [d, null, err])));
  if (sid !== explorer.sid) return;
  let changed = false;
  for (const [dir, entries, err] of results) {
    if (!entries) {
      if (dir === "") explorer.error = err.message;
      explorer.expanded.delete(dir);
      changed = true;
      continue;
    }
    if (dir === "") explorer.error = null;
    const prev = explorer.children.get(dir);
    if (JSON.stringify(prev) !== JSON.stringify(entries)) { explorer.children.set(dir, entries); changed = true; }
  }
  if (changed || !$("explorer-tree").innerHTML) renderTree();
}

const FILE_ICONS = {
  pdf: ["PDF", "#d1242f"], doc: ["W", "#2b5fd9"], docx: ["W", "#2b5fd9"], odt: ["W", "#2b5fd9"], rtf: ["W", "#2b5fd9"],
  xls: ["X", "#1a7f37"], xlsx: ["X", "#1a7f37"], csv: ["CSV", "#1a7f37"], tsv: ["TSV", "#1a7f37"],
  ppt: ["P", "#c2410c"], pptx: ["P", "#c2410c"],
  md: ["M", "#6e7781"], markdown: ["M", "#6e7781"], txt: ["T", "#6e7781"], log: ["L", "#6e7781"],
  ts: ["TS", "#3178c6"], tsx: ["TS", "#3178c6"], js: ["JS", "#b08800"], jsx: ["JS", "#b08800"], mjs: ["JS", "#b08800"],
  json: ["{}", "#b08800"], py: ["PY", "#3572a5"], ipynb: ["NB", "#da5b0b"], r: ["R", "#276dc3"], rmd: ["R", "#276dc3"],
  html: ["<>", "#e34c26"], htm: ["<>", "#e34c26"], css: ["#", "#563d7c"], sh: ["$", "#4e5a65"], go: ["GO", "#00add8"], rs: ["RS", "#a0522d"],
  java: ["J", "#b07219"], c: ["C", "#555"], cpp: ["C+", "#f34b7d"], yaml: ["Y", "#cb171e"], yml: ["Y", "#cb171e"], toml: ["T", "#9c4221"],
  tex: ["TX", "#3d6117"], bib: ["BIB", "#3d6117"], zip: ["ZIP", "#8250df"], gz: ["GZ", "#8250df"],
};
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const FOLDER_SVG = '<svg viewBox="0 0 16 16"><path fill="#d4a72c" d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.6l1.4 1.5h6a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>';
const FOLDER_OPEN_SVG = '<svg viewBox="0 0 16 16"><path fill="#d4a72c" d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.6l1.4 1.5h5a1 1 0 0 1 1 1V6H4.2a1 1 0 0 0-.95.68L1.5 12z"/><path fill="#e8c35a" d="M3.3 6.7A1 1 0 0 1 4.2 6h10.3a.5.5 0 0 1 .47.68l-2.2 5.65a1 1 0 0 1-.93.67H1.9z"/></svg>';
const FILE_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="var(--text-muted)" stroke-width="1.2"><path d="M4 1.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z"/><path d="M9 1.5V5h3.5"/></svg>';
const IMAGE_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="#8250df" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1.2"/><path d="M14.5 11l-4-4-6.5 6.5"/></svg>';

function extOf(name) {
  const m = /\.([^./]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

function fileIcon(name, isDir, open) {
  if (isDir) return `<span class="ficon">${open ? FOLDER_OPEN_SVG : FOLDER_SVG}</span>`;
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return `<span class="ficon">${IMAGE_SVG}</span>`;
  const icon = FILE_ICONS[ext];
  if (!icon) return `<span class="ficon">${FILE_SVG}</span>`;
  const [label, color] = icon;
  return `<span class="ficon" style="color:${color};font-size:${label.length > 2 ? 7 : 9}px">${esc(label)}</span>`;
}

function renderTree() {
  const el = $("explorer-tree");
  if (explorer.sid == null) {
    el.innerHTML = `<div class="tree-empty">${tr("Select a session to browse its project.")}</div>`;
    return;
  }
  if (explorer.error) {
    el.innerHTML = `<div class="tree-empty">${esc(explorer.error)}</div>`;
    return;
  }
  const root = explorer.children.get("");
  if (!root) { el.innerHTML = `<div class="tree-empty">${tr("Loading…")}</div>`; return; }
  if (!root.length) { el.innerHTML = `<div class="tree-empty">${tr("The project directory is empty.")}</div>`; return; }
  const locked = new Set((state?.fileLocks ?? []).map((l) => l.file_path.replace(/^\.\//, "")));
  const rows = [];
  const walk = (dir, depth) => {
    for (const entry of explorer.children.get(dir) ?? []) {
      const open = entry.type === "dir" && explorer.expanded.has(entry.path);
      const selected = entry.type === "file" && preview.path === entry.path;
      const dim = entry.name.startsWith(".") || entry.name === "node_modules";
      rows.push(`<div class="tree-row${open || entry.type === "file" ? "" : " closed"}${selected ? " selected" : ""}${dim ? " dim" : ""}"
          data-path="${esc(entry.path)}" data-type="${entry.type}" style="padding-left:${8 + depth * 14}px"
          title="${esc(entry.path)}${entry.type === "file" ? ` · ${fmtBytes(entry.size)} · ${timeSince(entry.mtime)}` : ""}">
        <span class="chev">${entry.type === "dir" ? "&#9662;" : ""}</span>
        ${fileIcon(entry.name, entry.type === "dir", open)}
        <span class="tree-name">${esc(entry.name)}</span>
        ${locked.has(entry.path) ? `<span class="lock" title="${tr("Locked by an agent")}">&#128274;</span>` : ""}
        ${entry.type === "file" ? `<span class="tree-actions"><button class="icon-btn" data-mention title="${tr("Mention in chat")}">@</button></span>` : ""}
      </div>`);
      if (open) {
        if (explorer.children.has(entry.path)) walk(entry.path, depth + 1);
        else rows.push(`<div class="tree-empty" style="padding-left:${30 + depth * 14}px">${tr("Loading…")}</div>`);
      }
    }
  };
  walk("", 0);
  el.innerHTML = rows.join("");
}

$("explorer-tree").addEventListener("click", async (e) => {
  const row = e.target.closest(".tree-row");
  if (!row) return;
  const p = row.dataset.path;
  if (e.target.closest("[data-mention]")) { mentionFile(p); return; }
  if (row.dataset.type === "file") { openPreview(p); return; }
  const sid = explorer.sid;
  if (explorer.expanded.has(p)) {
    explorer.expanded.delete(p);
  } else {
    explorer.expanded.add(p);
    renderTree();
    try {
      explorer.children.set(p, await loadDir(sid, p));
    } catch (err) {
      explorer.expanded.delete(p);
      toast(tr("Cannot open {path}: {error}", { path: p, error: err.message }), "error");
    }
  }
  if (sid !== explorer.sid) return;
  store.set(explorerKey(sid), [...explorer.expanded].filter(Boolean));
  renderTree();
});

$("explorer-refresh").addEventListener("click", () => { explorer.children.clear(); renderTree(); reloadExplorer(); });
$("explorer-collapse").addEventListener("click", () => {
  explorer.expanded = new Set([""]);
  if (explorer.sid != null) store.set(explorerKey(explorer.sid), []);
  renderTree();
});

// Agents create and edit files while you watch: refresh what is open
setInterval(() => {
  if (document.hidden || explorer.sid == null) return;
  if (!isNarrow() && workspace.classList.contains("left-collapsed")) return;
  reloadExplorer().catch(() => {});
}, 6000);

// --- Preview (right) ---

const preview = { sid: null, path: null, line: null, mtime: null, size: null, mode: null, wrap: false };

const PREVIEW_KIND = (ext) =>
  IMAGE_EXT.has(ext) ? "image"
  : ext === "pdf" ? "pdf"
  : ext === "docx" ? "docx"
  : ext === "md" || ext === "markdown" || ext === "mdx" ? "markdown"
  : ext === "csv" || ext === "tsv" ? "csv"
  : ext === "html" || ext === "htm" ? "html"
  : ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext) ? "audio"
  : ["mp4", "webm", "mov", "m4v", "ogv"].includes(ext) ? "video"
  : ["doc", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "pages", "key", "numbers", "zip", "gz", "tgz", "tar", "7z", "rar", "exe", "dmg", "bin", "rds", "rdata", "h5", "hdf5", "parquet", "bam", "sqlite", "db"].includes(ext) ? "binary"
  : "text";

const TEXT_LIMIT = 2_000_000;

async function openPreview(rel, line) {
  const sid = currentSid();
  if (sid == null) return;
  let info;
  try {
    info = await api(`fs/resolve?session_id=${encodeURIComponent(sid)}&path=${encodeURIComponent(rel)}`);
  } catch (e) {
    toast(tr("Cannot open {path}: {error}", { path: rel, error: e.message }), "error");
    return;
  }
  Object.assign(preview, { sid, path: info.path, line: line ?? null, mtime: info.mtime, size: info.size, mode: null });
  if (isNarrow()) togglePane("right", true);
  else if (workspace.classList.contains("right-collapsed")) togglePane("right", true);
  switchRightTab("preview");
  renderTree();
  await renderPreview();
}

function closePreview() {
  Object.assign(preview, { sid: null, path: null, line: null, mtime: null, size: null, mode: null });
  $("preview-head").classList.add("hidden");
  const body = $("preview-body");
  body.className = "preview-body";
  body.innerHTML = `<div class="preview-empty"><div class="big">&#128196;</div>
    <div><b>${tr("No file open")}</b></div>
    <div style="font-size:12.5px">${tr("Click a file in the explorer, or a file name an agent mentions in the chat.")}</div></div>`;
  if (explorer.children.size) renderTree();
}

function rawUrl(params = {}) {
  return fsUrl("raw", preview.sid, { path: preview.path, v: preview.mtime, ...params });
}

async function renderPreview(keepScroll = false) {
  if (!preview.path) return closePreview();
  const body = $("preview-body");
  const scrollTop = body.scrollTop;
  const ext = extOf(preview.path);
  const kind = PREVIEW_KIND(ext);
  const parts = preview.path.split("/");
  const name = parts.pop();
  $("preview-head").classList.remove("hidden");
  $("preview-path").innerHTML = `<bdi>${parts.length ? esc(parts.join("/")) + "/" : ""}<b>${esc(name)}</b></bdi>`;
  $("preview-path").title = `${preview.path} · ${fmtBytes(preview.size ?? 0)}`;
  $("preview-open").href = rawUrl();
  $("preview-download").href = rawUrl({ download: 1 });
  $("preview-mode").innerHTML = "";
  body.className = "preview-body";

  const seg = (options, current, onPick) => {
    const el = document.createElement("span");
    el.className = "seg";
    el.innerHTML = options.map(([v, l]) => `<button data-v="${v}" class="${v === current ? "on" : ""}">${l}</button>`).join("");
    el.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) onPick(b.dataset.v); });
    $("preview-mode").appendChild(el);
  };

  const fetchText = async () => {
    const res = await fetch(rawUrl());
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const slice = new Uint8Array(buf, 0, Math.min(buf.byteLength, TEXT_LIMIT));
    if (slice.subarray(0, 4096).includes(0)) return { binary: true };
    return { text: new TextDecoder().decode(slice), truncated: buf.byteLength > TEXT_LIMIT };
  };

  try {
    switch (kind) {
      case "image":
        body.innerHTML = `<div class="preview-img"><img src="${rawUrl()}" alt="${esc(name)}"></div>`;
        break;
      case "pdf":
        if (navigator.pdfViewerEnabled === false) { body.innerHTML = noPreview(name, tr("This browser cannot show PDFs inline.")); break; }
        body.className = "preview-body fill";
        body.innerHTML = `<iframe class="pdf" src="${rawUrl()}#view=FitH" title="${esc(name)}"></iframe>`;
        break;
      case "audio":
        body.innerHTML = `<div class="preview-media"><audio controls src="${rawUrl()}"></audio></div>`;
        break;
      case "video":
        body.innerHTML = `<div class="preview-media"><video controls src="${rawUrl()}"></video></div>`;
        break;
      case "docx": {
        const r = await api(`fs/docx?session_id=${encodeURIComponent(preview.sid)}&path=${encodeURIComponent(preview.path)}`);
        body.innerHTML = `<div class="doc-view doc-page">${r.html || `<p class="dim">${tr("The document has no text.")}</p>`}</div>`;
        break;
      }
      case "html": {
        const mode = preview.mode ?? "render";
        seg([["render", tr("Render")], ["source", tr("Source")]], mode, (v) => { preview.mode = v; renderPreview(); });
        if (mode === "render") {
          body.className = "preview-body fill";
          body.innerHTML = `<iframe sandbox="" src="${rawUrl()}" title="${esc(name)}"></iframe>`;
        } else {
          const t = await fetchText();
          body.innerHTML = codeView(t.text ?? "", t.truncated);
        }
        break;
      }
      case "markdown": {
        const mode = preview.mode ?? "preview";
        seg([["preview", tr("Preview")], ["source", tr("Source")]], mode, (v) => { preview.mode = v; renderPreview(); });
        const t = await fetchText();
        body.innerHTML = mode === "preview"
          ? `${t.truncated ? `<div class="preview-notice">${tr("Large file — showing the first 2 MB.")}</div>` : ""}<div class="doc-view">${renderMarkdown(t.text ?? "", { baseDir: parts.join("/") })}</div>`
          : codeView(t.text ?? "", t.truncated);
        hydrateFileRefs(body);
        break;
      }
      case "csv": {
        const mode = preview.mode ?? "table";
        seg([["table", tr("Table")], ["source", tr("Source")]], mode, (v) => { preview.mode = v; renderPreview(); });
        const t = await fetchText();
        body.innerHTML = mode === "table" ? csvView(t.text ?? "", ext === "tsv" ? "\t" : ",") : codeView(t.text ?? "", t.truncated);
        break;
      }
      case "binary":
        body.innerHTML = noPreview(name, tr("This file type has no inline preview."));
        break;
      default: {
        seg([["nowrap", tr("No wrap")], ["wrap", tr("Wrap")]], preview.wrap ? "wrap" : "nowrap", (v) => { preview.wrap = v === "wrap"; renderPreview(true); });
        const t = await fetchText();
        body.innerHTML = t.binary ? noPreview(name, tr("This looks like a binary file.")) : codeView(t.text, t.truncated);
      }
    }
  } catch (e) {
    body.innerHTML = noPreview(name, tr("Preview failed: {error}", { error: e.message }));
  }

  if (keepScroll) body.scrollTop = scrollTop;
  else if (preview.line) {
    const lineEl = body.querySelector(`[data-line="${preview.line}"]`);
    if (lineEl) { lineEl.classList.add("hl"); lineEl.scrollIntoView({ block: "center" }); }
  } else body.scrollTop = 0;
}

function noPreview(name, why) {
  return `<div class="preview-empty"><div class="big">&#128230;</div><div><b>${esc(name)}</b></div><div style="font-size:12.5px">${esc(why)}</div>
    <div class="flex gap-2" style="margin-top:8px"><a class="btn" href="${rawUrl({ download: 1 })}">${tr("Download")}</a><a class="btn" href="${rawUrl()}" target="_blank" rel="noopener">${tr("Open in browser")}</a></div></div>`;
}

function codeView(text, truncated) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const shown = lines.slice(0, 20000);
  return `${truncated || lines.length > shown.length ? `<div class="preview-notice">${tr("Large file — showing the beginning only.")}</div>` : ""}
    <div class="code-view mono${preview.wrap ? " code-wrap" : ""}">${shown.map((l, i) => `<div class="code-line" data-line="${i + 1}"><span class="ln">${i + 1}</span><span>${esc(l) || " "}</span></div>`).join("")}</div>`;
}

function parseCsv(text, sep) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length && rows.length < 1001; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function csvView(text, sep) {
  const rows = parseCsv(text, sep);
  if (!rows.length) return `<div class="preview-empty">${tr("Empty file")}</div>`;
  const [head, ...rest] = rows;
  return `<div class="csv-view"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rest.slice(0, 1000).map((r) => `<tr>${r.map((c) => `<td title="${esc(c)}">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
    ${rows.length > 1000 ? `<div class="field-hint" style="margin-top:6px">${tr("Showing the first 1000 rows.")}</div>` : ""}</div>`;
}

$("preview-reload").addEventListener("click", () => preview.path && openPreview(preview.path, preview.line));
$("preview-close").addEventListener("click", closePreview);
$("preview-mention").addEventListener("click", () => preview.path && mentionFile(preview.path));

// Follow an open file while agents edit it
setInterval(async () => {
  if (!preview.path || document.hidden) return;
  if (!isNarrow() && workspace.classList.contains("right-collapsed")) return;
  if ($("rpanel-preview").classList.contains("hidden")) return;
  const sid = preview.sid, p = preview.path;
  try {
    const info = await api(`fs/resolve?session_id=${encodeURIComponent(sid)}&path=${encodeURIComponent(p)}`);
    if (preview.path === p && preview.sid === sid && info.mtime !== preview.mtime) {
      preview.mtime = info.mtime;
      preview.size = info.size;
      renderPreview(true);
    }
  } catch { /* deleted or session gone — keep what is shown */ }
}, 4000);

function mentionFile(p) {
  switchTab("chat");
  const ta = $("composer-text");
  const ins = `\`${p}\` `;
  const pos = ta.selectionStart ?? ta.value.length;
  ta.value = ta.value.slice(0, pos) + (pos && !/\s$/.test(ta.value.slice(0, pos)) ? " " : "") + ins + ta.value.slice(pos);
  autosize();
  ta.focus();
}

// --- Rich text: markdown-lite with file references ---

const FILE_EXTS = "md|markdown|mdx|txt|rst|pdf|docx?|odt|rtf|xlsx?|ods|pptx?|odp|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|ipynb|r|rmd|qmd|jl|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|lua|dart|scala|tex|bib|log|png|jpe?g|gif|webp|svg|bmp|avif|tiff?|mp3|wav|ogg|m4a|flac|mp4|webm|mov|zip|gz|tgz|tar|lock|env|fa|fasta|fastq|gff|gtf|bed|vcf|sam|rds|parquet";
const FILE_RE_SRC = String.raw`(?<![\p{L}\p{N}_/.@\-])((?:~\/|\.{1,2}\/|\/)?(?:[\p{L}\p{N}_@.\-]+\/)*[\p{L}\p{N}_@\-][\p{L}\p{N}_@.\-]*\.(?:${FILE_EXTS}))(?::(\d+))?(?![\p{L}\p{N}_\/\-])`;
const INLINE_RE = new RegExp(String.raw`(!?\[[^\]\n]*\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"）。，])|` + FILE_RE_SRC, "giu");
const FILE_ONLY_RE = new RegExp("^" + FILE_RE_SRC + "$", "iu");

function emph(escaped) {
  return escaped
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+?)~~/g, "<del>$1</del>");
}

function fileRef(ref, line) {
  return `<span class="file-ref" data-ref="${esc(ref)}"${line ? ` data-line="${esc(line)}"` : ""}>${esc(ref)}${line ? `:${esc(line)}` : ""}</span>`;
}

function inlineText(s, ctx) {
  let out = "", last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    out += emph(esc(s.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[1]) {
      const link = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/.exec(m[1]);
      const [, bang, label, href] = link;
      if (/^https?:\/\//i.test(href)) {
        out += bang ? `<img src="${esc(href)}" alt="${esc(label)}" style="max-width:100%">` : `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;
      } else {
        const target = ctx?.baseDir && !href.startsWith("/") ? `${ctx.baseDir}/${href}` : href;
        if (bang && preview.sid != null) out += `<img src="${fsUrl("raw", preview.sid, { path: normPath(target) })}" alt="${esc(label)}" style="max-width:100%">`;
        else out += `<span class="file-ref" data-ref="${esc(normPath(target))}">${esc(label || href)}</span>`;
      }
    } else if (m[2]) {
      out += `<a href="${esc(m[2])}" target="_blank" rel="noopener">${esc(m[2])}</a>`;
    } else {
      out += fileRef(m[3], m[4]);
    }
  }
  return out + emph(esc(s.slice(last)));
}

function inline(s, ctx) {
  return s.split(/(`[^`\n]+`)/).map((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      const code = part.slice(1, -1);
      const fm = FILE_ONLY_RE.exec(code);
      return `<code>${fm ? fileRef(fm[1], fm[2]) : esc(code)}</code>`;
    }
    return inlineText(part, ctx);
  }).join("");
}

function normPath(p) {
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return out.join("/");
}

/** Markdown for chat bubbles and .md previews: escape first, then a safe subset. */
function renderMarkdown(text, ctx = {}) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let para = [];
  const flush = () => {
    if (para.length) html.push(`<p>${para.map((l) => inline(l, ctx)).join(ctx.chat ? "<br>" : " ")}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i]);
      html.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); html.push(`<h${h[1].length}>${inline(h[2], ctx)}</h${h[1].length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); html.push("<hr>"); continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      i--;
      html.push(`<blockquote>${renderMarkdown(quote.join("\n"), ctx)}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      flush();
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i++;
      const rows = [];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      html.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c, ctx)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) items.push(m[3].replace(/^\[( |x)\]\s/i, (_, x) => (x.trim() ? "☑ " : "☐ ")));
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1] += " " + lines[i].trim();
        else break;
        i++;
      }
      i--;
      html.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inline(t, ctx)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  flush();
  return html.join("");
}

// File references become links once the server confirms the file exists in the project
const fileRefCache = new Map(); // ref → { path, at } | { path: null, at }
let refCheckTimer = null;
const pendingRefs = new Set();

function hydrateFileRefs(root) {
  if (state?.sessionId == null) return;
  for (const el of root.querySelectorAll(".file-ref")) {
    const ref = el.dataset.ref;
    const hit = fileRefCache.get(ref);
    if (hit && (hit.path || Date.now() - hit.at < 30_000)) {
      if (hit.path) { el.classList.add("file-link"); el.dataset.path = hit.path; el.title = tr("Open {path}", { path: hit.path }); }
    } else pendingRefs.add(ref);
  }
  if (pendingRefs.size && !refCheckTimer) refCheckTimer = setTimeout(checkPendingRefs, 150);
}

async function checkPendingRefs() {
  refCheckTimer = null;
  const sid = state?.sessionId;
  const refs = [...pendingRefs];
  pendingRefs.clear();
  if (sid == null || !state.session) return;
  for (let i = 0; i < refs.length; i += 40) {
    const batch = refs.slice(i, i + 40);
    try {
      const res = await fetch(fsUrl("check", sid, { ref: batch }));
      const data = await res.json();
      if (!data.ok || sid !== state?.sessionId) return;
      for (const ref of batch) fileRefCache.set(ref, { path: data.result[ref] ?? null, at: Date.now() });
    } catch { return; }
  }
  for (const root of [$("msg-feed"), $("preview-body"), $("panel-knowledge"), $("panel-agents"), $("rpanel-team")]) hydrateFileRefs(root);
}

document.addEventListener("click", (e) => {
  const link = e.target.closest(".file-link");
  if (!link) return;
  e.preventDefault();
  const line = link.dataset.line ? parseInt(link.dataset.line, 10) : undefined;
  openPreview(link.dataset.path, line);
});

// --- Chat ---

let lastChatSignature = "";
const expandedMessages = new Set();
const SYSTEMISH = new Set(["system", "control", "team_change", "role_assignment", "rename", "release"]);
const PALETTE = ["#2f6fde", "#8250df", "#1a7f37", "#c2410c", "#0e7f86", "#bf3989", "#9a6700", "#6639ba", "#0969da", "#cf222e"];

function isSystemMessage(m) { return SYSTEMISH.has(m.msg_type); }

function initials(name) {
  const n = String(name ?? "?").trim();
  if (!n) return "?";
  if (/^[㐀-鿿가-힯぀-ヿ]/.test(n)) return n[0];
  const words = n.split(/[\s_\-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : n.slice(0, 2)).toUpperCase();
}

function slotColor(id) { return PALETTE[Math.abs(Number(id) || 0) % PALETTE.length]; }

const PERSON_SVG = '<svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor"><circle cx="8" cy="5" r="3"/><path d="M2.5 14c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5z"/></svg>';

function avatar(name, color, extra = "", me = false) {
  return `<div class="avatar" style="background:${color}">${me ? PERSON_SVG : esc(initials(name))}${extra}</div>`;
}

// --- Avatars: the agent's official icon by default, or the user's own pick ---
// Icons: Simple Icons (CC0). OpenAI asked Simple Icons to remove its logo, so
// Codex gets a neutral terminal glyph; users can upload any image instead.

const AGENT_ICONS = {
  claude: { bg: "#D97757", svg: '<svg viewBox="0 0 24 24" fill="#fff"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>' },
  gemini: { bg: "linear-gradient(135deg, #4285F4 0%, #8E75B2 60%, #D96570 100%)", svg: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/></svg>' },
  // Other (OpenAI-compatible API): a neutral plug; upload the provider's logo as an image if you like
  api: { bg: "linear-gradient(135deg, #475569, #0e7f86)", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21"/></svg>' },
  codex: { bg: "#10a37f", svg: '<svg viewBox="0 0 100 100" fill="none"><image href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAACXBIWXMAAAsTAAALEwEAmpwYAAALlklEQVR4nO1de7BWVRX/fdd7gQvi46rgq9ThoomO+CiLagrJdEAFIignLLTS0iyKBCVTCcXMNJsSyiJRBAuKJJBICh21oRfmgBQposb1AUMqt3jK9X7NctY3c1qtvc/Z++z9ffe7nN/M/ufeffY5Z6+z1+O31t4fUKBAgQIFChQoUKBAgQIFkjgZwJcAzAfwFwBbAOwC8CaA1wD8A8ADAKYBeDeAhv+5ukAQ9GEhPA2g7NheAnAdgH61fonugP0B3AjgVQ9ByLYdwNcBNNf6peoV7wPwTABByEYqbXCtX66esB+A29kmlJW2G8BSAF8GMBTAEQB6AygBaAFwKoBPAbgPQLthjJ0Axtb6ResBPQAsMExiG4Cv8KS72J7LAbyojNcB4JKI71L3IN2+zLAibgDQK8fYJJjvAehUhDKC+9AKGwTgfBbUFP4ALgUwGsBA7rPPYI4ijA0ATgt4j4+xukre498AHmSXOc3+kApcAeAKAIejG+Mzysv/GcChEe51Lq+6vM7BHo6Fup2DMEj5atcAOCjCvd4O4H6Lw+DTaKx7ulOcs1S84FYARwe+R2+O3HekTO4/WX3dCeAWbrPYtr2cci0xBiNR53i/8mIhX6oE4EIAmywTuRbARADHZRivFcBkAH8zjNXJrEDdGv9HxAv9MuDYZwB43CKIvyY8LFeU+Nq1hrHvrEehHCvcUNLFJwUYtz+A2RY7sZmdiIZAQexUNvDyPqTu6gpfFS9AejpvUDnZEp3TpN0K4ADEUb1blXuORx3hD+LhKUbwxUiOWUzqaQkHdjFxIhv25H13sN3pciD1MATAzWw3XlMi5gM9XeYVFkGQ8T0H1cMZigu/sivZk75MP2xMcRnJwLqghamQvYbxiK7/IoBGVB+fjuw5eoG+iE9m8N0rbV7GcRuZtviXYRwS0EwAh6C2WC6e64laPszBABZnFISLRzIMwFOWMX7H6V3fwPG8HNdrqlR6eZROrjoouHrWMGHEHy0CMAHAj8X/KJNnw1iLG/sss7G+K/kisZIpHz8A+bFIPCep2KpiAOcs5ITt4hWQ5Hq+KfpckzL2MmVcYmmvBtDT83lPtQSOu/kZyQb64gIxJmU/qwYiAtcrL/ZHAMcr/V0F8qjov4AzhT5o4Ui6I4MqpZVzsWcQ2aywyhS0VgWazZhr+XpdBfKw6H+WxzM2cLJJC+DKSvJKpgLeGyDWIjsYHZ8wCMP2VbkK5Lei/9mOz/geruEyTfhSDuDGG9RuRWDzHZnoe8UYtNqigryTV8RNV2XQ664C+Y3oT0mmLCAVcbfl69+gEIyU7p2uBHjJcqLrMpYT3SGupZgsKqaIG+7MSBXkNeojMsQrRKm/bpnUqSkfzjEAFlpW1QsZ6J7bxDVUKRMNjUo1x00Zr3UVyFLRnzwYE4amxCsLHNXOBwE8aRnvUUveX7r3lyEipFvX7pB2dRXIYtF/lNKHJvlnlomjKH4M/Gn2yxTysNIoRvqRksZdKfoNR0TcI272Q4drXQWySPRPTmxPVj/bLcJIclykypo83/kgLuJ7wzD+Nk4r9GCnRlI80RjnEid6kjf7QESBLBT9x/HfR3iWmz5tWGVZcYIhWE2OP1n8bUtM1vdYRV01RhTIT0X/awH8yjIhq5nup3z685Z+lAo4Pcc8DDcExFojdVo1+0GGDREFMi/jS29lXZ+MgXoxxdJu0f9UpHcU/NDE3pPJo7PZvWC4XNyMDFpMgdyb8rIdTLvb6n7J4P7AkkPZziWrFIf44DC2oyZKhrizaLhe3Iz2cMQUyByLMB53fNmTlHxFsr3IjLRvEcS7DNUobRzbRME3HOnzvAKZbdgZdVEOQ0nR/jqLYJ7gmMYHzUwfaXtTYhRZvCWAaq6QuxQDmYcar6CR+SmbOnzA012lD+XbynikfoPj8+ImP4kskFmiP9mwULgxg7Owh3kpl70ppo+pHGOz0HBxg8ciC+T7ov+VCIdpiirsDBhYNjHhKnkwCh6D4Sil/qgpokC+K/rTpMRyUKYzXS8nMU9g2aqwxyFX+VvYlCNHIQVCk2LD7aL/JITDtWLsGQkb8PGUwHKJw67em5VVEnQP/awcsYgUyF6OEUx7LG4V/YmWCIVrUipg0gJLykJmrcbZkYNuykRLy8CKbpoFlxperp1fXu4nvMVRxblAck7kGbkElvRxZYWk4+mjDoYG3uCSvAEtyyxo5uVuUgXPs7oocf8Z4v+kZkJhkhj7O442x0UgZ4trSe0HxRWeGcMKRqUcl7GKDex0R5vjgolibHIgXFSci0CaFLV1JAKih7JKVnm4hRMtx2d0siua/Bu5qqFwpRibXOxYAiH83rM+IDPGKZPoSjaCg647DJtfyjmZAReidFZkgdxdjbSuxtvc5skzDWS6wiaQ+YEq2/sqaV+KrGMKRLq/X0MEHGiwBXNznL4zlAm+sqGty7HcKzW9UhWWmciMKRDJDBDlHwXHGIrMqALkzBye3ATDWSWVttxxb6KtprfMVH81V0hIj/H/MNjwkh2cvKEkjg/68JdkKmRICywrNmpmhppeWtUxBSJjkc8hIkanvOzrnO5sysGhzbFsTdACywY2nKaaXs0+VdPLon0p0WCr9Eu29TlrlE5X9rjLwPJCLnRYbem3hI2qSzFCHoFQmPAfcf3bEAkl5SucxFky04Qs45IaX4zyPIfxmUQ56ljxv59HFMgwcS05FdFwgrjZKyykJhbMNsPkvMFsru9hM00pgWVaTe9HRB8qyoslkNk5E3tOOF/xfpLoxwGjSf9vYV1PZZs+GGOpKKmoIq2md6ToR2WrMQTSoqirqPZDRrzk0Wg4TdkRlWxPMpOcFUdbjgWsuN1nOXxIVNgdQyAzFGLR9+PzOiqjkuixUS4vWCZyYUrZTM+Umt5t7NE1Oqajfx1BIMcrGUOar6iQNDYlldLQzJtfTJO6k5leWbw2wnKURie7xln3850jrn8osEDIBf+TYl9ps1NVTzAgEs1F7cyzFBe08XazVmWvSLKtZrreBR9S9ruHEsh+Sl1ymV3y6PiwuCkFQK4YwhssTRPe6VDT68KZJcei+CaEQHoZbNsvUCUcqagbn6NdG3hzZJZjOToy1PTacLjC9j4WQCAnGjaZPhWrctGEjQHdur78srsD1fRKh+BqPnygHNCo9+e0g/bMz8Ws7TVhZoTlOUDkR17OWdM72nL8B8VIH3Uso72LjzZfZPl41uXY7pALQxSVQgexhMDJ7F31yXG93O8u1UmWjf3fyqBKk+0+/pWHmqDEZ1/ZIvZq4xA+SsMUxdM+wC84ZCA1r0lrG5mWqTlGKQ9Xi0PvG/kQMxPHtZdP6HF1CNakCGINH7LpeyhOlFWyUvG48uzl83HBTWfrlvlYQJ8TUFsULq6NWeupAc/bCo5Wpf5oC7uDMTEwZTPohpzH7Y1XAtG6gXz4SgBHR6qGxgFM1eyxZBInB9gC8JAYl3aS1RVkUXWZJ21qIKazgfX1ZosbOzvQOVWDFaYgT3KtZvZEbraptLUcOPrGE+cpHp0MHOnY1lB40JHz6rIocTDVacmvT8lYE9zKrLLNYG9i8i7kqQljlPu4kphdDhdYDm9J0tLLuWRI/lxEW8q1O7gIrXeE3xx51TGrWDfox3nk0D+oMj9S9cbBylFPlLt5B7oZTmFKIUthdTml7Yl07FE/A2NLvFW3RX/Oxa+wbBkrC7d5idJ3V+CkzzuZnQ1R1V+3KHHumfifzwK4itvFXIiQdDGHKyWhncw2+5KPYPtzk2HlLu5KdEhXxCWGOt2XmCx0YVgPZeHLAz0r7f4aHexfdxhnOT20nY39BC49auFAsg/nJoaxEJZbbNmbzAAUPwHugEEph176tudyHD6zz6MXB59Zzl3M4jhMy2mLCiS8tusNO6PS2t/Z9kSvl9oX0cC7tm7gn+Jbz9F2B9uczVy8NpeFUHckYYECBQoUKFCgQIECBQogIv4LvWlnC+fQsdYAAAAASUVORK5CYII=" width="100" height="100" style="filter: brightness(0) invert(1);"/></svg>' },
};
const AVATAR_COLORS = ["#2f6fde", "#8250df", "#1a7f37", "#bc4c00", "#cf222e", "#0e7f86", "#d4a72c", "#6e7781", "#D97757", "#1f2328"];

/** Per-browser avatar choices, keyed "<session>:<slot>" (and "human" for you). */
const avatarPrefs = {
  all: store.get("ma-avatars", {}),
  get(key) { return this.all[key] ?? null; },
  set(key, pref) {
    const next = { ...this.all };
    if (pref) next[key] = pref; else delete next[key];
    try { localStorage.setItem("ma-avatars", JSON.stringify(next)); } catch { throw new Error(tr("This image is too large to store in the browser.")); }
    this.all = next;
  },
};

function slotAvatarKey(slot) { return `${slot.session_id ?? state?.sessionId ?? ""}:${slot.id}`; }

/** Avatar markup from a pref ({ kind: "icon" | "text" | "image" }) with a fallback. */
function avatarHtml(pref, { type, name, color }, extra = "", attrs = "", cls = "") {
  const p = pref ?? (AGENT_ICONS[type] ? { kind: "icon" } : { kind: "text" });
  if (p.kind === "image" && p.src) {
    return `<div class="avatar has-img ${cls}" ${attrs}><img src="${esc(p.src)}" alt="">${extra}</div>`;
  }
  if (p.kind === "icon" && AGENT_ICONS[type]) {
    return `<div class="avatar has-icon ${cls}" style="background:${AGENT_ICONS[type].bg}" ${attrs}>${AGENT_ICONS[type].svg}${extra}</div>`;
  }
  if (p.kind === "person") return `<div class="avatar ${cls}" style="background:${p.color ?? color}" ${attrs}>${PERSON_SVG}${extra}</div>`;
  const text = (p.text ?? "").trim() || initials(name);
  return `<div class="avatar ${cls}" style="background:${esc(p.color ?? color)}" ${attrs}>${esc([...text].slice(0, 2).join(""))}${extra}</div>`;
}

function slotAvatar(slot, extra = "", clickable = false, size = "") {
  const attrs = clickable ? `data-avatar-slot="${slot.id}" title="${esc(tr("Change avatar"))}" role="button"` : "";
  return avatarHtml(avatarPrefs.get(slotAvatarKey(slot)), { type: slot.agent_type, name: slotName(slot), color: slotColor(slot.id) }, extra, attrs, `${clickable ? "clickable" : ""} ${size}`);
}

function humanAvatar(clickable = false) {
  const attrs = clickable ? `data-avatar-human title="${esc(tr("Change avatar"))}" role="button"` : "";
  return avatarHtml(avatarPrefs.get("human") ?? { kind: "person" }, { type: null, name: tr("You"), color: "var(--accent)" }, "", attrs, clickable ? "clickable" : "");
}

/** Read an image file and shrink it to fit max×max, as a data URL. */
function readImage(file, max, type = "image/png", quality = 0.86) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error(tr("Could not read the image")));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL(type, quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(tr("Could not read the image"))); };
    img.src = url;
  });
}

/** Avatar picker for an agent (slot) or for you (slot = null). */
function avatarModal(slot) {
  const key = slot ? slotAvatarKey(slot) : "human";
  const type = slot?.agent_type ?? null;
  const base = slot ? { type, name: slotName(slot), color: slotColor(slot.id) } : { type: null, name: tr("You"), color: "var(--accent)" };
  const current = avatarPrefs.get(key);
  let draft = current ?? (slot ? (AGENT_ICONS[type] ? { kind: "icon" } : { kind: "text" }) : { kind: "person" });
  const kinds = [
    ...(AGENT_ICONS[type] ? [["icon", "Official icon"]] : []),
    ...(slot ? [] : [["person", "Icon"]]),
    ["text", "Initials"], ["image", "Image"],
  ];
  openModal({
    title: slot ? tr("Avatar · {name}", { name: slotName(slot) }) : "Your avatar",
    sub: slot ? sessionSub(slot.session_id ?? state.sessionId) : undefined, submitLabel: "Save",
    body: `<div class="avatar-editor">
      <div class="avatar-preview" data-preview></div>
      <div class="form-grid">
        <label>Avatar</label><div class="seg" data-kinds>${kinds.map(([k, l]) => `<button type="button" class="btn small" data-kind="${k}">${esc(tr(l))}</button>`).join("")}</div>
        <label data-for="text">Text</label><input data-for="text" name="avatar_text" maxlength="2" placeholder="${esc(initials(base.name))}">
        <label data-for="color">Color</label><div data-for="color" class="swatches">${AVATAR_COLORS.map((c) => `<button type="button" class="swatch" data-color="${c}" style="background:${c}"></button>`).join("")}</div>
        <label data-for="image">Image</label><div data-for="image"><label class="btn small file-btn">Upload image…<input type="file" accept="image/*" name="file" hidden></label></div>
      </div>
      <div class="field-hint" style="margin-top:10px">${tr(slot ? "Applies to this agent in this session, in this browser." : "Customizations are saved in this browser only.")}${type === "codex" ? ` ${tr("OpenAI's icon is not bundled; upload it as an image if you like.")}` : ""}</div>
      ${current ? `<button type="button" class="btn small" data-reset style="margin-top:10px">${tr("Reset to default")}</button>` : ""}
    </div>`,
    setup: (form) => {
      const paint = () => {
        form.querySelector("[data-preview]").innerHTML = avatarHtml(draft, base);
        form.querySelectorAll("[data-kind]").forEach((b) => b.classList.toggle("primary", b.dataset.kind === draft.kind));
        form.querySelectorAll("[data-for]").forEach((el) => {
          const f = el.dataset.for;
          el.hidden = !(f === draft.kind || (f === "color" && (draft.kind === "text" || draft.kind === "person")));
        });
        form.querySelectorAll("[data-color]").forEach((b) => b.classList.toggle("on", b.dataset.color === draft.color));
      };
      form.avatar_text.value = draft.kind === "text" ? draft.text ?? "" : "";
      form.querySelector("[data-kinds]").addEventListener("click", (e) => {
        const b = e.target.closest("[data-kind]");
        if (!b) return;
        const prev = draft;
        draft = { kind: b.dataset.kind, color: prev.color };
        if (draft.kind === "text") draft.text = form.avatar_text.value;
        if (draft.kind === "image") draft.src = prev.kind === "image" ? prev.src : current?.kind === "image" ? current.src : null;
        paint();
      });
      form.avatar_text.addEventListener("input", () => { draft = { ...draft, kind: "text", text: form.avatar_text.value }; paint(); });
      form.querySelector(".swatches").addEventListener("click", (e) => {
        const b = e.target.closest("[data-color]");
        if (b) { draft = { ...draft, color: b.dataset.color }; paint(); }
      });
      form.file.addEventListener("change", async () => {
        try { draft = { kind: "image", src: await readImage(form.file.files[0], 160) }; paint(); }
        catch (err) { toast(err.message, "error"); }
      });
      form.querySelector("[data-reset]")?.addEventListener("click", () => {
        avatarPrefs.set(key, null);
        closeModal();
        rerenderAll();
      });
      paint();
    },
    onSubmit: async () => {
      if (draft.kind === "image" && !draft.src) throw new Error(tr("Could not read the image"));
      avatarPrefs.set(key, draft);
      toast(tr("Avatar saved"), "ok");
      rerenderAll();
    },
  });
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-avatar-slot], [data-avatar-human]");
  if (!el || !state) return;
  e.stopPropagation();
  if (el.hasAttribute("data-avatar-human")) return avatarModal(null);
  const slot = slotById(parseInt(el.dataset.avatarSlot, 10));
  if (slot) avatarModal(slot);
}, true);

// --- Appearance: a background image under the whole page ---

const APPEARANCE_DEFAULT = { image: null, imageOpacity: 0.7, panelOpacity: 0.75, blur: true };

function appearance() { return { ...APPEARANCE_DEFAULT, ...store.get("ma-appearance", {}) }; }

function saveAppearance(next) {
  try { localStorage.setItem("ma-appearance", JSON.stringify(next)); }
  catch { throw new Error(tr("This image is too large to store in the browser.")); }
}

function applyAppearance(a = appearance()) {
  const root = document.documentElement;
  const layer = $("app-bg");
  root.classList.toggle("has-bg", !!a.image);
  root.classList.toggle("bg-blur", !!a.image && !!a.blur);
  layer.style.backgroundImage = a.image ? `url("${a.image}")` : "";
  layer.style.opacity = String(a.imageOpacity);
  root.style.setProperty("--panel-alpha", `${Math.round(a.panelOpacity * 100)}%`);
}

function appearanceModal() {
  const saved = appearance();
  let draft = { ...saved };
  const pct = (v) => `${Math.round(v * 100)}%`;
  openModal({
    title: "Appearance", submitLabel: "Done",
    body: `<div class="form-grid">
        <label>Background image</label><div class="flex gap-2 items-center">
          <label class="btn small file-btn">Choose image…<input type="file" accept="image/*" name="file" hidden></label>
          <button type="button" class="btn small" data-remove-bg>Remove image</button></div>
        <label>Image opacity</label><div class="range-row"><input type="range" name="imageOpacity" min="0.05" max="1" step="0.05" value="${draft.imageOpacity}"><span data-out="imageOpacity">${pct(draft.imageOpacity)}</span></div>
        <label>Panel opacity</label><div class="range-row"><input type="range" name="panelOpacity" min="0.2" max="1" step="0.02" value="${draft.panelOpacity}"><span data-out="panelOpacity">${pct(draft.panelOpacity)}</span></div>
        <label></label><label class="checkbox"><input type="checkbox" name="bg_blur" ${draft.blur ? "checked" : ""}><span>Blur behind panels</span></label>
        <label>Your avatar</label><div class="flex items-center gap-2"><span data-own-avatar title="${esc(tr("Change avatar"))}" role="button">${humanAvatar().replace('class="avatar', 'class="avatar clickable')}</span><span class="field-hint">${tr("Click the avatar to change it.")}</span></div>
      </div>
      <div class="field-hint" style="margin-top:10px">${tr("The image sits under the whole page. Lower the panel opacity to let more of it show through.")} ${tr("Customizations are saved in this browser only.")}</div>
      <button type="button" class="btn small" data-reset style="margin-top:10px">${tr("Reset appearance")}</button>`,
    setup: (form) => {
      const sync = () => {
        form.querySelector("[data-remove-bg]").disabled = !draft.image;
        for (const k of ["imageOpacity", "panelOpacity"]) form.querySelector(`[data-out="${k}"]`).textContent = pct(draft[k]);
        applyAppearance(draft);
      };
      for (const k of ["imageOpacity", "panelOpacity"]) form[k].addEventListener("input", () => { draft[k] = Number(form[k].value); sync(); });
      form.bg_blur.addEventListener("change", () => { draft.blur = form.bg_blur.checked; sync(); });
      form.file.addEventListener("change", async () => {
        try { draft.image = await readImage(form.file.files[0], 1920, "image/jpeg", 0.82); sync(); }
        catch (err) { toast(err.message, "error"); }
      });
      form.querySelector("[data-remove-bg]").addEventListener("click", () => { draft.image = null; sync(); });
      // Keep what was set here, then switch to the avatar picker
      form.querySelector("[data-own-avatar]").addEventListener("click", () => {
        try { saveAppearance(draft); } catch (err) { return toast(err.message, "error"); }
        avatarModal(null);
      });
      form.querySelector("[data-reset]").addEventListener("click", () => {
        draft = { ...APPEARANCE_DEFAULT };
        form.imageOpacity.value = draft.imageOpacity; form.panelOpacity.value = draft.panelOpacity; form.bg_blur.checked = draft.blur;
        sync();
      });
      sync();
    },
    onSubmit: async () => { saveAppearance(draft); },
    onCancel: () => applyAppearance(),
  });
}

function senderOf(m) {
  if (m.from_id === "human") return { key: "human", name: tr("You"), me: true, color: "var(--accent)" };
  if (m.from_id === "orchestrator" || m.from_id === "__orchestrator__") return { key: "orchestrator", name: tr("Orchestrator"), color: "#6e7781", role: tr("system") };
  if (m.from_id === "cli") return { key: "cli", name: "CLI", color: "#6e7781" };
  const slot = (m.from_slot_id != null ? slotById(m.from_slot_id) : null) ?? state.slots.find((s) => s.peer_id === m.from_id);
  if (slot) return { key: `slot:${slot.id}`, name: slotName(slot), role: slot.role, color: slotColor(slot.id), slot };
  return { key: `peer:${m.from_id}`, name: m.from_display_name ?? m.from_id ?? "?", color: "#6e7781" };
}

function recipientOf(m) {
  if (m.to_slot_id != null) { const s = slotById(m.to_slot_id); if (s) return slotName(s); }
  if (m.to_id === "human") return tr("You");
  if (m.to_id === "orchestrator" || m.to_id === "__orchestrator__") return tr("Orchestrator");
  return m.to_display_name ?? m.to_id ?? "?";
}

function systemText(m) {
  const t = m.text ?? "";
  try {
    const j = JSON.parse(t);
    if (m.msg_type === "control" && j.action) return `${tr(j.action)}${j.reason ? ` — ${tr(j.reason)}` : ""}`;
    if (m.msg_type === "role_assignment" && j.role) return tr("role set to {role}", { role: j.role });
    if (m.msg_type === "rename" && j.display_name) return tr("renamed to {name}", { name: j.display_name });
  } catch { /* plain text */ }
  // Q&A mode announcements are long instructions for the agents; people get the gist
  if (t.startsWith("[HOLD — Q&A MODE]")) return tr("Q&A mode started — work is on hold");
  if (t.startsWith("[RESUME]")) return tr("Q&A mode ended — work resumes");
  return t.replace(/\s+/g, " ");
}

/** Messages in display order, with one-to-many sends (broadcasts, done notices) folded into one item. */
function chatItems() {
  const showSystem = $("msg-show-system").checked;
  const filter = $("msg-filter-agent").value;
  let msgs = state.messages;
  if (!showSystem) msgs = msgs.filter((m) => !isSystemMessage(m));
  if (filter) {
    const id = parseInt(filter, 10);
    const peer = slotById(id)?.peer_id;
    msgs = msgs.filter((m) => m.from_slot_id === id || m.to_slot_id === id || (peer && (m.from_id === peer || m.to_id === peer)));
  }
  const items = [];
  for (const m of msgs) {
    const t = new Date(m.sent_at).getTime();
    const prev = items[items.length - 1];
    if (prev && prev.m.from_id === m.from_id && prev.m.text === m.text && prev.m.msg_type === m.msg_type && Math.abs(t - prev.t) < 5000) {
      prev.to.add(recipientOf(m));
      continue;
    }
    items.push({ m, t, to: new Set([recipientOf(m)]) });
  }
  return items;
}

function renderChat(force) {
  const feed = $("msg-feed");
  const sig = [state.sessionId, state.messages.length, state.messages.at(-1)?.id, $("msg-show-system").checked, $("msg-filter-agent").value,
    state.slots.map((s) => `${s.id}:${s.display_name}:${s.role}`).join(","), document.documentElement.dataset.theme].join("|");
  if (!force && sig === lastChatSignature) return;
  const firstRender = !lastChatSignature;
  lastChatSignature = sig;

  const curSid = currentSid();
  if (curSid && !$("composer-text").value) {
    try {
      const saved = localStorage.getItem(`multiagents:draft:composer:${curSid}`);
      if (saved) { $("composer-text").value = saved; autosize(); }
    } catch {}
  }
  if (!state.session) {
    feed.innerHTML = `<div class="chat-empty">${state.brokerAlive ? `${tr("No session selected.")}<br><button class="btn primary" data-action="new-team" style="margin-top:12px">${tr("+ New Team")}</button>` : tr("Broker is not running.")}</div>`;
    $("chat-count").textContent = "";
    return;
  }
  const items = chatItems();
  $("chat-count").textContent = tr(items.length === 1 ? "{n} message" : "{n} messages", { n: items.length });
  if (!items.length) {
    feed.innerHTML = `<div class="chat-empty">${tr("No messages yet. Say something to the team below.")}</div>`;
    return;
  }

  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  const prevHeight = feed.scrollHeight;
  let html = "", lastDay = "", lastSender = null, lastTime = 0;
  for (const { m, t, to } of items) {
    const day = new Date(t).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      html += `<div class="day-sep"><span>${esc(fmtDay(t))}</span></div>`;
      lastSender = null;
    }
    const sender = senderOf(m);
    if (isSystemMessage(m)) {
      const target = to.size > 1 ? tr("everyone") : [...to][0];
      html += `<div class="sys-note"><span title="${esc(fmtTime(m.sent_at))} · ${esc(m.msg_type)}">${esc(sender.name)} &rarr; ${esc(target)}: ${esc(systemText(m))}</span></div>`;
      lastSender = null;
      continue;
    }
    const cont = lastSender === sender.key && t - lastTime < 3 * 60_000 && to.size === 1;
    lastSender = sender.key;
    lastTime = t;
    const toLabel = m.msg_type === "broadcast" || to.size > 2 ? tr("everyone") : [...to].join(", ");
    const text = m.text ?? "";
    const long = !expandedMessages.has(m.id) && (text.length > 1500 || text.split("\n").length > 24);
    const kind = m.msg_type !== "chat" ? m.msg_type : "";
    html += `<div class="msg${sender.me ? " me" : ""}${cont ? " cont" : ""}">
      ${sender.slot ? slotAvatar(sender.slot) : sender.me ? humanAvatar() : avatar(sender.name, sender.color)}
      <div class="msg-body">
        <div class="msg-head">
          <span class="msg-name">${esc(sender.name)}</span>
          ${sender.role ? `<span class="msg-role">${esc(sender.role)}</span>` : ""}
          <span class="msg-to">&rarr; ${esc(toLabel)}</span>
          ${kind ? `<span class="kind-tag ${esc(kind)}">${esc(tr(kind.replace(/_/g, " ")))}</span>` : ""}
          <span class="msg-time">${esc(fmtTime(m.sent_at))}</span>
        </div>
        <div class="bubble rich${kind ? ` kind-${esc(kind)}` : ""}${long ? " collapsed" : ""}" data-mid="${m.id}" title="${cont ? esc(fmtTime(m.sent_at)) : ""}">${renderMarkdown(text, { chat: true })}</div>
      </div>
    </div>`;
  }
  feed.innerHTML = html;
  hydrateFileRefs(feed);
  renderLive();

  if (atBottom || force || firstRender) {
    feed.scrollTop = feed.scrollHeight;
    $("jump-new").classList.add("hidden");
  } else if (feed.scrollHeight > prevHeight) {
    $("jump-new").classList.remove("hidden");
  }
}

// --- Live: agents working right now (typing dots, thinking as it streams) ---

const liveView = { data: {}, sid: null, el: document.createElement("div"), expanded: store.get("ma-live-expanded", true), polling: false };
liveView.el.id = "chat-live";

const LIVE_PHASE = { waiting: "Working", thinking: "Thinking", writing: "Writing a reply", tool: "Running a tool" };

function renderLive() {
  const feed = $("msg-feed");
  const el = liveView.el;
  if (!state?.session) { el.replaceChildren(); return; }
  if (el.parentNode !== feed || feed.lastElementChild !== el) feed.appendChild(el);
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  const busy = Object.entries(liveView.sid === state.sessionId ? liveView.data : {})
    .map(([id, l]) => ({ slot: slotById(Number(id)), l }))
    .filter(({ slot, l }) => slot && l.busy);
  // Agents with no live report (another host, an older broker, an interactive CLI) still show
  // they were asked something and have not answered yet
  const reported = new Set(busy.map(({ slot }) => slot.id));
  for (const w of awaitingReply()) if (!reported.has(w.slot.id)) busy.push(w);
  const keep = new Set(busy.map(({ slot }) => String(slot.id)));
  for (const row of [...el.children]) if (!keep.has(row.dataset.slot)) row.remove();
  for (const { slot, l } of busy) {
    let row = el.querySelector(`[data-slot="${slot.id}"]`);
    if (!row) {
      row = document.createElement("div");
      row.className = "msg live-row";
      row.dataset.slot = String(slot.id);
      row.innerHTML = `${slotAvatar(slot)}<div class="msg-body">
        <div class="msg-head"><span class="msg-name"></span><span class="msg-role"></span></div>
        <div class="bubble live-bubble"><div class="live-status"><span class="live-label"></span><span class="typing-dots"><i></i><i></i><i></i></span><span class="live-time"></span></div>
          <div class="live-text-wrap"><div class="live-text-head"><span class="live-text-label"></span><button type="button" class="btn ghost small" data-live-toggle></button></div><div class="live-text"></div></div></div>
      </div>`;
      el.appendChild(row);
    }
    row.querySelector(".msg-name").textContent = slotName(slot);
    row.querySelector(".msg-role").textContent = slot.role ?? "";
    const label = l.awaiting ? tr("Has not answered yet") : l.phase === "tool" && l.tool ? tr("Running {tool}", { tool: tr(l.tool) }) : tr(LIVE_PHASE[l.phase] ?? "Working");
    row.querySelector(".live-label").textContent = label;
    row.querySelector(".live-time").textContent = l.since ? fmtDuration(Date.now() - l.since) : "";
    const wrap = row.querySelector(".live-text-wrap");
    const hasText = !!l.text && (l.phase === "thinking" || l.phase === "writing");
    wrap.hidden = !hasText;
    if (hasText) {
      wrap.classList.toggle("expanded", liveView.expanded);
      row.querySelector(".live-text-label").textContent = tr(l.phase === "thinking" ? "Thinking" : "Reply so far");
      row.querySelector("[data-live-toggle]").textContent = tr(liveView.expanded ? "Collapse" : "Expand");
      const box = row.querySelector(".live-text");
      const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
      if (box.textContent !== l.text) box.textContent = l.text;
      if (stick) box.scrollTop = box.scrollHeight;
    }
  }
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

liveView.el.addEventListener("click", (e) => {
  if (!e.target.closest("[data-live-toggle]")) return;
  liveView.expanded = !liveView.expanded;
  store.set("ma-live-expanded", liveView.expanded);
  renderLive();
});

const AWAIT_REPLY_MS = 20 * 60_000;
const NOT_A_QUESTION = new Set(["system", "control", "rename", "role_assignment", "team_change", "approval", "release"]);

/** Agents that got a message from you or a teammate after their own last message. */
function awaitingReply() {
  const lastIn = new Map(), lastOut = new Map();
  for (const m of state.messages) {
    const t = Date.parse(m.sent_at);
    if (m.from_slot_id != null) lastOut.set(m.from_slot_id, Math.max(lastOut.get(m.from_slot_id) ?? 0, t));
    const fromPerson = m.from_id === "human";
    const fromTeammate = m.from_slot_id != null && m.from_slot_id !== m.to_slot_id;
    if (m.to_slot_id != null && (fromPerson || fromTeammate) && !NOT_A_QUESTION.has(m.msg_type)) {
      lastIn.set(m.to_slot_id, Math.max(lastIn.get(m.to_slot_id) ?? 0, t));
    }
  }
  const out = [];
  for (const [slotId, t] of lastIn) {
    const slot = slotById(slotId);
    if (!slot || slot.task_state === "released" || isPaused(slot) || slot.status !== "connected" && !(state.managedSlots ?? []).includes(slot.id)) continue;
    if ((lastOut.get(slotId) ?? 0) >= t || Date.now() - t > AWAIT_REPLY_MS) continue;
    out.push({ slot, l: { busy: true, phase: "waiting", text: "", tool: null, since: t, awaiting: true } });
  }
  return out;
}

/** Fast poll while the chat is open and someone is working (state pushes cover the rest). */
async function pollLive() {
  if (liveView.polling || !state?.sessionId || document.hidden || activeTab !== "chat") return;
  const anyBusy = Object.values(liveView.data).some((l) => l.busy);
  if (!anyBusy && Date.now() - (liveView.at ?? 0) < 3_000) return;
  liveView.polling = true;
  const sid = state.sessionId;
  try {
    const data = await api(`live?session_id=${encodeURIComponent(sid)}`);
    if (sid === state?.sessionId) { liveView.data = data ?? {}; liveView.sid = sid; liveView.at = Date.now(); renderLive(); }
  } catch { /* next tick */ } finally {
    liveView.polling = false;
  }
}
setInterval(pollLive, 800);

$("msg-feed").addEventListener("click", (e) => {
  const b = e.target.closest(".bubble.collapsed");
  if (b && !e.target.closest(".file-link, a")) { expandedMessages.add(Number(b.dataset.mid)); b.classList.remove("collapsed"); }
  const note = e.target.closest(".sys-note > span");
  if (note) note.classList.toggle("open");
});
$("msg-feed").addEventListener("scroll", () => {
  const feed = $("msg-feed");
  if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80) $("jump-new").classList.add("hidden");
});
$("jump-new").addEventListener("click", () => { const f = $("msg-feed"); f.scrollTop = f.scrollHeight; $("jump-new").classList.add("hidden"); });
$("msg-show-system").addEventListener("change", () => { store.set("ma-show-system", $("msg-show-system").checked); render(true); });
$("msg-filter-agent").addEventListener("change", () => render(true));

/** Keep the agent dropdowns in sync with the session's slots (preserving the selection). */
function refreshAgentSelects() {
  const live = liveSlots();
  const opts = (list) => list.map((s) => `<option value="${s.id}">${esc(slotName(s))}${s.role ? ` · ${esc(s.role)}` : ""}</option>`).join("");
  fillSelect("composer-to", `<option value="all">${tr("Everyone")}</option>` + opts(live));
  fillSelect("msg-filter-agent", `<option value="">${tr("everyone")}</option>` + opts(state.slots));
  fillSelect("act-agent", `<option value="">${tr("all agents")}</option>` + opts(state.slots));
  fillSelect("plan-add-assignee", `<option value="">${tr("unassigned")}</option>` + opts(live));
  fillSelect("lock-agent", opts(live));
  fillSelect("own-agent", opts(live));
  const to = $("composer-to").value;
  const slot = to === "all" ? null : slotById(parseInt(to, 10));
  $("composer-target-hint").textContent = slot
    ? `${taskLabel(slot.task_state)}${isPaused(slot) ? tr(" · paused (held until resume)") : ""}`
    : tr("{n} online", { n: live.filter((s) => s.status === "connected" && !isPaused(s)).length });
  $("composer-send").disabled = !state.session || state.session.status === "archived";
  // Interrupting is for one agent; in Q&A mode nobody is working anyway
  $("composer-interrupt-wrap").hidden = !slot || state.qaMode;
}

function fillSelect(id, html) {
  const el = $(id);
  if (!el || el.dataset.html === html || document.activeElement === el) return;
  const prev = el.value;
  el.innerHTML = html;
  el.dataset.html = html;
  if ([...el.options].some((o) => o.value === prev)) el.value = prev;
}

function autosize() {
  const ta = $("composer-text");
  ta.style.height = "auto";
  ta.style.height = `${Math.min(220, ta.scrollHeight)}px`;
}

async function sendComposer() {
  const sid = currentSid();
  if (sid == null) return;
  const ta = $("composer-text");
  const text = ta.value.trim();
  if (!text) return;
  const to = $("composer-to").value;
  const interrupt = to !== "all" && $("composer-interrupt").checked;
  const r = await run($("composer-send"), "Send", () => api("messages/send", { session_id: sid, slot_id: to === "all" ? "all" : parseInt(to, 10), text, interrupt }));
  if (r) {
    ta.value = "";
    autosize();
    try { localStorage.removeItem(`multiagents:draft:composer:${sid}`); } catch {}
    const f = $("msg-feed");
    f.scrollTop = f.scrollHeight;
  }
}

$("composer-send").addEventListener("click", sendComposer);
$("composer-text").addEventListener("input", () => {
  autosize();
  const sid = currentSid();
  if (sid) {
    try {
      const val = $("composer-text").value;
      if (val) localStorage.setItem(`multiagents:draft:composer:${sid}`, val);
      else localStorage.removeItem(`multiagents:draft:composer:${sid}`);
    } catch {}
  }
});
$("composer-text").addEventListener("keydown", (e) => {
  // Enter sends; Shift+Enter is a new line; an IME composition (Chinese/Japanese input) is never cut off
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendComposer(); }
});
$("composer-to").addEventListener("change", refreshAgentSelects);
$("composer-presets").addEventListener("click", (e) => {
  e.stopPropagation();
  openMenu($("composer-presets"), PRESETS.map((t) => ({ label: tr(t), onClick: () => { $("composer-text").value = tr(t); autosize(); $("composer-text").focus(); } })));
});

const PRESETS = [
  "Stop editing files and explain your current reasoning.",
  "Do not proceed until human approval.",
  "Summarize your progress and what is left.",
  "List the files you changed and why.",
];

// --- Session bar & gate ---

function renderSessionBar() {
  const s = state.session;
  $("sb-name").textContent = s ? (s.name || s.id) : (state.sessionId ?? tr("No session selected"));
  const b = s ? sessionBadge() : null;
  $("sb-status").innerHTML = b ? `<span class="badge ${b.cls}">${b.text}</span>` : "";
  $("sb-gate").innerHTML = s
    ? `<span class="badge ${state.humanGate ? "badge-review" : "badge-idle"}" style="cursor:pointer" data-action="toggle-gate" title="${tr("Human gate: when on, approved work waits for your release instead of auto-ending")}">${tr(state.humanGate ? "human gate on" : "human gate off")}</span>`
    : "";
  $("sb-meta").textContent = s
    ? `${s.project_dir}${state.managed ? tr(" · agents run under this dashboard") : ""}`
    : tr("Create a team with + New Team, or pick a session on the left.");
  $("sb-meta").title = s ? `${s.id} · ${s.project_dir}` : "";

  const has = !!s, archived = s?.status === "archived", paused = s?.status === "paused";
  const tb = $("session-toolbar");
  tb.querySelector('[data-action="session-pause"]').disabled = !has || archived || paused;
  tb.querySelector('[data-action="session-resume"]').disabled = !has || archived || !paused;
  tb.querySelector('[data-action="add-agent"]').disabled = !has || archived;
  tb.querySelector('[data-action="release-menu"]').disabled = !has;
  tb.querySelector('[data-action="session-menu"]').disabled = !has;
}

function renderBrokerBanner() {
  const el = $("broker-banner");
  if (!state.brokerMissing?.length) { el.className = "hidden"; el.innerHTML = ""; return; }
  el.className = "banner";
  el.innerHTML = `<span class="banner-title">&#9888; ${tr("The broker runs older code")}</span>
    <span class="dim">${tr("It was started before an update, so replies to you, Q&A mode and the live thinking view do not work yet. Restarting it keeps sessions, messages and running agents.")}</span>
    <span class="toolbar"><button class="btn primary" data-action="broker-restart">${tr("Restart broker")}</button></span>`;
}

function renderQaBanner() {
  const el = $("qa-banner");
  $("qa-btn").innerHTML = state.qaMode ? `&#9654; ${esc(tr("End Q&A"))}` : `&#9995; ${esc(tr("Q&A mode"))}`;
  $("qa-btn").classList.toggle("primary", !!state.qaMode);
  if (!state.qaMode || !state.session) { el.className = "hidden"; el.innerHTML = ""; return; }
  el.className = "banner qa";
  el.innerHTML = `<span class="banner-title">&#9995; ${tr("Q&A mode — work is on hold")}</span>
    <span class="dim">${tr("Agents stopped their tasks and only answer you. Pick an agent under To and ask; teammates' messages wait until you end Q&A.")}</span>
    <span class="toolbar"><button class="btn primary" data-action="toggle-qa">${tr("End Q&A, resume work")}</button></span>`;
}

function renderGateBanner() {
  const el = $("gate-banner");
  if (!state.awaitingHuman) { el.className = "hidden"; el.innerHTML = ""; return; }
  el.className = "banner";
  el.innerHTML = `<span class="banner-title">&#9888; ${tr("Waiting for your approval")}</span>
    <span class="dim">${tr("Every agent is approved. Review the work, then release it or send it back.")}</span>
    <span class="toolbar">
      <button class="btn danger" data-action="gate-sendback">${tr("Send back for revision")}</button>
      <button class="btn primary" data-action="gate-release">${tr("Approve & Release")}</button>
    </span>`;
}

// --- Agents ---

const TASK_LABEL = {
  idle: "idle", working: "working", done_pending_review: "in review",
  addressing_feedback: "addressing feedback", approved: "approved", released: "released",
};
function taskLabel(state) { return tr(TASK_LABEL[state] ?? state); }

const TASK_CLASS = {
  idle: "badge-idle", working: "badge-working", done_pending_review: "badge-review",
  addressing_feedback: "badge-feedback", approved: "badge-approved", released: "badge-released",
};

function taskBadge(taskState) {
  return `<span class="badge ${TASK_CLASS[taskState] ?? "badge-idle"}" title="task_state: ${esc(taskState)}">${esc(taskLabel(taskState))}</span>`;
}

function connBadge(status) {
  return status === "connected" ? `<span class="badge badge-connected">${tr("online")}</span>` : `<span class="badge badge-disconnected">${tr("offline")}</span>`;
}

function slotSummary(slot) {
  const peer = slot.peer_id ? state.peers.find((p) => p.id === slot.peer_id) : null;
  if (peer?.summary) return peer.summary;
  try { return JSON.parse(slot.context_snapshot ?? "{}")?.last_summary ?? null; } catch { return null; }
}

function renderAgents() {
  const el = $("panel-agents");
  if (busyRegion(el)) return;
  const curSid = currentSid();
  if (curSid && !$("composer-text").value) {
    try {
      const saved = localStorage.getItem(`multiagents:draft:composer:${curSid}`);
      if (saved) { $("composer-text").value = saved; autosize(); }
    } catch {}
  }
  if (!state.session) {
    el.innerHTML = `<div class="empty">${state.brokerAlive ? tr("No session selected.") : tr("Broker is not running.")}<br><button class="btn primary" data-action="new-team">${tr("+ New Team")}</button></div>`;
    return;
  }
  if (!state.slots.length) {
    el.innerHTML = `<div class="empty">${tr("No agents in this session")}<br><button class="btn primary" data-action="add-agent">${tr("+ Add Agent")}</button></div>`;
    return;
  }
  const archived = state.session.status === "archived";
  const managed = new Set(state.managedSlots ?? []);
  el.innerHTML = `<div class="agents-grid">${state.slots.map((slot) => {
    const summary = slotSummary(slot);
    const released = slot.task_state === "released";
    const paused = isPaused(slot);
    const reviewable = slot.task_state === "approved" || slot.task_state === "done_pending_review";
    const id = slot.id;
    const tokens = usageLine(slot);
    const actions = released || archived
      ? `<button class="btn small danger" data-agent="remove" data-slot="${id}" ${archived ? "disabled" : ""}>${tr(released ? "Delete" : "Remove")}</button>`
      : `<button class="btn small primary" data-agent="message" data-slot="${id}">${tr("Message")}</button>
        ${paused ? `<button class="btn small success" data-agent="resume" data-slot="${id}">${tr("Resume")}</button>` : `<button class="btn small warn" data-agent="pause" data-slot="${id}">${tr("Pause")}</button>`}
        <button class="btn small" data-agent="settings" data-slot="${id}">${tr("Settings")}</button>
        <button class="btn small" data-agent="activity" data-slot="${id}">${tr("Activity")}</button>
        <button class="btn small" data-agent="role" data-slot="${id}">${tr("Role")}</button>
        <button class="btn small" data-agent="rename" data-slot="${id}">${tr("Rename")}</button>
        ${reviewable ? `<button class="btn small warn" data-agent="sendback" data-slot="${id}">${tr("Send Back")}</button>` : ""}
        <button class="btn small ${slot.task_state === "approved" ? "success" : ""}" data-agent="release" data-slot="${id}">${tr("Release")}</button>
        <button class="btn small danger" data-agent="remove" data-slot="${id}">${tr("Remove")}</button>`;
    return `<div class="agent-card${slot.task_state === "approved" ? " approved" : ""}">
      <div class="agent-head">
        ${slotAvatar(slot, "", true)}
        <div class="agent-title"><div class="agent-name">${esc(slotName(slot))}</div><div class="agent-role">${esc(slot.role ?? tr("no role"))} · ${esc(agentTypeLabel(slot))}</div></div>
        ${connBadge(slot.status)}
      </div>
      <div class="agent-badges">
        ${taskBadge(slot.task_state ?? "idle")}
        ${paused ? `<span class="badge badge-paused">${tr("paused")}</span>` : ""}
        ${managed.has(id) ? `<span class="badge badge-managed" title="${tr("This dashboard launched and supervises the agent process")}">${tr("managed here")}</span>` : ""}
        ${settingsBadges(slot)}
      </div>
      <div class="agent-ids" title="${tr("slot id = stable seat in the session; peer id = the running process's registration")}">${tr("slot #{id} · peer {peer}", { id, peer: esc(slot.peer_id ?? "—") })}</div>
      ${tokens}
      ${summary ? `<div class="agent-summary rich">${inline(truncate(summary, 260))}</div>` : ""}
      <div class="agent-actions">${actions}</div>
    </div>`;
  }).join("")}</div>`;
  hydrateFileRefs(el);
}

function renderRoster() {
  const el = $("rpanel-team");
  if ($("rpanel-team").classList.contains("hidden") || busyRegion(el)) return;
  const curSid = currentSid();
  if (curSid && !$("composer-text").value) {
    try {
      const saved = localStorage.getItem(`multiagents:draft:composer:${curSid}`);
      if (saved) { $("composer-text").value = saved; autosize(); }
    } catch {}
  }
  if (!state.session) { el.innerHTML = `<div class="empty">${tr("No session selected")}</div>`; return; }
  if (!state.slots.length) { el.innerHTML = `<div class="empty">${tr("No agents yet")}<br><button class="btn primary" data-action="add-agent">${tr("+ Add Agent")}</button></div>`; return; }
  const order = (s) => (s.task_state === "released" ? 2 : s.status === "connected" ? 0 : 1);
  el.innerHTML = [...state.slots].sort((a, b) => order(a) - order(b) || a.id - b.id).map((slot) => {
    const statusColor = isPaused(slot) ? "var(--yellow)" : slot.status === "connected" ? "var(--green)" : "var(--text-muted)";
    const summary = slotSummary(slot);
    return `<div class="roster-item" data-roster="${slot.id}" style="${slot.task_state === "released" ? "opacity:.55" : ""}">
      ${slotAvatar(slot, `<span class="status" style="background:${statusColor}"></span>`)}
      <div class="roster-main">
        <div class="roster-name">${esc(slotName(slot))} <span class="muted" style="font-weight:400;font-size:11.5px">${esc(slot.role ?? "")}</span></div>
        <div class="roster-sub">${esc(taskLabel(slot.task_state))}${isPaused(slot) ? ` · ${tr("paused")}` : ""}${summary ? ` · ${esc(truncate(summary, 80))}` : ""}</div>
      </div>
      <button class="icon-btn" data-roster-menu="${slot.id}" title="${tr("Actions")}">&#8943;</button>
    </div>`;
  }).join("");
}

$("rpanel-team").addEventListener("click", (e) => {
  const menuBtn = e.target.closest("[data-roster-menu]");
  const slot = slotById(parseInt(e.target.closest("[data-roster]")?.dataset.roster, 10));
  if (!slot) return;
  if (menuBtn) {
    e.stopPropagation();
    const released = slot.task_state === "released";
    const items = [
      { label: "Message", disabled: released, onClick: () => agentAction("message", slot) },
      isPaused(slot) ? { label: "Resume", disabled: released, onClick: () => agentAction("resume", slot) } : { label: "Pause", disabled: released, onClick: () => agentAction("pause", slot) },
      { label: "Settings (model, approvals, limit)", disabled: released, onClick: () => agentAction("settings", slot) },
      { label: "Show activity", onClick: () => agentAction("activity", slot) },
      { label: "Change role", disabled: released, onClick: () => agentAction("role", slot) },
      { label: "Rename", disabled: released, onClick: () => agentAction("rename", slot) },
      { label: "Send back for revision", disabled: released, onClick: () => agentAction("sendback", slot) },
      { sep: true },
      { label: "Release", disabled: released, onClick: () => agentAction("release", slot) },
      { label: "Remove", danger: true, onClick: () => agentAction("remove", slot) },
    ];
    openMenu(menuBtn, items);
    return;
  }
  // A click on a teammate addresses the composer to them
  if (slot.task_state !== "released") {
    switchTab("chat");
    $("composer-to").value = String(slot.id);
    refreshAgentSelects();
    $("composer-text").focus();
  }
});

$("panel-agents").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-agent]");
  if (!btn) return;
  const slot = slotById(parseInt(btn.dataset.slot, 10));
  if (slot) agentAction(btn.dataset.agent, slot, btn);
});

async function agentAction(kind, slot, btn) {
  const sid = currentSid();
  if (sid == null) return;
  const name = slotName(slot);
  switch (kind) {
    case "message":
      switchTab("chat");
      $("composer-to").value = String(slot.id);
      refreshAgentSelects();
      $("composer-text").focus();
      return;
    case "pause":
      return run(btn, "Pause", () => api("agents/control", { session_id: sid, slot_id: slot.id, action: "pause" }));
    case "resume":
      return run(btn, "Resume", () => api("agents/control", { session_id: sid, slot_id: slot.id, action: "resume" }));
    case "rename": {
      const v = await promptDialog({ title: tr("Rename {name}", { name }), sid, label: "Display name", value: slot.display_name ?? "" });
      if (v) return run(null, "Rename", () => api("agents/rename", { session_id: sid, slot_id: slot.id, display_name: v }));
      return;
    }
    case "role": return roleModal(sid, slot);
    case "settings": return settingsModal(sid, slot);
    case "activity":
      $("act-agent").value = String(slot.id);
      switchTab("activity");
      return;
    case "sendback": return sendBackModal(sid, slot.id);
    case "release": {
      const notApproved = slot.task_state !== "approved";
      const ok = await confirmDialog({
        title: tr("Release {name}?", { name }), sid,
        message: `<p>${tr("Releasing tells {name} its work is complete; it disconnects once idle.", { name: esc(name) })}</p>` +
          (notApproved ? `<p style="color:var(--yellow)">&#9888; ${tr("{name} is <b>{state}</b>, not approved.", { name: esc(name), state: esc(taskLabel(slot.task_state)) })}</p>` : ""),
        confirmLabel: "Release", danger: notApproved,
      });
      if (ok) return run(btn, "Release", () => api("agents/release", { session_id: sid, slot_id: slot.id }));
      return;
    }
    case "remove": {
      const isReleased = slot.task_state === "released";
      const ok = await confirmDialog({
        title: isReleased ? tr("Delete \"{name}\" permanently?", { name }) : tr("Remove {name}?", { name }), sid,
        message: isReleased
          ? `<p>${tr("This permanently removes the seat and clears this card from the board.")}</p>`
          : `<p>${tr("Remove stops the agent now (if this dashboard runs it), marks it released and tells the team it left. Unlike <b>Release</b>, it does not wait for the agent to finish.")}</p>`,
        confirmLabel: isReleased ? "Delete forever" : "Remove", danger: true,
      });
      if (ok) return run(btn, isReleased ? "Delete" : "Remove", () => api("agents/remove", { session_id: sid, slot_id: slot.id }));
      return;
    }
  }
}

// --- Plan ---

const PLAN_ICON = { done: "&#10003;", in_progress: "&#9654;", blocked: "&#10007;", pending: "&#9675;" };

function renderPlan() {
  const el = $("plan-list");
  if (busyRegion(el)) return;
  if (!state.plan?.plan) {
    el.innerHTML = `<div class="empty">${state.session ? tr("No plan yet — add the first task above.") : tr("No session selected")}</div>`;
    return;
  }
  const { plan, items, completion } = state.plan;
  const itemsHtml = items.map((item) => {
    const assigneeOpts = `<option value="">${tr("unassigned")}</option>` + state.slots
      .filter((s) => s.task_state !== "released" || s.id === item.assigned_to_slot)
      .map((s) => `<option value="${s.id}" ${s.id === item.assigned_to_slot ? "selected" : ""}>${esc(slotName(s))}</option>`).join("");
    const statusOpts = ["pending", "in_progress", "blocked", "done"]
      .map((st) => `<option value="${st}" ${st === item.status ? "selected" : ""}>${tr(st.replace("_", " "))}</option>`).join("");
    return `<div class="plan-item ${esc(item.status)}" data-item="${item.id}">
      <span class="plan-check ${esc(item.status)}">${PLAN_ICON[item.status] ?? PLAN_ICON.pending}</span>
      <span class="plan-label" data-plan="edit" title="${tr("Click to edit")}">${esc(item.label)}</span>
      <select data-plan="status">${statusOpts}</select>
      <select data-plan="assignee">${assigneeOpts}</select>
      <button class="icon-btn" data-plan="delete" title="${tr("Delete task")}">&#10005;</button>
    </div>`;
  }).join("");
  el.innerHTML = `<div class="card">
    <div class="card-header"><div class="plan-header">
      <span class="plan-title">${esc(plan.title)}</span>
      <div class="progress-bar"><div class="progress-fill" style="width:${completion}%"></div></div>
      <span class="plan-pct">${completion}%</span>
    </div></div>
    <div style="padding:4px 14px">${itemsHtml || `<div class="empty">${tr("No tasks")}</div>`}</div>
  </div>`;
}

$("plan-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sid = currentSid();
  if (sid == null) return;
  const label = $("plan-add-label").value.trim();
  if (!label) return;
  const assignee = $("plan-add-assignee").value;
  const r = await run(e.submitter, "Add task", () => api("plan/add", { session_id: sid, label, slot_id: assignee ? parseInt(assignee, 10) : null }).then(() => ({ message: "Task added" })));
  if (r) $("plan-add-label").value = "";
});

$("plan-list").addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-plan]");
  if (!sel) return;
  const sid = currentSid();
  if (sid == null) return;
  const body = { session_id: sid, item_id: parseInt(sel.closest("[data-item]").dataset.item, 10) };
  if (sel.dataset.plan === "status") body.status = sel.value;
  else body.slot_id = sel.value ? parseInt(sel.value, 10) : null;
  sel.blur();
  run(null, "Update task", () => api("plan/edit", body).then(() => ({ message: "Task updated" })));
});

$("plan-list").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-plan]");
  if (!t || t.tagName === "SELECT") return;
  const sid = currentSid();
  if (sid == null) return;
  const itemId = parseInt(t.closest("[data-item]").dataset.item, 10);
  const item = state.plan?.items.find((i) => i.id === itemId);
  if (!item) return;
  if (t.dataset.plan === "edit") {
    const v = await promptDialog({ title: tr("Edit task"), sid, label: "Task", value: item.label, multiline: true });
    if (v) run(null, "Edit task", () => api("plan/edit", { session_id: sid, item_id: itemId, label: v }).then(() => ({ message: "Task updated" })));
  } else if (t.dataset.plan === "delete") {
    const ok = await confirmDialog({ title: tr("Delete task?"), sid, message: `<p>${esc(item.label)}</p>`, confirmLabel: "Delete", danger: true });
    if (ok) run(null, "Delete task", () => api("plan/delete", { session_id: sid, item_id: itemId }).then(() => ({ message: "Task deleted" })));
  }
});

// --- Knowledge ---

let editingKnowledgeKey = null;

function renderKnowledge() {
  const el = $("knowledge-list");
  if (busyRegion(el)) return;
  const entries = state.knowledge ?? [];
  if (!entries.length) {
    el.innerHTML = `<div class="empty">${state.session ? tr("No knowledge entries. Agents store decisions and discoveries here.") : tr("No session selected")}</div>`;
    return;
  }
  el.innerHTML = `<div class="card"><div class="card-header">${tr("Shared Knowledge")} <span>${entries.length}</span></div>${entries.map((e) => {
    const by = e.created_by_name ? tr("by {name}", { name: esc(e.created_by_name) }) : "";
    const ago = timeSince(e.updated_at);
    return `<div class="knowledge-item" data-key="${esc(e.key)}">
      <div class="knowledge-main">
        <div><span class="knowledge-key">${esc(e.key)}</span><span class="knowledge-cat">${esc(tr(e.category))}</span></div>
        <div class="knowledge-value rich">${renderMarkdown(e.value, { chat: true })}</div>
        <div class="knowledge-meta">${by}${by && ago ? " · " : ""}${ago}</div>
      </div>
      <div class="flex gap-2" style="align-items:flex-start">
        <button class="btn small" data-kn="edit">${tr("Edit")}</button>
        <button class="btn small danger" data-kn="delete">${tr("Delete")}</button>
      </div>
    </div>`;
  }).join("")}</div>`;
  hydrateFileRefs(el);
}

function resetKnowledgeForm() {
  editingKnowledgeKey = null;
  $("knowledge-form").reset();
  $("kn-key").readOnly = false;
  $("knowledge-form-title").textContent = tr("Add knowledge");
}

$("kn-cancel").addEventListener("click", resetKnowledgeForm);

$("knowledge-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sid = currentSid();
  if (sid == null) return;
  const body = { session_id: sid, key: $("kn-key").value.trim(), value: $("kn-value").value, category: $("kn-category").value };
  const r = await run(e.submitter, "Save knowledge", () => api("knowledge/put", body).then(() => ({ message: tr("Saved \"{key}\"", { key: body.key }) })));
  if (r) resetKnowledgeForm();
});

$("knowledge-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-kn]");
  if (!btn) return;
  const sid = currentSid();
  if (sid == null) return;
  const key = btn.closest("[data-key]").dataset.key;
  const entry = state.knowledge.find((k) => k.key === key);
  if (!entry) return;
  if (btn.dataset.kn === "edit") {
    editingKnowledgeKey = key;
    $("kn-key").value = entry.key;
    $("kn-key").readOnly = true;
    $("kn-value").value = entry.value;
    $("kn-category").value = entry.category;
    $("knowledge-form-title").textContent = tr("Edit \"{key}\"", { key });
    $("kn-value").focus();
  } else {
    const ok = await confirmDialog({ title: tr("Delete \"{key}\"?", { key }), sid, message: `<p>${esc(truncate(entry.value, 300))}</p>`, confirmLabel: "Delete", danger: true });
    if (ok) {
      await run(btn, "Delete knowledge", () => api("knowledge/delete", { session_id: sid, key }).then(() => ({ message: tr("Deleted \"{key}\"", { key }) })));
      if (editingKnowledgeKey === key) resetKnowledgeForm();
    }
  }
});

// --- Locks ---

function renderFiles() {
  const el = $("files-list");
  if (busyRegion(el)) return;
  const lockRows = state.fileLocks.map((l) => {
    const holder = slotById(l.held_by_slot);
    const left = l.expires_at - Date.now();
    return `<tr>
      <td><span class="file-ref mono" data-ref="${esc(l.file_path)}">${esc(l.file_path)}</span></td>
      <td>${esc(holder ? slotName(holder) : tr("Slot {id}", { id: l.held_by_slot }))}</td>
      <td class="dim">${esc(l.purpose ?? "")}</td>
      <td class="dim">${timeSince(l.acquired_at)}</td>
      <td style="color:${left < 60000 ? "var(--yellow)" : "var(--text-dim)"}">${left > 0 ? tr("in {time}", { time: fmtDuration(left) }) : tr("expired")}</td>
      <td><button class="btn small danger" data-lock-release="${l.id}">${tr("Force unlock")}</button></td>
    </tr>`;
  }).join("");
  const ownRows = state.fileOwnership.map((o) => {
    const owner = slotById(o.slot_id);
    return `<tr><td class="mono">${esc(o.path_pattern)}</td><td>${esc(owner ? slotName(owner) : tr("Slot {id}", { id: o.slot_id }))}</td><td class="dim">${esc(o.assigned_by ?? "")}</td><td class="dim">${timeSince(o.assigned_at)}</td></tr>`;
  }).join("");
  const th = (...cols) => cols.map((c) => `<th>${c ? tr(c) : ""}</th>`).join("");
  el.innerHTML = `<div class="card"><div class="card-header">${tr("Active Locks")} <span>${state.fileLocks.length}</span></div>
      ${state.fileLocks.length ? `<div class="table-wrap"><table class="table"><thead><tr>${th("File", "Held By", "Purpose", "Acquired", "Expires", "")}</tr></thead><tbody>${lockRows}</tbody></table></div>` : `<div class="empty" style="padding:16px">${tr("No active locks")}</div>`}</div>
    <div class="card"><div class="card-header">${tr("Ownership Zones")} <span>${state.fileOwnership.length}</span></div>
      ${state.fileOwnership.length ? `<div class="table-wrap"><table class="table"><thead><tr>${th("Pattern", "Owner", "Assigned By", "When")}</tr></thead><tbody>${ownRows}</tbody></table></div>` : `<div class="empty" style="padding:16px">${tr("No ownership zones")}</div>`}</div>`;
  hydrateFileRefs(el);
}

$("files-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-lock-release]");
  if (!btn) return;
  const sid = currentSid();
  if (sid == null) return;
  const lock = state.fileLocks.find((l) => l.id === parseInt(btn.dataset.lockRelease, 10));
  if (!lock) return;
  const holder = slotById(lock.held_by_slot);
  const ok = await confirmDialog({
    title: tr("Force unlock?"), sid,
    message: `<p>${tr("<span class=\"mono\">{file}</span> is held by <b>{holder}</b>. Unlocking lets other agents edit it while the holder may still be writing.", { file: esc(lock.file_path), holder: esc(holder ? slotName(holder) : tr("Slot {id}", { id: lock.held_by_slot })) })}</p>`,
    confirmLabel: "Force unlock", danger: true,
  });
  if (ok) run(btn, "Unlock", () => api("files/release", { session_id: sid, lock_id: lock.id }));
});

$("lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sid = currentSid();
  if (sid == null) return;
  const slot = $("lock-agent").value;
  if (!slot) return toast(tr("Pick an agent"), "warn");
  const r = await run(e.submitter, "Acquire lock", () => api("files/acquire", {
    session_id: sid, slot_id: parseInt(slot, 10), file_path: $("lock-path").value.trim(),
    minutes: Number($("lock-minutes").value), purpose: $("lock-purpose").value.trim(),
  }));
  if (r) { $("lock-path").value = ""; $("lock-purpose").value = ""; }
});

$("ownership-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sid = currentSid();
  if (sid == null) return;
  const slot = $("own-agent").value;
  if (!slot) return toast(tr("Pick an agent"), "warn");
  const patterns = $("own-patterns").value.split(",").map((p) => p.trim()).filter(Boolean);
  const r = await run(e.submitter, "Assign ownership", () => api("files/ownership", { session_id: sid, slot_id: parseInt(slot, 10), patterns }));
  if (r) $("own-patterns").value = "";
});

// --- Stats ---

function renderStats() {
  const el = $("panel-stats");
  if (busyRegion(el)) return;
  const curSid = currentSid();
  if (curSid && !$("composer-text").value) {
    try {
      const saved = localStorage.getItem(`multiagents:draft:composer:${curSid}`);
      if (saved) { $("composer-text").value = saved; autosize(); }
    } catch {}
  }
  if (!state.session) { el.innerHTML = `<div class="empty">${tr("No session selected")}</div>`; return; }
  const limits = state.limits ?? {};
  const totalIn = state.slots.reduce((a, s) => a + (s.input_tokens ?? 0), 0);
  const totalOut = state.slots.reduce((a, s) => a + (s.output_tokens ?? 0), 0);
  const totalCache = state.slots.reduce((a, s) => a + (s.cache_read_tokens ?? 0), 0);
  const totalCost = state.slots.reduce((a, s) => a + (s.cost_usd ?? 0), 0);
  const cards = [
    { value: fmtTokens(totalIn + totalOut), label: "Tokens (input + output)", color: "var(--accent)", limit: limits.session_tokens, used: totalIn + totalOut, fmt: fmtTokens },
    { value: fmtUsd(totalCost), label: "Cost (reported by Claude)", color: "var(--green)", limit: limits.session_cost_usd, used: totalCost, fmt: fmtUsd },
    { value: fmtTokens(totalCache), label: "Cache reads", color: "var(--purple)" },
    { value: state.slots.filter((s) => s.status === "connected").length, label: "Online agents", color: "var(--green)" },
    { value: state.messages.length, label: "Messages", color: "var(--cyan)" },
  ];
  const cardsHtml = cards.map((c) => `<div class="stat-card"><div class="stat-value" style="color:${c.color}">${c.value}</div><div class="stat-label">${esc(tr(c.label))}</div>
    ${c.limit ? `<div style="margin-top:6px">${limitBar(c.used, c.limit)}<div class="field-hint">${tr("limit {value}", { value: c.fmt(c.limit) })}</div></div>` : ""}</div>`).join("");

  const rows = state.slots.map((slot) => {
    const set = slotSettingsOf(slot);
    const used = (slot.input_tokens ?? 0) + (slot.output_tokens ?? 0);
    const limit = set.token_limit || limits.agent_tokens;
    return `<tr>
      <td><div class="flex items-center gap-2">${slotAvatar(slot)}<div><b>${esc(slotName(slot))}</b><div class="muted" style="font-size:11.5px">${esc(agentTypeLabel(slot))} · ${esc(set.model || tr("default model"))}${set.effort ? ` · ${esc(set.effort)}` : ""}</div></div></div></td>
      <td class="num">${fmtTokens(slot.input_tokens ?? 0)}</td>
      <td class="num">${fmtTokens(slot.output_tokens ?? 0)}</td>
      <td class="num muted">${fmtTokens(slot.cache_read_tokens ?? 0)}</td>
      <td class="num">${slot.agent_type === "claude" ? fmtUsd(slot.cost_usd ?? 0) : '<span class="muted">—</span>'}</td>
      <td style="min-width:140px">${limit ? `${limitBar(used, limit)}<div class="field-hint">${fmtTokens(used)} / ${fmtTokens(limit)}${set.token_limit ? "" : tr(" (session default)")}</div>` : `<span class="muted">${tr("no limit")}</span>`}
        ${set.limit_hit ? `<div><span class="badge badge-limit">${tr("paused: {reason}", { reason: esc(tr(set.limit_hit)) })}</span></div>` : ""}</td>
      <td><button class="btn small" data-agent="settings" data-slot="${slot.id}">${tr("Settings")}</button></td>
    </tr>`;
  }).join("");

  const enforced = state.guardrails.filter((g) => g.action !== "monitor" && g.adjustable);
  const guardrails = enforced.map((g) => `<div class="guardrail-row" data-guardrail="${esc(g.id)}">
      <div class="guardrail-info"><div class="guardrail-label">${esc(tr(g.label))} ${g.is_overridden ? `<span class="badge badge-review">${tr("overridden")}</span>` : ""}</div>
        <div class="guardrail-desc">${esc(tr(g.description ?? ""))} · ${tr("usage")} ${g.usage?.current ?? 0}/${g.usage?.limit ?? g.current_value} ${esc(tr(g.unit))}</div></div>
      <div class="stepper">
        <button class="btn small" data-step="-1">&minus;</button>
        <input type="number" min="0" value="${g.current_value}" data-input>
        <button class="btn small" data-step="1">+</button>
        <button class="btn small primary" data-set>${tr("Set")}</button>
      </div>
    </div>`).join("");

  const lim = (k) => (limits[k] ? String(limits[k]) : "");
  el.innerHTML = `${planCardHtml()}<div class="stats-grid">${cardsHtml}</div>
    <div class="card"><div class="card-header">${tr("Usage per agent")} <span style="text-transform:none;letter-spacing:0;font-weight:400">${tr("tokens as the CLIs report them; cost only where the CLI reports it")}</span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>${tr("Agent")}</th><th class="num">${tr("Input")}</th><th class="num">${tr("Output")}</th><th class="num">${tr("Cache reads")}</th><th class="num">${tr("Cost")}</th><th>${tr("Limit")}</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="7" class="muted">${tr("No agents yet")}</td></tr>`}</tbody></table></div></div>
    <div class="card"><div class="card-header">${tr("Limit locks")}</div>
      <div class="card-body">
        <form id="limits-form" class="form-grid">
          <label>${tr("Per agent · tokens")}</label><input type="number" min="0" step="1000" name="agent_tokens" value="${lim("agent_tokens")}" placeholder="${tr("no limit")}">
          <label>${tr("Per agent · cost (USD)")}</label><input type="number" min="0" step="0.5" name="agent_cost_usd" value="${lim("agent_cost_usd")}" placeholder="${tr("no limit (Claude only)")}">
          <label>${tr("Whole session · tokens")}</label><input type="number" min="0" step="1000" name="session_tokens" value="${lim("session_tokens")}" placeholder="${tr("no limit")}">
          <label>${tr("Whole session · cost (USD)")}</label><input type="number" min="0" step="0.5" name="session_cost_usd" value="${lim("session_cost_usd")}" placeholder="${tr("no limit")}">
          <div style="grid-column:1/-1" class="flex gap-2 items-center"><span class="field-hint" style="flex:1">${tr("An agent that reaches a limit is paused and its running turn stops. Raise the limit, then resume it. Tokens = input + output. An agent's own limit (Settings) overrides the per-agent limit.")}</span>
            <button type="submit" class="btn primary">${tr("Save limits")}</button></div>
        </form>
      </div></div>
    ${guardrails ? `<div class="card"><div class="card-header">${tr("Guardrails")}</div><div class="card-body">${guardrails}</div></div>` : ""}`;
}

// --- Subscription plan limits (5-hour / weekly / daily windows of each CLI) ---

const planUsage = { data: null, loading: false, error: null };
const PLAN_NAMES = { claude: "Claude", codex: "Codex (ChatGPT)", gemini: "Gemini" };

async function loadPlanUsage(refresh = false) {
  if (planUsage.loading) return;
  planUsage.loading = true;
  if (activeTab === "stats" && state) renderStats();
  try {
    planUsage.data = await api(`plan-usage${refresh ? "?refresh=1" : ""}`);
    planUsage.error = null;
  } catch (e) {
    planUsage.error = e.message;
  } finally {
    planUsage.loading = false;
  }
  renderPlanMeter();
  if (activeTab === "stats" && state) renderStats();
}

function pctBar(p) {
  const v = Math.max(0, Math.min(100, p ?? 0));
  return `<div class="usage-bar${v >= 95 ? " over" : v >= 80 ? " warn" : ""}" title="${Math.round(v)}%"><div style="width:${v}%"></div></div>`;
}

/** "resets in 2h 13m · Fri 14:00" */
function resetText(ms) {
  if (!ms) return "";
  const left = ms - Date.now();
  if (left <= 0) return tr("resets now");
  const when = new Date(ms).toLocaleString(locale(), left > 20 * 3600_000 ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  return tr("resets in {time} · {when}", { time: fmtDuration(left), when });
}

function planCardHtml() {
  const data = planUsage.data;
  const head = `<div class="card-header" style="justify-content:flex-start">${tr("Plan limits")} <span style="text-transform:none;letter-spacing:0;font-weight:400">${tr("subscription quota as each CLI reports it")}</span>
    <button class="btn small" data-plan-refresh style="margin-left:auto" ${planUsage.loading ? "disabled" : ""}>${planUsage.loading ? tr("Loading…") : tr("Refresh")}</button></div>`;
  if (!data) {
    return `<div class="card">${head}<div class="card-body muted">${planUsage.error ? esc(tr(planUsage.error)) : tr("Loading…")}</div></div>`;
  }
  const blocks = data.map((p) => {
    const icon = avatarHtml(null, { type: p.provider, name: PLAN_NAMES[p.provider], color: "#6e7781" }, "", "", "plan-icon");
    const windows = p.windows.map((w) => `<div class="plan-window">
        <div class="plan-window-head"><span>${esc(tr(w.label))}</span><b>${w.usedPercent == null ? "—" : `${Math.round(w.usedPercent)}%`}</b></div>
        ${pctBar(w.usedPercent)}
        <div class="field-hint">${[w.detail ? esc(tr(w.detail)) : "", resetText(w.resetsAt)].filter(Boolean).join(" · ")}</div>
      </div>`).join("");
    const note = p.note || p.error ? `<div class="field-hint">${esc(tr(p.note ?? p.error))}</div>` : "";
    return `<div class="plan-block">
      <div class="plan-title">${icon}<b>${esc(PLAN_NAMES[p.provider])}</b>${p.plan ? `<span class="badge badge-mode">${esc(p.plan)}</span>` : ""}</div>
      ${windows ? `<div class="plan-windows">${windows}</div>` : ""}${note}
    </div>`;
  }).join("");
  return `<div class="card">${head}<div class="card-body plan-grid">${blocks}</div></div>`;
}

/** Top bar: the fullest window of each provider that has any. */
function renderPlanMeter() {
  const el = $("plan-meter");
  const shown = (planUsage.data ?? []).filter((p) => p.ok && p.windows.length);
  if (!shown.length) { el.innerHTML = ""; el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = shown.map((p) => {
    const top = p.windows.filter((w) => w.usedPercent != null).sort((a, b) => b.usedPercent - a.usedPercent)[0] ?? p.windows[0];
    const v = Math.round(top.usedPercent ?? 0);
    const tip = p.windows.map((w) => `${tr(w.label)}: ${w.usedPercent == null ? "—" : `${Math.round(w.usedPercent)}%`}`).join("\n");
    return `<span class="plan-chip${v >= 95 ? " over" : v >= 80 ? " warn" : ""}" title="${esc(`${PLAN_NAMES[p.provider]}\n${tip}`)}">${avatarHtml(null, { type: p.provider, name: p.provider, color: "#6e7781" }, "", "", "mini")}${v}%</span>`;
  }).join("");
}

$("plan-meter").addEventListener("click", () => switchTab("stats"));
$("panel-stats").addEventListener("click", (e) => { if (e.target.closest("[data-plan-refresh]")) loadPlanUsage(true); });

function limitBar(used, limit) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return `<div class="usage-bar${pct >= 100 ? " over" : pct >= 80 ? " warn" : ""}" title="${pct}%"><div style="width:${pct}%"></div></div>`;
}

$("panel-stats").addEventListener("submit", (e) => {
  if (e.target.id !== "limits-form") return;
  e.preventDefault();
  const sid = currentSid();
  if (sid == null) return;
  const f = e.target;
  const limits = Object.fromEntries(["agent_tokens", "agent_cost_usd", "session_tokens", "session_cost_usd"].map((k) => [k, f[k].value === "" ? null : Number(f[k].value)]));
  document.activeElement?.blur();
  run(e.submitter, "Limits", () => api("session/limits", { session_id: sid, limits }));
});

$("panel-stats").addEventListener("click", (e) => {
  const agentBtn = e.target.closest("[data-agent]");
  if (agentBtn) { const slot = slotById(parseInt(agentBtn.dataset.slot, 10)); if (slot) agentAction(agentBtn.dataset.agent, slot, agentBtn); return; }
  const row = e.target.closest("[data-guardrail]");
  if (!row) return;
  const input = row.querySelector("[data-input]");
  const step = e.target.closest("[data-step]");
  if (step) { input.value = Math.max(0, Number(input.value) + Number(step.dataset.step)); input.focus(); return; }
  if (e.target.closest("[data-set]")) {
    const sid = currentSid();
    if (sid == null) return;
    const value = Number(input.value);
    const id = row.dataset.guardrail;
    input.blur();
    run(e.target, "Guardrail", () => api("guardrail", { session_id: sid, guardrail_id: id, value, reason: "Adjusted via web dashboard" })
      .then((g) => ({ message: tr("{name} set to {value} {unit}", { name: tr(g?.label ?? id), value: g?.current_value ?? value, unit: tr(g?.unit ?? "") }) })));
  }
});

// --- Agent settings: model, effort, approval mode, token limit ---

const MODEL_SUGGESTIONS = {
  claude: ["opus", "sonnet", "haiku", "fable", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  codex: ["gpt-5-codex", "gpt-5", "gpt-5-mini", "o3"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
};
const EFFORT_OPTIONS = { claude: ["low", "medium", "high", "xhigh", "max"], codex: ["minimal", "low", "medium", "high"], gemini: [], api: ["minimal", "low", "medium", "high"] };

// --- API providers ("Other": any OpenAI-compatible API) ---

let apiProviders = [];
async function loadApiProviders() {
  try { apiProviders = (await api("providers/list")) ?? []; } catch { apiProviders = []; }
  return apiProviders;
}
function providerById(id) { return apiProviders.find((p) => p.id === id) ?? null; }

/** Base URLs of well-known OpenAI-compatible services; anything else goes under Custom. */
const PROVIDER_PRESETS = [
  ["OpenAI", "https://api.openai.com/v1"],
  ["DeepSeek", "https://api.deepseek.com"],
  ["Qwen (DashScope)", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ["Kimi (Moonshot)", "https://api.moonshot.cn/v1"],
  ["GLM (Zhipu)", "https://open.bigmodel.cn/api/paas/v4"],
  ["OpenRouter", "https://openrouter.ai/api/v1"],
  ["SiliconFlow", "https://api.siliconflow.cn/v1"],
  ["Ollama (local)", "http://localhost:11434/v1"],
];

function providerModelsDatalist(p) {
  return `<datalist id="models-api">${(p?.models ?? []).map((m) => `<option value="${esc(m)}">`).join("")}</datalist>`;
}

/** Provider, model and effort fields of an API agent. */
function apiModelFields(values = {}) {
  const current = values.provider_id || apiProviders[0]?.id || "";
  const p = providerById(current);
  const options = apiProviders.map((x) => `<option value="${esc(x.id)}" ${x.id === current ? "selected" : ""}>${esc(x.name)}</option>`).join("");
  return `<label>${tr("Provider")}</label><div class="flex gap-2 items-center">
      ${apiProviders.length ? `<select name="provider" ${values.lockProvider ? "disabled" : ""}>${options}</select>` : `<span class="muted" style="font-size:12px">${tr("No API provider yet")}</span>`}
      ${values.lockProvider ? "" : `<button type="button" class="btn small" data-manage-providers>${tr("Manage providers…")}</button>`}</div>
    <label>${tr("Model")}</label><div><input type="text" name="model" list="models-api" value="${esc(values.model ?? "")}" placeholder="${esc(p?.default_model || tr("model name"))}">
      ${providerModelsDatalist(p)}
      <div class="field-hint">${tr("Applies to a running agent from its next step.")}</div></div>
    <label>${tr("Effort")}</label><div><select name="effort"><option value="">${tr("default")}</option>${EFFORT_OPTIONS.api.map((x) => `<option value="${x}" ${x === values.effort ? "selected" : ""}>${tr(x)}</option>`).join("")}</select>
      <div class="field-hint">${tr("Sent as reasoning_effort; keep the default if the provider does not support it.")}</div></div>`;
}

// Switching the provider in a form refreshes its model suggestions
document.addEventListener("change", (e) => {
  const sel = e.target.closest?.("select[name=provider], select[data-f=provider]");
  if (!sel) return;
  const p = providerById(sel.value);
  const scope = sel.closest(".team-agent, form");
  const model = scope?.querySelector("[name=model], [data-f=model]");
  if (model) model.placeholder = p?.default_model || tr("model name");
  const dl = scope?.querySelector("#models-api");
  if (dl) dl.outerHTML = providerModelsDatalist(p);
});

/** Where "Manage providers…" returns to once the providers dialog closes */
let providersReturn = null;
document.addEventListener("click", (e) => {
  if (!e.target.closest?.("[data-manage-providers]")) return;
  e.preventDefault();
  providersModal(providersReturn);
});

async function providersModal(onBack) {
  await loadApiProviders();
  const list = apiProviders.length
    ? apiProviders.map((p) => `<div class="provider-row" data-provider="${esc(p.id)}">
        <div class="provider-info"><b>${esc(p.name)}</b> <span class="mono muted">${esc(p.base_url)}</span>
          <div class="field-hint">${tr("Key")}: ${esc(p.api_key_hint || tr("none"))}${p.default_model ? ` · ${tr("default model")}: ${esc(p.default_model)}` : ""}${p.models?.length ? ` · ${tr("{n} models", { n: p.models.length })}` : ""}</div></div>
        <button type="button" class="btn small" data-edit-provider>${tr("Edit")}</button>
        <button type="button" class="btn small danger" data-delete-provider>${tr("Delete")}</button>
      </div>`).join("")
    : `<div class="muted" style="padding:6px 0 10px">${tr("No API provider yet. Pick a preset or fill in any OpenAI-compatible endpoint.")}</div>`;
  let back = true;
  openModal({
    title: "API providers", submitLabel: "Save provider", wide: true,
    body: `<div class="field-hint" style="margin-bottom:8px">${tr("Any service with an OpenAI-compatible chat API can run an agent: DeepSeek, Qwen, Kimi, GLM, OpenRouter, a local Ollama… Keys stay on this computer (~/.multiagents/providers.json) and are never sent to the page.")}</div>
      <div class="provider-list">${list}</div>
      <div class="section-label">${tr("Add or edit")} <span style="text-transform:none;letter-spacing:0;font-weight:400">${PROVIDER_PRESETS.map(([n, u]) => `<button type="button" class="btn small" data-preset-provider="${esc(u)}" data-name="${esc(n)}">${esc(n)}</button>`).join(" ")}</span></div>
      <input type="hidden" name="pid">
      <div class="form-grid">
        <label>Name</label><input type="text" name="pname" placeholder="DeepSeek">
        <label>Base URL</label><div><input type="text" name="base_url" placeholder="https://api.example.com/v1"><div class="field-hint">${tr("The address before /chat/completions.")}</div></div>
        <label>API key</label><div><input type="password" name="api_key" autocomplete="off" placeholder="sk-…"><div class="field-hint">${tr("Or $NAME to read it from an environment variable. Leave empty to keep the saved key; local servers need none.")}</div></div>
        <label>Default model</label><div class="flex gap-2"><input type="text" name="default_model" list="models-api" placeholder="${esc(tr("model name"))}" style="flex:1"><button type="button" class="btn small" data-fetch-models>${tr("Fetch models")}</button></div>
        <label>Price (USD / 1M tokens)</label><div class="flex gap-2"><input type="number" name="input_price" min="0" step="0.01" placeholder="${esc(tr("input"))}"><input type="number" name="output_price" min="0" step="0.01" placeholder="${esc(tr("output"))}"></div>
        <label>Context window</label><input type="number" name="context_tokens" min="1000" step="1000" placeholder="64000">
        <label>Extra request fields</label><div><textarea name="extra_body" rows="2" placeholder='{"enable_search": true}'></textarea><div class="field-hint">${tr("JSON merged into every request, for provider options such as Qwen's built-in web search.")}</div></div>
      </div>
      <datalist id="models-api"></datalist>`,
    setup: (form) => {
      const fill = (p) => {
        form.pid.value = p.id ?? "";
        form.pname.value = p.name ?? "";
        form.base_url.value = p.base_url ?? "";
        form.api_key.value = "";
        form.api_key.placeholder = p.api_key_hint ? tr("saved: {hint}", { hint: p.api_key_hint }) : "sk-…";
        form.default_model.value = p.default_model ?? "";
        form.input_price.value = p.input_price ?? "";
        form.output_price.value = p.output_price ?? "";
        form.context_tokens.value = p.context_tokens ?? "";
        form.extra_body.value = p.extra_body ? JSON.stringify(p.extra_body) : "";
        form.querySelector("#models-api").outerHTML = providerModelsDatalist(p);
        form.pname.focus();
      };
      form.addEventListener("click", async (e) => {
        const preset = e.target.closest("[data-preset-provider]");
        if (preset) return fill({ name: preset.dataset.name, base_url: preset.dataset.presetProvider });
        const row = e.target.closest("[data-provider]");
        if (row && e.target.closest("[data-edit-provider]")) return fill(providerById(row.dataset.provider) ?? {});
        if (row && e.target.closest("[data-delete-provider]")) {
          const p = providerById(row.dataset.provider);
          back = false;
          if (await confirmDialog({ title: tr("Delete {name}?", { name: p?.name ?? "" }), message: `<p>${tr("Agents already running on it keep running until they restart.")}</p>`, confirmLabel: "Delete", danger: true })) {
            await run(null, "Delete", () => api("providers/delete", { id: row.dataset.provider }));
            agentAvailability = null;
          }
          return providersModal(onBack);
        }
        const fetchBtn = e.target.closest("[data-fetch-models]");
        if (fetchBtn) {
          fetchBtn.classList.add("busy");
          try {
            const r = await api("providers/models", { id: form.pid.value, name: form.pname.value, base_url: form.base_url.value, api_key: form.api_key.value });
            form.querySelector("#models-api").outerHTML = providerModelsDatalist({ models: r.models });
            toast(tr(r.message), "ok");
            if (!form.default_model.value && r.models?.length) form.default_model.focus();
          } catch (err) {
            toast(tr(err.message), "error");
          } finally {
            fetchBtn.classList.remove("busy");
          }
        }
      });
    },
    onSubmit: async (form) => {
      if (!form.pname.value.trim() || !form.base_url.value.trim()) throw new Error("Name and base URL are required");
      const r = await api("providers/save", {
        id: form.pid.value, name: form.pname.value.trim(), base_url: form.base_url.value.trim(), api_key: form.api_key.value,
        default_model: form.default_model.value.trim(), extra_body: form.extra_body.value,
        input_price: form.input_price.value, output_price: form.output_price.value, context_tokens: form.context_tokens.value,
      });
      agentAvailability = null;
      toast(tr(r.message), "ok");
      back = false;
      setTimeout(() => providersModal(onBack), 0);
    },
    onCancel: () => { if (back) onBack?.(); },
  });
}
const APPROVAL_MODES = [
  ["bypass", "Fully autonomous", "Never asks. The agent reads, edits and runs commands on its own."],
  ["auto", "Auto review", "The CLI's own reviewer approves safe steps; risky ones come to you. (Claude: auto mode · Codex: on-request)"],
  ["accept_edits", "Auto-approve edits", "File edits go through; shell commands and other tools wait for you. (Claude; Codex asks for everything)"],
  ["ask", "Ask me every step", "Every edit and command waits for your approval."],
];
const MODE_LABEL = Object.fromEntries(APPROVAL_MODES.map(([v, l]) => [v, l]));
const modeLabel = (mode) => tr(MODE_LABEL[mode] ?? mode);

function slotSettingsOf(slot) {
  let snap = {};
  try { snap = JSON.parse(slot.context_snapshot ?? "{}") ?? {}; } catch {}
  return {
    model: typeof snap.model === "string" ? snap.model : "",
    effort: typeof snap.effort === "string" ? snap.effort : "",
    approval_mode: snap.approval_mode || "bypass",
    token_limit: Number(snap.token_limit) > 0 ? Number(snap.token_limit) : 0,
    limit_hit: typeof snap.limit_hit === "string" ? snap.limit_hit : "",
    provider_id: typeof snap.provider_id === "string" ? snap.provider_id : "",
    provider_name: typeof snap.provider_name === "string" ? snap.provider_name : "",
  };
}

/** "claude", "codex", "gemini", or the API provider's name */
function agentTypeLabel(slot) {
  if (slot.agent_type !== "api") return slot.agent_type;
  const set = slotSettingsOf(slot);
  return set.provider_name || providerById(set.provider_id)?.name || "API";
}

function settingsBadges(slot) {
  const set = slotSettingsOf(slot);
  return `${set.model ? `<span class="badge badge-mode" title="${tr("Model")}">${esc(set.model)}</span>` : ""}
    ${set.approval_mode !== "bypass" ? `<span class="badge badge-review" title="${tr("Approval mode")}">${esc(modeLabel(set.approval_mode))}</span>` : ""}
    ${set.limit_hit ? `<span class="badge badge-limit" title="${esc(tr(set.limit_hit))}">${tr("limit reached")}</span>` : ""}`;
}

function usageLine(slot) {
  const used = (slot.input_tokens ?? 0) + (slot.output_tokens ?? 0);
  if (!used && !slot.cost_usd) return "";
  const set = slotSettingsOf(slot);
  const limit = set.token_limit || state.limits?.agent_tokens;
  return `<div class="agent-ids">${tr("{in} in / {out} out", { in: fmtTokens(slot.input_tokens ?? 0), out: fmtTokens(slot.output_tokens ?? 0) })}${slot.cost_usd ? ` · ${fmtUsd(slot.cost_usd)}` : ""}${limit ? ` · ${tr("limit {value}", { value: fmtTokens(limit) })}` : ""}</div>
    ${limit ? `<div style="margin-top:3px">${limitBar(used, limit)}</div>` : ""}`;
}

function modelFields(type, values = {}) {
  if (type === "api") return apiModelFields(values);
  const efforts = EFFORT_OPTIONS[type] ?? [];
  return `<label>${tr("Model")}</label><div><input type="text" name="model" list="models-${type}" value="${esc(values.model ?? "")}" placeholder="${tr("default")}">
      <datalist id="models-${type}">${(MODEL_SUGGESTIONS[type] ?? []).map((m) => `<option value="${m}">`).join("")}</datalist>
      <div class="field-hint">${tr("An alias (opus, sonnet…) or a full model name.")}${type === "gemini" ? tr(" Applies when the agent next starts.") : tr(" Applies to a running agent within seconds.")}</div></div>
    <label>${tr("Effort")}</label>${efforts.length
      ? `<select name="effort"><option value="">${tr("default")}</option>${efforts.map((x) => `<option value="${x}" ${x === values.effort ? "selected" : ""}>${tr(x)}</option>`).join("")}</select>`
      : `<span class="muted" style="font-size:12px">${tr("not available for this agent")}</span>`}`;
}

function approvalFields(type, current = "bypass") {
  return `<div style="grid-column:1/-1">${APPROVAL_MODES.map(([v, l, d]) => {
    const disabled = type === "gemini" && v !== "bypass";
    return `<label class="mode-option${disabled ? " disabled" : ""}"><input type="radio" name="approval_mode" value="${v}" ${v === current ? "checked" : ""} ${disabled ? "disabled" : ""}><span><b>${tr(l)}</b><small>${tr(d)}</small></span></label>`;
  }).join("")}${type === "gemini" ? `<div class="field-hint">${tr("Gemini agents run unattended (yolo); step approvals need Claude or Codex. Their steps still show in Activity.")}</div>` : ""}</div>`;
}

function settingsModal(sid, slot) {
  const set = slotSettingsOf(slot);
  openModal({
    title: tr("Settings · {name}", { name: slotName(slot) }), sub: `${sessionSub(sid)} · ${agentTypeLabel(slot)}`, submitLabel: "Save",
    body: `<div class="form-grid">
        <label>${tr("Avatar")}</label><div class="flex items-center gap-2">${slotAvatar(slot, "", true)}<span class="field-hint">${tr("Click the avatar to change it.")}</span></div>
        ${modelFields(slot.agent_type, { ...set, lockProvider: true })}
        <label>${tr("Token limit")}</label><div><input type="number" name="token_limit" min="0" step="1000" value="${set.token_limit || ""}" placeholder="${state.limits?.agent_tokens ? tr("session default {value}", { value: state.limits.agent_tokens }) : tr("no limit")}">
          <div class="field-hint">${tr("Input + output tokens. When reached the agent is paused and its turn stops. Used so far: {used}.", { used: fmtTokens((slot.input_tokens ?? 0) + (slot.output_tokens ?? 0)) })}</div></div>
      </div>
      <div class="section-label" style="margin-top:14px">${tr("Approvals")}</div>
      <div class="form-grid">${approvalFields(slot.agent_type, set.approval_mode)}</div>`,
    onSubmit: async (form) => {
      const body = {
        session_id: sid, slot_id: slot.id,
        model: form.model.value.trim(),
        approval_mode: form.querySelector("[name=approval_mode]:checked")?.value ?? "bypass",
        token_limit: form.token_limit.value === "" ? null : Number(form.token_limit.value),
      };
      if (form.effort) body.effort = form.effort.value;
      const r = await api("agents/settings", body);
      toast(tr(r?.message ?? "Saved"), "ok");
    },
  });
}

$("act-settings").addEventListener("click", () => {
  const slot = slotById(parseInt($("act-agent").value, 10)) ?? liveSlots()[0];
  if (!slot) return toast(tr("No agent selected"), "warn");
  const sid = currentSid();
  if (sid != null) settingsModal(sid, slot);
});

// --- Approvals ---

function approvalPreview(a) {
  let input = {};
  try { input = JSON.parse(a.input ?? "{}") ?? {}; } catch {}
  if (a.tool === "Bash" || a.tool === "shell") return `<pre class="mono">${esc(input.command ?? "")}</pre>${input.description ? `<div class="field-hint">${esc(input.description)}</div>` : ""}`;
  if (a.tool === "Edit" || a.tool === "MultiEdit") return editDiff(input);
  if (a.tool === "Write") return `<div class="diff-file">${fileRef(input.file_path ?? "")}</div><pre class="diff">${(String(input.content ?? "")).split("\n").slice(0, 60).map((l) => `<span class="add">+${esc(l)}</span>`).join("")}</pre>`;
  if (a.tool === "apply_patch" && Array.isArray(input.changes)) return changesDiff(input.changes);
  return `<pre class="mono">${esc(JSON.stringify(input, null, 2))}</pre>`;
}

function renderApprovals() {
  const pending = state.approvals ?? [];
  $("badge-activity").textContent = pending.length ? `${pending.length}!` : "";
  const banner = $("approval-banner");
  // On the Activity tab the cards themselves are the reminder
  if (!pending.length || activeTab === "activity") { banner.className = "hidden"; banner.innerHTML = ""; }
  else {
    banner.className = "approval-banner";
    banner.innerHTML = `<b>&#9995; ${tr(pending.length === 1 ? "{n} step waiting for your approval" : "{n} steps waiting for your approval", { n: pending.length })}</b><span class="dim">${esc(pending.slice(0, 3).map((a) => `${slotName(slotById(a.slot_id))}: ${a.title}`).join(" · "))}</span><span style="flex:1"></span><button class="btn small primary">${tr("Review")}</button>`;
  }
  const box = $("act-approvals");
  if (busyRegion(box)) return;
  const sig = pending.map((a) => a.id).join(",");
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = pending.map((a) => {
    const slot = slotById(a.slot_id);
    return `<div class="approval-card" data-approval="${a.id}">
      <div class="approval-head">${slot ? slotAvatar(slot) : avatar("?", slotColor(a.slot_id))}
        <div class="approval-title">${tr("<b>{name}</b> wants to run <code>{tool}</code>", { name: esc(slotName(slot)), tool: esc(a.tool) })}<div class="sub">${esc(a.title)} · ${timeSince(a.created_at)}</div></div></div>
      <div class="approval-body">${approvalPreview(a)}</div>
      <div class="approval-actions">
        <input type="text" placeholder="${tr("Note to the agent (optional, sent with a denial)")}" data-note>
        <button class="btn small danger" data-decide="deny">${tr("Deny")}</button>
        <button class="btn small" data-decide="always" title="${tr("Allow this tool (for shell: this program) for the rest of the agent's session")}">${tr("Always allow")}</button>
        <button class="btn small primary" data-decide="allow">${tr("Allow")}</button>
      </div>
    </div>`;
  }).join("");
  hydrateFileRefs(box);
}

$("approval-banner").addEventListener("click", () => switchTab("activity"));
$("act-approvals").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-decide]");
  if (!btn) return;
  const sid = currentSid();
  if (sid == null) return;
  const card = btn.closest("[data-approval]");
  const decision = btn.dataset.decide === "deny" ? "deny" : "allow";
  const r = await run(btn, "Approval", () => api("approvals/decide", {
    session_id: sid, approval_id: parseInt(card.dataset.approval, 10), decision,
    always: btn.dataset.decide === "always", note: card.querySelector("[data-note]").value.trim(),
  }));
  if (r) { card.remove(); delete $("act-approvals").dataset.sig; }
});

// --- Activity timeline ---

const activity = { sid: null, entries: [], lastId: 0, filterSig: "", rendered: 0, polling: false };

function activityReset() {
  Object.assign(activity, { sid: null, entries: [], lastId: 0, filterSig: "", rendered: 0 });
  $("act-feed").innerHTML = "";
}

async function pollActivity() {
  if (activity.polling || !state?.session || document.hidden) return;
  if (activeTab !== "activity") return;
  const sid = state.sessionId;
  if (activity.sid !== sid) { activityReset(); activity.sid = sid; }
  activity.polling = true;
  try {
    const q = new URLSearchParams({ session_id: sid, limit: activity.lastId ? "1000" : "600" });
    if (activity.lastId) q.set("after_id", String(activity.lastId));
    const res = await fetch(`/api/activity?${q}`);
    const data = await res.json();
    if (!data.ok || sid !== state?.sessionId) return;
    if (data.result.length) {
      activity.entries.push(...data.result);
      activity.lastId = data.result[data.result.length - 1].id;
      if (activity.entries.length > 3000) { activity.entries = activity.entries.slice(-2500); activity.filterSig = ""; }
      renderActivity();
    }
  } catch { /* retried next tick */ } finally {
    activity.polling = false;
  }
}
setInterval(pollActivity, 1500);

const STEP_ICON = { thinking: "&#128173;", tool_call: "&#128295;", command: "&#9002;", file_change: "&#9998;", approval: "&#9995;", status: "&#8226;", error: "&#9888;" };
const TOOL_ICON = { Read: "&#128065;", Write: "&#128221;", Edit: "&#9998;", MultiEdit: "&#9998;", Bash: "&#9002;", shell: "&#9002;", Grep: "&#128269;", Glob: "&#128269;", WebFetch: "&#127760;", WebSearch: "&#127760;", Task: "&#129302;", Agent: "&#129302;", TodoWrite: "&#9745;" };

function parseData(e) { try { return JSON.parse(e.data ?? "null") ?? {}; } catch { return {}; } }

function lineDiff(oldText, newText) {
  const a = String(oldText ?? "").split("\n"), b = String(newText ?? "").split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ctx = (l) => `<span class="ctx"> ${esc(l)}</span>`;
  return [
    ...a.slice(Math.max(0, pre - 2), pre).map(ctx),
    ...a.slice(pre, a.length - suf).map((l) => `<span class="del">-${esc(l)}</span>`),
    ...b.slice(pre, b.length - suf).map((l) => `<span class="add">+${esc(l)}</span>`),
    ...a.slice(a.length - suf, a.length - suf + 2).map(ctx),
  ].join("");
}

function editDiff(input) {
  const edits = Array.isArray(input.edits) ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
  return `<div class="diff-file">${fileRef(input.file_path ?? "")}</div>${edits.map((ed) => `<pre class="diff">${lineDiff(ed.old_string, ed.new_string)}</pre>`).join("")}`;
}

function unifiedDiff(diff) {
  return `<pre class="diff">${String(diff ?? "").split("\n").map((l) =>
    l.startsWith("@@") ? `<span class="hunk">${esc(l)}</span>`
    : l.startsWith("+") && !l.startsWith("+++") ? `<span class="add">${esc(l)}</span>`
    : l.startsWith("-") && !l.startsWith("---") ? `<span class="del">${esc(l)}</span>`
    : `<span class="ctx">${esc(l)}</span>`).join("")}</pre>`;
}

function changesDiff(changes) {
  return changes.map((c) => `<div class="diff-file">${esc(tr(c.kind ?? "update"))} ${fileRef(c.path ?? "")}</div>${c.diff ? unifiedDiff(c.diff) : ""}`).join("");
}

function outputBlock(label, text, isErr) {
  if (!text) return "";
  return `<div class="result${isErr ? " err" : ""}"><div class="result-label">${esc(tr(label))}</div><pre class="mono">${esc(text)}</pre></div>`;
}

function callBody(tool, input) {
  if (tool === "Edit" || tool === "MultiEdit") return editDiff(input);
  if (tool === "Write") return `<div class="diff-file">${fileRef(input.file_path ?? "")}</div><pre class="diff">${String(input.content ?? "").split("\n").slice(0, 200).map((l) => `<span class="add">+${esc(l)}</span>`).join("")}</pre>`;
  if (tool === "Bash") return `<pre class="mono">${esc(input.command ?? "")}</pre>${input.description ? `<div class="field-hint">${esc(input.description)}</div>` : ""}`;
  if (tool === "Read") return `<div>${fileRef(input.file_path ?? "")}${input.offset ? ` <span class="muted">${tr("from line {n}", { n: esc(input.offset) })}</span>` : ""}</div>`;
  if (!input || !Object.keys(input).length) return "";
  return `<pre class="mono">${esc(JSON.stringify(input, null, 2))}</pre>`;
}

function stepTitleHtml(title) {
  // File names in a step title become links like in the chat
  return inline(tr(title));
}

/** One entry as HTML; tool results are appended to their call's element instead. */
function stepHtml(e) {
  const d = parseData(e);
  const time = `<span class="step-time">${esc(fmtTime(new Date(e.ts).toISOString()))}</span>`;
  switch (e.kind) {
    case "thinking":
      return `<details class="step thinking"><summary><span class="step-icon">${STEP_ICON.thinking}</span><span class="step-title">${esc(truncate((e.detail ?? e.title).replace(/\s+/g, " "), 160))}</span>${time}</summary>
        ${e.detail ? `<div class="step-body"><div class="think-text">${esc(e.detail)}</div></div>` : ""}</details>`;
    case "text":
      return `<div class="step kind-text"><div class="rich">${renderMarkdown(e.detail ?? "", { chat: true })}</div></div>`;
    case "tool_call": {
      const body = callBody(d.tool, d.input ?? {});
      return `<details class="step" data-tuid="${esc(d.tool_use_id ?? "")}"${d.tool === "Edit" || d.tool === "MultiEdit" ? " open" : ""}><summary><span class="step-icon">${TOOL_ICON[d.tool] ?? STEP_ICON.tool_call}</span><span class="step-title">${stepTitleHtml(e.title)}</span>${time}</summary>
        <div class="step-body">${body}${e.detail ? outputBlock("Result", e.detail, d.status === "failed") : ""}</div></details>`;
    }
    case "tool_result":
      return `<details class="step${d.is_error ? " err" : ""}"><summary><span class="step-icon">${d.is_error ? "&#9888;" : "&#8627;"}</span><span class="step-title">${esc(tr(e.title))}</span>${time}</summary><div class="step-body"><pre class="mono">${esc(e.detail ?? "")}</pre></div></details>`;
    case "command": {
      const failed = d.exit_code !== undefined && d.exit_code !== null && d.exit_code !== 0;
      return `<details class="step${failed ? " err" : ""}"><summary><span class="step-icon">${STEP_ICON.command}</span><span class="step-title">${esc(e.title)}${d.exit_code !== undefined && d.exit_code !== null ? ` <span class="muted">${tr("exit {code}", { code: esc(d.exit_code) })}</span>` : ""}</span>${time}</summary>
        <div class="step-body">${outputBlock("Output", e.detail || tr("(no output)"), failed)}</div></details>`;
    }
    case "file_change":
      return `<details class="step" open><summary><span class="step-icon">${STEP_ICON.file_change}</span><span class="step-title">${stepTitleHtml(e.title)}</span>${time}</summary><div class="step-body">${changesDiff(d.changes ?? [])}</div></details>`;
    case "approval":
      return `<div class="act-note${d.allowed === false ? " err" : d.allowed ? " ok" : ""}"><span>&#9995; ${esc(tr(e.title))}${e.detail ? ` — ${esc(e.detail)}` : ""}</span></div>`;
    case "turn_end":
      return `<div class="act-turn">${esc(tr(e.title))}</div>`;
    case "error":
      return `<div class="act-note err"><span>&#9888; ${esc(tr(e.title))}${e.detail ? ` — ${esc(tr(e.detail))}` : ""}</span></div>`;
    default:
      return `<div class="act-note"><span>${esc(tr(e.title))}</span></div>`;
  }
}

function activityVisible(e, filter, showTeam, showThinking) {
  if (filter && e.slot_id !== filter) return false;
  if (!showThinking && e.kind === "thinking") return false;
  if (!showTeam && (e.kind === "tool_call" || e.kind === "tool_result") && parseData(e).team) return false;
  return true;
}

function renderActivity() {
  const feed = $("act-feed");
  if (!state?.session) { feed.innerHTML = `<div class="chat-empty">${tr("No session selected.")}</div>`; return; }
  if (activity.sid !== state.sessionId) { void pollActivity(); return; }
  const filter = $("act-agent").value ? parseInt($("act-agent").value, 10) : null;
  const showTeam = $("act-team").checked, showThinking = $("act-thinking").checked;
  const sig = `${filter}|${showTeam}|${showThinking}`;
  const visible = activity.entries.filter((e) => activityVisible(e, filter, showTeam, showThinking));
  $("act-count").textContent = tr(visible.length === 1 ? "{n} step" : "{n} steps", { n: visible.length });
  if (!activity.entries.length) {
    feed.innerHTML = `<div class="chat-empty">${tr("No activity yet. Steps appear here as agents think, read, edit and run commands.")}<br><span class="muted" style="font-size:12px">${tr("Claude and Codex agents launched by multiagents report every step; Gemini reports its tool calls.")}</span></div>`;
    activity.filterSig = ""; activity.rendered = 0;
    return;
  }
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  let fresh;
  if (sig !== activity.filterSig) {
    activity.filterSig = sig;
    feed.innerHTML = "";
    activity.rendered = 0;
    activity.lastSlot = null;
    fresh = activity.entries;
  } else {
    fresh = activity.entries.slice(activity.rendered);
  }
  activity.rendered = activity.entries.length;
  const frag = document.createElement("div");
  for (const e of fresh) {
    if (!activityVisible(e, filter, showTeam, showThinking)) continue;
    if (e.kind === "tool_result") {
      const d = parseData(e);
      const call = d.tool_use_id ? feed.querySelector(`[data-tuid="${CSS.escape(d.tool_use_id)}"] .step-body`) ?? frag.querySelector(`[data-tuid="${CSS.escape(d.tool_use_id)}"] .step-body`) : null;
      if (call) {
        call.insertAdjacentHTML("beforeend", outputBlock(d.is_error ? "Error" : "Result", e.detail || tr("(empty)"), d.is_error));
        if (d.is_error) call.closest(".step").classList.add("err");
        continue;
      }
    }
    const slot = slotById(e.slot_id);
    const head = activity.lastSlot !== e.slot_id
      ? `<div class="act-who">${slot ? slotAvatar(slot, "", false, "mini") : ""} <b>${esc(slotName(slot))}</b> ${slot?.role ? `· ${esc(slot.role)}` : ""}</div>`
      : "";
    activity.lastSlot = e.slot_id;
    frag.insertAdjacentHTML("beforeend", head + stepHtml(e));
  }
  while (frag.firstChild) feed.appendChild(frag.firstChild);
  hydrateFileRefs(feed);
  if (atBottom || fresh === activity.entries) { feed.scrollTop = feed.scrollHeight; $("act-jump").classList.add("hidden"); }
  else if (fresh.length) $("act-jump").classList.remove("hidden");
}

for (const id of ["act-agent", "act-team", "act-thinking"]) $(id).addEventListener("change", () => { activity.filterSig = ""; renderActivity(); });
$("act-jump").addEventListener("click", () => { const f = $("act-feed"); f.scrollTop = f.scrollHeight; $("act-jump").classList.add("hidden"); });
$("act-feed").addEventListener("scroll", () => {
  const f = $("act-feed");
  if (f.scrollHeight - f.scrollTop - f.clientHeight < 80) $("act-jump").classList.add("hidden");
});

// --- Toolbar / global actions ---

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || btn.disabled) return;
  globalAction(btn.dataset.action, btn);
});

async function globalAction(action, btn) {
  if (action === "new-team") return newTeamModal();
  if (action === "new-session") return newSessionModal();
  if (action === "broker-restart") {
    const ok = await confirmDialog({
      title: "Restart the broker?", confirmLabel: "Restart broker",
      message: `<p>${tr("Sessions, messages and plans are stored on disk and stay. Running agents keep running; for a few seconds their requests to the broker fail and are retried.")}</p>`,
    });
    if (ok) await run(btn, "Restart broker", () => api("broker/restart", {}));
    return;
  }
  const sid = currentSid();
  if (sid == null) return;
  switch (action) {
    case "session-pause": {
      const ok = await confirmDialog({ title: tr("Pause the whole session?"), sid, message: `<p>${tr("Every connected agent gets a pause signal, its incoming messages are held and its file locks are released. Resume picks up where they stopped.")}</p>`, confirmLabel: "Pause all" });
      if (ok) run(btn, "Pause", () => api("session/control", { session_id: sid, action: "pause" }));
      return;
    }
    case "session-resume": return run(btn, "Resume", () => api("session/control", { session_id: sid, action: "resume" }));
    case "add-agent": return addAgentModal(sid);
    case "release-menu": return openMenu(btn, releaseMenuItems(sid));
    case "session-menu": return openMenu(btn, sessionMenuItems(state.session));
    case "toggle-gate": return run(btn, "Human gate", () => api("session/human-gate", { session_id: sid, enabled: !state.humanGate }));
    case "toggle-qa": {
      if (state.qaMode) return run(btn, "Q&A mode", () => api("session/qa", { session_id: sid, enabled: false }));
      const ok = await confirmDialog({
        title: "Put the team's work on hold?", sid, confirmLabel: "Start Q&A",
        message: `<p>${tr("Every agent stops its current turn and waits. Then ask one agent at a time (pick it under <b>To</b>); it answers you in the chat and may read files, but not edit or run commands. Teammates' messages wait until you end Q&A, and then everyone resumes.")}</p>`,
      });
      if (ok) return run(btn, "Q&A mode", () => api("session/qa", { session_id: sid, enabled: true }));
      return;
    }
    case "gate-release": return releaseAll(sid, true, btn);
    case "gate-sendback": return sendBackModal(sid, null);
  }
}

function releaseMenuItems(sid) {
  const approved = state.slots.filter((s) => s.task_state === "approved");
  const releasable = state.slots.filter((s) => s.task_state !== "released" && s.task_state !== "idle");
  return [
    { label: "Release all approved", hint: String(approved.length), disabled: !approved.length, onClick: () => releaseAll(sid, true) },
    { label: "Release all", hint: String(releasable.length), danger: true, disabled: !releasable.length, onClick: () => releaseAll(sid, false) },
  ];
}

async function releaseAll(sid, approvedOnly, btn) {
  const targets = approvedOnly
    ? state.slots.filter((s) => s.task_state === "approved")
    : state.slots.filter((s) => s.task_state !== "released" && s.task_state !== "idle");
  if (!targets.length) return toast(tr("Nothing to release"), "warn");
  const notApproved = targets.filter((s) => s.task_state !== "approved");
  const ok = await confirmDialog({
    title: tr(approvedOnly ? "Release all approved agents?" : "Release ALL agents?"), sid,
    message: `<p>${tr("These agents are told their work is complete and disconnect once idle:")}</p><ul>${targets.map((s) => `<li>${esc(slotName(s))} — ${esc(taskLabel(s.task_state))}</li>`).join("")}</ul>` +
      (notApproved.length ? `<p style="color:var(--yellow)">&#9888; ${tr("{n} of them are not approved.", { n: notApproved.length })}</p>` : ""),
    confirmLabel: "Release", danger: !approvedOnly,
  });
  if (ok) run(btn, "Release", () => api("agents/release-all", { session_id: sid, approved_only: approvedOnly }));
}

function sessionMenuItems(s) {
  if (!s) return [];
  const sid = s.id;
  const archived = s.status === "archived";
  return [
    { label: "Open", disabled: sid === state.sessionId, onClick: () => selectSession(sid) },
    { label: "Pause", disabled: s.status !== "active", onClick: async () => {
        if (await confirmDialog({ title: tr("Pause \"{name}\"?", { name: s.name }), sid, message: `<p>${tr("Pauses every connected agent of this session.")}</p>`, confirmLabel: "Pause all" }))
          run(null, "Pause", () => api("session/control", { session_id: sid, action: "pause" }));
      } },
    { label: "Resume", disabled: s.status !== "paused", onClick: () => run(null, "Resume", () => api("session/control", { session_id: sid, action: "resume" })) },
    { label: "Relaunch disconnected agents", onClick: async () => {
        if (await confirmDialog({ title: tr("Relaunch agents of \"{name}\"?", { name: s.name }), sid, message: `<p>${tr("Respawns every disconnected, unreleased agent with a handoff of its role, plan items and recent messages. They run under this dashboard. Agents another orchestrator still runs are not touched.")}</p>`, confirmLabel: "Relaunch" }))
          run(null, "Relaunch", () => api("session/relaunch", { session_id: sid }));
      } },
    { sep: true },
    { label: "Export JSON", onClick: () => { location.href = `/api/session/export?session_id=${encodeURIComponent(sid)}`; } },
    { label: "API providers…", onClick: () => { providersReturn = null; providersModal(null); } },
    { label: "Archive", disabled: archived, onClick: async () => {
        if (await confirmDialog({ title: tr("Archive \"{name}\"?", { name: s.name }), sid, message: `<p>${tr("Marks the session archived (like <span class=\"mono\">multiagents session archive</span>). Running agents are not stopped — use <b>End session</b> for that.")}</p>`, confirmLabel: "Archive" }))
          run(null, "Archive", () => api("session/archive", { session_id: sid }));
      } },
    { label: "End session", danger: true, disabled: archived, onClick: async () => {
        if (await confirmDialog({ title: tr("End \"{name}\"?", { name: s.name }), sid, message: `<p>${tr("Stops the agents this dashboard runs, marks every agent disconnected and archives the session.")}</p>`, confirmLabel: "End session", danger: true }))
          run(null, "End session", () => api("session/end", { session_id: sid }));
      } },
    { label: "Delete…", danger: true, onClick: async () => {
        if (await confirmDialog({ title: tr("Delete \"{name}\" permanently?", { name: s.name }), sid, message: `<p>${tr("Stops its agents and deletes all slots, messages, plans and locks. <b>This cannot be undone.</b> Export first if you want a copy. Project files are not touched.")}</p>`, confirmLabel: "Delete forever", danger: true, typeToConfirm: sid }))
          run(null, "Delete", () => api("session/delete", { session_id: sid, confirm: sid }));
      } },
  ];
}

// --- Dropdown menu ---

function openMenu(anchor, items) {
  const menu = $("menu");
  menu.innerHTML = items.map((it, i) => it.sep
    ? '<div class="menu-sep"></div>'
    : `<div class="menu-item${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}${it.checked ? " checked" : ""}" data-idx="${i}">${esc(tr(it.label))}${it.hint ? `<span class="menu-hint">${esc(it.hint)}</span>` : ""}</div>`).join("");
  menu.onclick = (e) => {
    const el = e.target.closest(".menu-item");
    if (!el) return;
    closeMenu();
    items[parseInt(el.dataset.idx, 10)]?.onClick?.();
  };
  menu.classList.add("open");
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
}

function closeMenu() { $("menu").classList.remove("open"); }

// Clicks on the menu or on a button that opens one leave it to that button
document.addEventListener("click", (e) => {
  if (!e.target.closest("#menu, [data-action$='-menu'], [data-session-menu], [data-roster-menu], #theme-btn, #lang-btn, #composer-presets")) closeMenu();
});

// --- Modals ---

let modalClose = null;

/** Open a modal. `onSubmit(form)` may throw to keep it open with the error shown; returning closes it. */
function openModal({ title, sub, body, submitLabel = "OK", cancelLabel = "Cancel", danger = false, wide = false, onSubmit, onCancel, setup }) {
  closeModal();
  const overlay = $("modal-overlay");
  overlay.innerHTML = `<form class="modal${wide ? " wide" : ""}" novalidate>
    <div class="modal-header"><div><div class="modal-title">${esc(tr(title))}</div>${sub ? `<div class="modal-sub">${esc(sub)}</div>` : ""}</div>
      <button type="button" class="icon-btn" data-close>&#10005;</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-footer"><span class="modal-error"></span>
      <button type="button" class="btn" data-close>${esc(tr(cancelLabel))}</button>
      <button type="submit" class="btn ${danger ? "solid-danger" : "primary"}">${esc(tr(submitLabel))}</button></div>
  </form>`;
  // Static labels, hints and placeholders of the body are translated in place
  translateTree(overlay.querySelector(".modal-body"));
  overlay.classList.add("open");
  const form = overlay.querySelector("form");
  const errEl = form.querySelector(".modal-error");
  const submitBtn = form.querySelector('[type="submit"]');
  let done = false;
  const finish = (cancelled) => {
    if (done) return;
    done = true;
    overlay.classList.remove("open");
    overlay.innerHTML = "";
    modalClose = null;
    if (cancelled) onCancel?.();
  };
  modalClose = () => finish(true);
  form.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => finish(true)));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.textContent = "";
    submitBtn.disabled = true;
    submitBtn.classList.add("busy");
    try {
      await onSubmit(form);
      finish(false);
    } catch (err) {
      errEl.textContent = tr(err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.classList.remove("busy");
    }
  });
  setup?.(form);
  setTimeout(() => form.querySelector("[autofocus], textarea, input:not([type=checkbox]), select")?.focus(), 30);
  return form;
}

function closeModal() { modalClose?.(); }

function sessionSub(sid) {
  const s = state?.sessions?.find((x) => x.id === sid);
  return tr("Session: {name}", { name: s?.name && s.name !== sid ? `${s.name} (${sid})` : sid });
}

function confirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false, sid, typeToConfirm }) {
  return new Promise((resolve) => {
    openModal({
      title, sub: sid != null ? sessionSub(sid) : undefined, submitLabel: confirmLabel, cancelLabel, danger,
      body: `${message ?? ""}${typeToConfirm ? `<p class="dim" style="margin-top:10px">${tr("Type <b class=\"mono\">{text}</b> to confirm:", { text: esc(typeToConfirm) })}</p><input type="text" name="confirm" style="width:100%" autocomplete="off">` : ""}`,
      onSubmit: (form) => {
        if (typeToConfirm && form.confirm.value.trim() !== typeToConfirm) throw new Error(tr("The text does not match"));
        resolve(true);
      },
      onCancel: () => resolve(false),
    });
  });
}

function promptDialog({ title, label, value = "", multiline = false, sid }) {
  return new Promise((resolve) => {
    openModal({
      title, sub: sid != null ? sessionSub(sid) : undefined, submitLabel: "Save",
      body: `<div class="form-grid"><label>${esc(tr(label))}</label>${multiline ? `<textarea name="v" rows="3">${esc(value)}</textarea>` : `<input type="text" name="v" value="${esc(value)}">`}</div>`,
      onSubmit: (form) => {
        const v = form.v.value.trim();
        if (!v) throw new Error(tr("{label} is required", { label: tr(label) }));
        resolve(v);
      },
      onCancel: () => resolve(null),
    });
  });
}

function agentOptions(selectedId) {
  return liveSlots().map((s) => `<option value="${s.id}" ${s.id === selectedId ? "selected" : ""}>${esc(slotName(s))}${s.role ? ` · ${esc(s.role)}` : ""} — ${esc(taskLabel(s.task_state))}</option>`).join("");
}

function roleDatalist() {
  return `<datalist id="role-suggestions">${["Software Engineer", "Code Reviewer", "QA Engineer", "UI/UX Designer", "Researcher", "Writer", "Editor", "Tech Lead", "Worker", "Reviewer"]
    .map((r) => `<option value="${r}">`).join("")}</datalist>`;
}

function roleModal(sid, slot) {
  openModal({
    title: tr("Change role of {name}", { name: slotName(slot) }), sub: sessionSub(sid), submitLabel: "Assign role",
    body: `<div class="form-grid">
      <label>Role</label><input type="text" name="role" list="role-suggestions" value="${esc(slot.role ?? "")}" autofocus>
      <label>Description</label><textarea name="desc" rows="4">${esc(slot.role_description ?? "")}</textarea>
    </div><div class="field-hint" style="margin-top:8px">The agent receives a role_assignment message. Roles containing review, QA, test or lead count as reviewers in the approval flow.</div>
    ${roleDatalist()}`,
    onSubmit: async (form) => {
      const r = await api("agents/role", { session_id: sid, slot_id: slot.id, role: form.role.value.trim(), role_description: form.desc.value.trim() });
      toast(tr(r?.message ?? "Role assigned"), "ok");
    },
  });
}

function sendBackModal(sid, slotId) {
  const isReviewer = (s) => /qa|review|test|lead/i.test(s.role ?? "");
  const candidates = liveSlots();
  const preferred = slotId ?? (candidates.find((s) => !isReviewer(s))?.id ?? candidates[0]?.id ?? null);
  openModal({
    title: "Send back for revision", sub: sessionSub(sid), submitLabel: "Send back", danger: true,
    body: `<div class="form-grid">
      <label>Worker</label><select name="slot">${agentOptions(preferred)}</select>
      <label>Feedback</label><textarea name="feedback" rows="6" autofocus placeholder="What must change before you approve?"></textarea>
    </div><div class="field-hint" style="margin-top:8px">${tr("Delivered as actionable feedback from you; the agent moves to <b>addressing feedback</b> and the review loop runs again.")}</div>`,
    onSubmit: async (form) => {
      const feedback = form.feedback.value.trim();
      if (!feedback) throw new Error("Write the feedback first");
      const r = await api("agents/feedback", { session_id: sid, slot_id: parseInt(form.slot.value, 10), feedback });
      toast(tr(r?.message ?? "Sent back"), "ok");
    },
  });
}

let agentAvailability = null;
async function loadAvailability() {
  if (agentAvailability) return agentAvailability;
  try { agentAvailability = await api("agents/available"); } catch { agentAvailability = {}; }
  return agentAvailability;
}

const AGENT_TYPE_CHOICES = ["claude", "codex", "gemini", "api"];

function typeOptions(selected, avail) {
  const labels = {
    claude: "claude",
    codex: "codex",
    gemini: "antigravity (gemini)",
    api: tr("Other (OpenAI-compatible API)"),
  };
  return AGENT_TYPE_CHOICES.map((t) => {
    const label = labels[t] || t;
    const missing = avail && avail[t] === false ? tr(t === "api" ? " (add a provider)" : " (not installed)") : "";
    return `<option value="${t}" ${t === selected ? "selected" : ""}>${label}${missing}</option>`;
  }).join("");
}

async function addAgentModal(sid, preset = {}) {
  const [avail] = await Promise.all([loadAvailability(), loadApiProviders()]);
  const def = preset.type ?? ["claude", "codex", "gemini", "api"].find((t) => avail[t] !== false) ?? "claude";
  providersReturn = () => addAgentModal(sid, { type: "api" });
  openModal({
    title: "Add agent", sub: sessionSub(sid), submitLabel: "Launch Agent",
    body: `<div class="form-grid">
      <label>Agent type</label><select name="type">${typeOptions(def, avail)}</select>
      <label>Name</label><input type="text" name="name" placeholder="e.g. Codex Reviewer" autofocus>
      <label>Role</label><input type="text" name="role" list="role-suggestions" placeholder="e.g. Code Reviewer">
      <label>Role description</label><textarea name="desc" rows="2" placeholder="Expertise, platform, constraints (optional)"></textarea>
      <label>Task / instruction</label><textarea name="task" rows="5" placeholder="What should this agent do first?"></textarea>
      <label>File ownership</label><input type="text" name="own" placeholder="optional: src/api/**, tests/**">
    </div>
    <div class="section-label" style="margin-top:14px">Model &amp; approvals</div>
    <div class="form-grid" data-settings>${modelFields(def)}${approvalFields(def)}</div>
    ${roleDatalist()}
    <div class="field-hint" style="margin-top:8px">The agent runs under this dashboard (keep it open). Launching takes 15–60s before it connects.</div>`,
    setup: (form) => form.type.addEventListener("change", () => {
      form.querySelector("[data-settings]").innerHTML = modelFields(form.type.value) + approvalFields(form.type.value);
    }),
    onSubmit: async (form) => {
      const body = {
        session_id: sid, agent_type: form.type.value, name: form.name.value.trim(), role: form.role.value.trim(),
        role_description: form.desc.value.trim(), initial_task: form.task.value.trim(),
        file_ownership: form.own.value.split(",").map((p) => p.trim()).filter(Boolean),
        model: form.model.value.trim(),
        approval_mode: form.querySelector("[name=approval_mode]:checked")?.value ?? "bypass",
      };
      if (form.effort?.value) body.effort = form.effort.value;
      if (!body.name || !body.role || !body.initial_task) throw new Error("Name, role and task are required");
      if (body.agent_type === "api") {
        body.provider = form.provider?.value ?? "";
        if (!body.provider) throw new Error("Add an API provider first (Manage providers…)");
      } else if (avail[body.agent_type] === false) throw new Error(tr("{type} CLI is not installed on this machine", { type: body.agent_type }));
      const r = await api("agents/add", body);
      toast(tr(r?.message ?? "Agent launched"), "ok");
    },
  });
}

function newSessionModal() {
  openModal({
    title: "New empty session", submitLabel: "Create session",
    body: `<div class="form-grid">
      <label>Session name</label><input type="text" name="name" autofocus>
      <label>Project directory</label><input type="text" name="dir" placeholder="/absolute/path/to/project">
    </div><div class="field-hint" style="margin-top:8px">${tr("Like <span class=\"mono\">multiagents session create</span>: writes .multiagents/session.json into the directory. Add agents afterwards, or use <b>New Team</b> to launch a whole team.")}</div>`,
    onSubmit: async (form) => {
      const r = await api("session/create", { name: form.name.value.trim(), project_dir: form.dir.value.trim() });
      toast(tr("Session \"{id}\" created", { id: r?.id }), "ok");
    },
  });
}

const TEAM_PRESETS = {
  "Worker + Reviewer": [
    { agent_type: "gemini", name: "Antigravity Worker", role: "Software Engineer", initial_task: "" },
    { agent_type: "claude", name: "Claude Reviewer", role: "Code Reviewer", initial_task: "" },
  ],
  "Engineer + Reviewer + QA": [
    { agent_type: "claude", name: "Engineer", role: "Software Engineer", initial_task: "" },
    { agent_type: "codex", name: "Reviewer", role: "Code Reviewer", initial_task: "" },
    { agent_type: "gemini", name: "QA", role: "QA Engineer", initial_task: "" },
  ],
};

async function newTeamModal() {
  const [avail] = await Promise.all([loadAvailability(), loadApiProviders()]);
  const fallback = ["claude", "codex", "gemini", "api"].find((t) => avail[t] !== false) ?? "claude";
  const pick = (t) => (avail[t] === false ? fallback : t);
  providersReturn = () => newTeamModal();

  const DRAFT_KEY = "multiagents:draft:new-team";
  let draft = null;
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) draft = JSON.parse(raw);
  } catch {}

  const hasDraft = !!(draft && (draft.dir || draft.name || draft.goal || draft.plan || (draft.agents && draft.agents.length)));
  const initialAgents = (hasDraft && draft.agents?.length) ? draft.agents : TEAM_PRESETS["Worker + Reviewer"];

  const providerSelect = (a) => `<select data-f="provider" class="api-only" ${pick(a.agent_type) === "api" ? "" : "hidden"} title="${esc(tr("Provider"))}">${apiProviders.map((p) => `<option value="${esc(p.id)}" ${p.id === a.provider ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>`;
  const agentRow = (a) => `<div class="team-agent">
    <div class="team-agent-row">
      <select data-f="agent_type">${typeOptions(pick(a.agent_type), avail)}</select>
      ${providerSelect(a)}
      <input type="text" data-f="name" placeholder="Name" value="${esc(a.name)}">
      <input type="text" data-f="role" list="role-suggestions" placeholder="Role" value="${esc(a.role)}">
      <button type="button" class="icon-btn" data-remove-agent title="Remove">&#10005;</button>
    </div>
    <div class="team-agent-row" style="grid-template-columns:1fr 1fr;margin-top:8px">
      <input type="text" data-f="model" list="models-all" placeholder="model (default)" value="${esc(a.model ?? "")}">
      <select data-f="approval_mode" title="Who approves this agent's steps">${APPROVAL_MODES.map(([v, l]) => `<option value="${v}" ${v === (a.approval_mode ?? "bypass") ? "selected" : ""}>${tr(l)}</option>`).join("")}</select>
    </div>
    <textarea data-f="initial_task" rows="2" placeholder="Agent-specific task (optional — the team goal is shared with everyone)">${esc(a.initial_task ?? "")}</textarea>
  </div>`;
  openModal({
    title: "New team", submitLabel: "Start Team", wide: true,
    body: `<div id="new-team-draft-banner" class="draft-banner" style="display:${hasDraft ? "flex" : "none"};align-items:center;justify-content:space-between;background:var(--accent-dim,#2563eb18);border:1px solid var(--accent,#2563eb40);border-radius:6px;padding:7px 12px;margin-bottom:12px;font-size:12.5px;color:var(--text)">
        <span>💾 ${tr("Draft restored from cache")}</span>
        <button type="button" class="btn small" data-reset-draft style="margin:0;padding:2px 8px;font-size:11.5px">${tr("Clear draft")}</button>
      </div>
      <div class="section-label">Project</div>
      <div class="form-grid">
        <label>Working directory</label><input type="text" name="dir" value="${esc(draft?.dir ?? "")}" placeholder="/absolute/path/to/project (created if missing)" autofocus>
        <label>Session name</label><input type="text" name="name" value="${esc(draft?.name ?? "")}" placeholder="e.g. 食物过敏论文 / Manuscript Revision">
        <label>Team goal / prompt</label><textarea name="goal" rows="4" placeholder="What should the team achieve?">${esc(draft?.goal ?? "")}</textarea>
      </div>
      <div class="section-label">Agents ${Object.keys(TEAM_PRESETS).map((p) => `<button type="button" class="btn small" data-preset="${esc(p)}">${esc(tr(p))}</button>`).join("")}</div>
      <div data-agents>${initialAgents.map(agentRow).join("")}</div>
      <button type="button" class="btn small" data-add-agent>+ Add agent</button>
      <button type="button" class="btn small" data-manage-providers>${tr("Manage providers…")}</button>
      <div class="section-label">Plan (optional)</div>
      <textarea name="plan" rows="3" style="width:100%" placeholder="${esc(tr("One task per line. Prefix with an agent name and a colon to assign it, e.g. \"Claude Reviewer: Review the API\""))}">${esc(draft?.plan ?? "")}</textarea>
      <div class="section-label">Workflow</div>
      <label class="checkbox"><input type="checkbox" name="wf_approval" ${draft ? (draft.wf_approval ? "checked" : "") : "checked"}><span>${tr("Require reviewer approval")}<small>${tr("Work counts as finished only after an explicit approve.")}</small></span></label>
      <label class="checkbox" style="margin-top:6px"><input type="checkbox" name="wf_feedback" ${draft ? (draft.wf_feedback ? "checked" : "") : "checked"}><span>${tr("Require actionable feedback before revision")}<small>${tr("Reviewers must say concretely what to change.")}</small></span></label>
      <label class="checkbox" style="margin-top:6px"><input type="checkbox" name="wf_human" ${draft ? (draft.wf_human ? "checked" : "") : "checked"}><span>${tr("Pause for human approval before release")}<small>${tr("Human gate: once everything is approved the session waits for you (Approve & Release / Send back) instead of ending itself.")}</small></span></label>
      ${roleDatalist()}
      <datalist id="models-all">${Object.values(MODEL_SUGGESTIONS).flat().map((m) => `<option value="${m}">`).join("")}</datalist>`,
    setup: (form) => {
      const list = form.querySelector("[data-agents]");

      const collectDraft = () => {
        const agents = [...form.querySelectorAll(".team-agent")].map((row) => ({
          agent_type: row.querySelector("[data-f=agent_type]")?.value || "",
          provider: row.querySelector("[data-f=provider]")?.value || "",
          name: row.querySelector("[data-f=name]")?.value || "",
          role: row.querySelector("[data-f=role]")?.value || "",
          model: row.querySelector("[data-f=model]")?.value || "",
          approval_mode: row.querySelector("[data-f=approval_mode]")?.value || "bypass",
          initial_task: row.querySelector("[data-f=initial_task]")?.value || "",
        }));
        return {
          dir: form.dir?.value || "",
          name: form.name?.value || "",
          goal: form.goal?.value || "",
          plan: form.plan?.value || "",
          wf_approval: form.wf_approval?.checked ?? true,
          wf_feedback: form.wf_feedback?.checked ?? true,
          wf_human: form.wf_human?.checked ?? true,
          agents,
        };
      };

      const saveDraft = () => {
        try {
          const d = collectDraft();
          const hasContent = d.dir || d.name || d.goal || d.plan || d.agents.some((a) => a.name || a.role || a.initial_task);
          if (hasContent) {
            localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, updated_at: Date.now() }));
          }
        } catch {}
      };

      // 点叉叉或取消时询问是否保存草稿
      form.querySelectorAll("[data-close]").forEach((b) => {
        b.addEventListener("click", async (e) => {
          e.stopPropagation();
          e.preventDefault();
          const d = collectDraft();
          const hasContent = !!(d.dir || d.name || d.goal || d.plan || d.agents.some((a) => a.name || a.role || a.initial_task));
          if (hasContent) {
            const keep = await confirmDialog({
              title: "Save draft?",
              message: `<p>${tr("Would you like to keep your changes as a draft for next time?")}</p>`,
              confirmLabel: "Save draft",
              cancelLabel: "Discard",
            });
            if (keep) {
              try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, updated_at: Date.now() })); } catch {}
              toast(tr("Draft saved"), "info");
            } else {
              try { localStorage.removeItem(DRAFT_KEY); } catch {}
            }
          } else {
            closeModal();
          }
        }, true);
      });

      form.addEventListener("input", saveDraft);
      form.addEventListener("change", saveDraft);

      form.querySelector("[data-add-agent]").addEventListener("click", () => {
        list.insertAdjacentHTML("beforeend", agentRow({ agent_type: fallback, name: "", role: "", initial_task: "" }));
        saveDraft();
      });

      list.addEventListener("click", (e) => {
        if (e.target.closest("[data-remove-agent]")) {
          e.target.closest(".team-agent").remove();
          saveDraft();
        }
      });

      list.addEventListener("change", (e) => {
        const type = e.target.closest("[data-f=agent_type]");
        if (!type) return;
        const row = type.closest(".team-agent");
        row.querySelector("[data-f=provider]").hidden = type.value !== "api";
        const model = row.querySelector("[data-f=model]");
        model.placeholder = type.value === "api" ? (providerById(row.querySelector("[data-f=provider]").value)?.default_model || tr("model name")) : tr("model (default)");
      });

      form.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
        list.innerHTML = TEAM_PRESETS[b.dataset.preset].map(agentRow).join("");
        saveDraft();
      }));

      form.querySelector("[data-reset-draft]")?.addEventListener("click", () => {
        try { localStorage.removeItem(DRAFT_KEY); } catch {}
        form.dir.value = "";
        form.name.value = "";
        form.goal.value = "";
        form.plan.value = "";
        form.wf_approval.checked = true;
        form.wf_feedback.checked = true;
        form.wf_human.checked = true;
        list.innerHTML = TEAM_PRESETS["Worker + Reviewer"].map(agentRow).join("");
        const banner = form.querySelector("#new-team-draft-banner");
        if (banner) banner.style.display = "none";
        toast(tr("Draft cleared"), "info");
      });
    },
    onSubmit: async (form) => {
      const agents = [...form.querySelectorAll(".team-agent")].map((row) => {
        const a = {};
        row.querySelectorAll("[data-f]").forEach((f) => { a[f.dataset.f] = f.value.trim(); });
        if (!a.model) delete a.model;
        if (a.agent_type === "gemini") a.approval_mode = "bypass";
        if (a.agent_type !== "api") delete a.provider;
        return a;
      });
      if (agents.some((a) => a.agent_type === "api" && !a.provider)) throw new Error("Add an API provider first (Manage providers…)");
      if (!agents.length) throw new Error("Add at least one agent");
      if (agents.some((a) => !a.name || !a.role)) throw new Error("Every agent needs a name and a role");
      const unavailable = agents.filter((a) => a.agent_type !== "api" && avail[a.agent_type] === false).map((a) => `${a.name} (${a.agent_type})`);
      if (unavailable.length) throw new Error(tr("Not installed on this machine: {list}", { list: unavailable.join(", ") }));
      const names = agents.map((a) => a.name.toLowerCase());
      const plan = form.plan.value.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
        const m = line.match(/^([^:：]{1,60})[:：]\s*(.+)$/);
        return m && names.includes(m[1].trim().toLowerCase())
          ? { label: m[2], agent_name: agents[names.indexOf(m[1].trim().toLowerCase())].name }
          : { label: line };
      });
      const body = {
        project_dir: form.dir.value.trim(), session_name: form.name.value.trim(), goal: form.goal.value.trim(), agents, plan,
        workflow: { require_reviewer_approval: form.wf_approval.checked, require_actionable_feedback: form.wf_feedback.checked, human_release: form.wf_human.checked },
      };
      if (!body.project_dir || !body.session_name) throw new Error("Working directory and session name are required");
      toast(tr("Starting team — agents take 15–60s to connect…"), "info");
      const r = await api("team/create", body);
      try { localStorage.removeItem(DRAFT_KEY); } catch {}
      toast(tr("Team started: {id}", { id: r?.data?.session_id ?? body.session_name }), "ok");
    },
  });
}

// --- Broker info ---

$("broker-pill").addEventListener("click", async () => {
  let info;
  try { info = await api("broker"); } catch (e) { return toast(tr("Broker status failed: {error}", { error: e.message }), "error"); }
  openModal({
    title: "Broker", submitLabel: "Close",
    body: `<div class="form-grid">
      <label>Status</label><span>${info.alive ? `<span style="color:var(--green)">&#9679; ${tr("running")}</span>` : `<span style="color:var(--red)">&#9679; ${tr("not running")}</span>`}</span>
      <label>URL</label><span class="mono">${esc(info.url)}</span>
      <label>Sessions</label><span>${tr("{n} ({active} active)", { n: info.sessions, active: info.active_sessions })}</span>
      <label>Peers</label><span>${tr("{n} registered", { n: info.peers })}</span>
      <label>Current session</label><span class="mono">${esc(info.current_session ?? "—")}</span>
      <label>This dashboard runs</label><span>${tr("{n} agent(s) of the current session", { n: (state?.managedSlots ?? []).length })}</span>
    </div><div class="field-hint" style="margin-top:10px">${tr("Stop the broker from a terminal with <span class=\"mono\">multiagents kill-broker</span> — it disconnects every agent on the machine.")}</div>`,
    onSubmit: () => {},
  });
});

// --- Helpers ---

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + "…" : s; }
function baseName(p) { return String(p ?? "").replace(/\/+$/, "").split("/").pop(); }
function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtUsd(n) { return `$${(n ?? 0) < 1 ? (n ?? 0).toFixed(3) : (n ?? 0).toFixed(2)}`; }
function fmtBytes(n) {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}
function fmtDuration(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (d >= 2) return tr("{d}d {h}h", { d, h });
  if (d > 0 || h > 0) return tr("{h}h {m}m", { h: d * 24 + h, m });
  return m > 0 ? tr("{m}m {s}s", { m, s }) : tr("{s}s", { s });
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}
function fmtDay(t) {
  const d = new Date(t), today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return tr("Today");
  if (d.toDateString() === yesterday.toDateString()) return tr("Yesterday");
  return d.toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric" });
}
function timeSince(epoch) {
  if (!epoch) return "";
  const s = Math.round((Date.now() - epoch) / 1000);
  if (s < 60) return tr("{n}s ago", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return tr("{n}m ago", { n: m });
  const h = Math.floor(m / 60);
  if (h < 48) return tr("{n}h ago", { n: h });
  return tr("{n}d ago", { n: Math.floor(h / 24) });
}

// --- Session picker ---

let pickerFocusIdx = 0;
let pickerFiltered = [];

function openPicker() {
  $("picker-overlay").classList.add("open");
  $("picker-search").value = "";
  $("picker-search").focus();
  renderPicker();
}

function closePicker() { $("picker-overlay").classList.remove("open"); }

function renderPicker() {
  const search = $("picker-search").value.toLowerCase();
  pickerFiltered = sortedSessions(state?.sessions).filter((s) => !search || s.name?.toLowerCase().includes(search) || s.id.toLowerCase().includes(search));
  pickerFocusIdx = Math.min(pickerFocusIdx, Math.max(0, pickerFiltered.length - 1));
  const list = $("picker-list");
  if (!pickerFiltered.length) { list.innerHTML = `<div class="picker-empty">${tr("No sessions found")}</div>`; return; }
  list.innerHTML = pickerFiltered.map((s, i) => `<div class="picker-item${i === pickerFocusIdx ? " focused" : ""}${state?.sessionId === s.id ? " active" : ""}" data-idx="${i}">
      ${statusDot(s.status)}
      <span class="picker-item-name">${esc(s.name || s.id)}</span>
      <span class="picker-item-id">${esc(tr(s.status))}</span>
      <span class="picker-item-time">${timeSince(s.last_active_at ?? s.created_at)}</span>
    </div>`).join("");
  list.querySelector(".focused")?.scrollIntoView({ block: "nearest" });
}

async function selectSession(id) {
  closePicker();
  try {
    const res = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: id }) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
  } catch (e) {
    toast(tr("Switching session failed: {error}", { error: e.message }), "error");
  }
}

$("session-name").addEventListener("click", openPicker);
$("picker-overlay").addEventListener("click", (e) => { if (e.target.id === "picker-overlay") closePicker(); });
$("modal-overlay").addEventListener("mousedown", (e) => {
  if (e.target.id === "modal-overlay") {
    const modal = $("modal-overlay").querySelector(".modal");
    if (modal && modal.classList.contains("wide")) return;
    closeModal();
  }
});
$("picker-search").addEventListener("input", () => { pickerFocusIdx = 0; renderPicker(); });
$("picker-list").addEventListener("click", (e) => {
  const item = e.target.closest(".picker-item");
  if (item) selectSession(pickerFiltered[parseInt(item.dataset.idx, 10)].id);
});
$("picker-search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closePicker(); e.preventDefault(); return; }
  if (e.key === "ArrowDown") { pickerFocusIdx = Math.min(pickerFocusIdx + 1, pickerFiltered.length - 1); renderPicker(); e.preventDefault(); return; }
  if (e.key === "ArrowUp") { pickerFocusIdx = Math.max(pickerFocusIdx - 1, 0); renderPicker(); e.preventDefault(); return; }
  if (e.key === "Enter" && pickerFiltered[pickerFocusIdx] && !e.isComposing) { selectSession(pickerFiltered[pickerFocusIdx].id); e.preventDefault(); }
});

// --- Boot ---

applyLanguage();
applyAppearance();
applyLayout();
$("msg-show-system").checked = store.get("ma-show-system", false);
switchRightTab(store.get("ma-rtab", "preview"));
{ const t = store.get("ma-tab", "chat"); if (TABS.includes(t) && t !== "chat") switchTab(t); }
closePreview();
renderTree();
connectWs();
loadPlanUsage();
setInterval(() => { if (!document.hidden) loadPlanUsage(); }, 5 * 60_000);
if (STALE_SERVER) toast("This dashboard server is older than the page: stop the old dashboard process and start it again. / 网页服务是旧版本：请结束旧的 dashboard 进程后重新启动。", "error");

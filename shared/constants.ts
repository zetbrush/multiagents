// ============================================================================
// multiagents — Constants & Defaults
// ============================================================================

import type { AgentType, Guardrail } from "./types.ts";

// --- Networking ---

export const DEFAULT_BROKER_PORT = 7899;
export const DEFAULT_DB_PATH = `${process.env.HOME}/.multiagents/peers.db`;
export const BROKER_HOSTNAME = "127.0.0.1";

// --- Polling intervals (ms) ---

export const POLL_INTERVALS: Record<AgentType, number> = {
  claude: 1000, // Claude uses channel push — polling is fallback only
  codex: 300, // Aggressive: piggyback delivery depends on fast buffering
  gemini: 300, // Same as Codex — no push capability
  kimi: 500, // Kimi K2.6 — push capability to be tested, fallback polling
  copilot: 300, // Copilot CLI — no push, aggressive polling for piggyback
  qwen: 300, // Qwen CLI — same as Gemini, no push
  jinn: 1000, // Jinn bridge — gateway API bridge, moderate polling
  custom: 500, // Reasonable default for unknown agents
};

export const HEARTBEAT_INTERVAL = 15_000; // 15s
export const CLEANUP_INTERVAL = 30_000; // 30s
export const DASHBOARD_REFRESH = 500; // 500ms

// --- Broker startup ---

export const BROKER_STARTUP_POLL_MS = 200;
export const BROKER_STARTUP_MAX_ATTEMPTS = 30; // 30 * 200ms = 6s max wait
export const BROKER_HEALTH_TIMEOUT = 2000; // 2s timeout for health check

// --- File locks ---

export const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// --- Sessions ---

export const SESSION_DIR = ".multiagents";
export const SESSION_FILE = ".multiagents/session.json";
export const RECONNECT_RECAP_LIMIT = 20; // messages to replay on reconnect

// --- Agent ID prefixes ---

export const AGENT_ID_PREFIXES: Record<AgentType, string> = {
  claude: "cl",
  codex: "cx",
  gemini: "gm",
  kimi: "km",
  copilot: "cp",
  qwen: "qw",
  jinn: "jn",
  custom: "cu",
};

export const AGENT_ID_LENGTH = 8; // total chars including prefix + hyphen (e.g. "cl-a1b2c3")

// --- Guardrail defaults ---

export const DEFAULT_GUARDRAILS: Guardrail[] = [
  // --- Monitoring stats (observe-only, no enforcement) ---
  {
    id: "session_duration",
    label: "Session Duration",
    description: "How long the session has been running",
    current_value: 0,       // no limit — monitor only
    default_value: 0,
    unit: "minutes",
    scope: "session",
    action: "monitor",
    warn_at_percent: 1.0,   // never warns
    adjustable: false,
    suggested_increases: [],
  },
  {
    id: "messages_total",
    label: "Total Messages",
    description: "Total messages exchanged across all agents",
    current_value: 0,
    default_value: 0,
    unit: "messages",
    scope: "session",
    action: "monitor",
    warn_at_percent: 1.0,
    adjustable: false,
    suggested_increases: [],
  },
  {
    id: "messages_per_agent",
    label: "Messages Per Agent (max)",
    description: "Highest message count from any single agent",
    current_value: 0,
    default_value: 0,
    unit: "messages",
    scope: "per_agent",
    action: "monitor",
    warn_at_percent: 1.0,
    adjustable: false,
    suggested_increases: [],
  },
  {
    id: "agent_count",
    label: "Active Agents",
    description: "Currently connected agents",
    current_value: 0,
    default_value: 0,
    unit: "agents",
    scope: "session",
    action: "monitor",
    warn_at_percent: 1.0,
    adjustable: false,
    suggested_increases: [],
  },
  {
    id: "idle_max",
    label: "Longest Idle",
    description: "Longest time any agent has gone without activity",
    current_value: 0,
    default_value: 0,
    unit: "minutes",
    scope: "per_agent",
    action: "monitor",
    warn_at_percent: 1.0,
    adjustable: false,
    suggested_increases: [],
  },
  // --- Actual guardrail (enforced) ---
  {
    id: "max_restarts",
    label: "Restart Limit",
    description:
      "Stops flapping agents after too many crash-restart cycles",
    current_value: 5,
    default_value: 5,
    unit: "restarts",
    scope: "per_agent",
    action: "stop",
    warn_at_percent: 0.6,
    adjustable: true,
    suggested_increases: [8, 12, 20],
  },
];

// --- Orchestrator ---

export const STUCK_THRESHOLD_MS = 2 * 60 * 1000; // 2 min — agent considered stuck
export const SLOW_THRESHOLD_MS = 30 * 1000; // 30s — agent considered slow
export const NUDGE_WAIT_MS = 30 * 1000; // 30s after nudge before escalating
export const FLAP_WINDOW_MS = 5 * 60 * 1000; // 5 min window for flap detection
export const FLAP_THRESHOLD = 3; // crashes in window before declaring flapping
export const GUARDRAIL_CHECK_INTERVAL = 30_000; // 30s
export const CONFLICT_CHECK_INTERVAL = 10_000; // 10s

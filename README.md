# multiagents

[![npm version](https://img.shields.io/npm/v/multiagents.svg)](https://www.npmjs.com/package/multiagents)
[![npm downloads](https://img.shields.io/npm/dm/multiagents.svg)](https://www.npmjs.com/package/multiagents)

Multi-agent orchestration platform for **Claude Code**, **Codex CLI**, and **Gemini CLI**. Enables AI agents to discover each other, communicate in real-time, coordinate file edits, and work as a team on shared codebases.

Built on [MCP (Model Context Protocol)](https://modelcontextprotocol.io/).

## What It Does

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Claude Code  │     │  Codex CLI  │     │ Gemini CLI  │
│ (Engineer)   │     │ (Reviewer)  │     │ (Designer)  │
└──────┬───────┘     └──────┬──────┘     └──────┬──────┘
       │   MCP (stdio)      │  CodexDriver       │
       └────────────┬───────┴────────────────────┘
                    │
            ┌───────▼────────┐
            │  Broker Daemon  │  SQLite + HTTP on localhost:7899
            │  (singleton)    │
            └───────┬────────┘
                    │
            ┌───────▼────────┐
            │  Orchestrator   │  MCP server for Claude Desktop
            │  (team manager) │  Spawns agents, forwards messages,
            └────────────────┘  monitors progress, auto-restarts
```

- **Peer discovery**: agents find each other via `list_peers`
- **Real-time messaging**: instant for Claude (channel push), <3s for Codex (mid-turn steer), 1-3s for Gemini (piggyback)
- **Role assignment**: `assign_role`, `rename_peer` at runtime
- **File coordination**: exclusive locks + ownership zones prevent conflicts
- **Task lifecycle**: `idle → working → done_pending_review → addressing_feedback → approved → released`
- **Review loops**: `signal_done → submit_feedback → fix → re-review → approve`
- **Shared knowledge**: persistent key-value store for architectural decisions, discovered patterns, and project context — prevents context drift across agents
- **Persistent sessions**: survive agent restarts, full message history
- **TUI dashboard**: real-time monitoring with 5 tabs (agents, messages, stats, plan, files)
- **Auto-restart**: crashed agents respawn with handoff context
- **Graceful shutdown**: broker and orchestrator kill all managed processes on exit

## Quick Start

```bash
# Install globally
bun install -g multiagents

# Setup (detects CLIs, configures MCP servers, starts broker)
multiagents setup

# Restart your Claude Code / Codex / Gemini sessions to load MCP tools

# Monitor
multiagents dashboard
```

### From Claude Desktop (Orchestrator)

Ask Claude to create a team:

> "Create a team of 3 agents: a Claude engineer, a Codex reviewer, and a Gemini designer.
> Build a calculator web app in TypeScript."

The orchestrator handles everything: spawning agents, assigning roles, creating slots, launching the dashboard, and forwarding messages between agents.

## Agent Support

| Agent | Delivery Mechanism | Latency | Config |
|-------|-------------------|---------|--------|
| Claude Code | Channel push notifications | Instant | `~/.claude/settings.json` |
| Codex CLI | CodexDriver (`codex app-server`) | <3s mid-turn, 3-9s between turns | `~/.codex/config.toml` |
| Gemini CLI | Piggyback on MCP tool responses | 1-3s | `~/.gemini/settings.json` |

### Codex Integration (CodexDriver)

Codex CLI uses the **app-server protocol** — a JSON-RPC stdio interface with threads, turns, and rich notifications. The orchestrator uses a **CodexDriver** that:

1. Spawns a persistent `codex app-server` process with JSON-RPC handshake
2. Creates a thread (`thread/start`) and drives turns (`turn/start`) for task execution
3. Injects messages mid-turn via `turn/steer` — no waiting for the current turn to finish
4. Interrupts stuck turns via `turn/interrupt` when agents go idle for >60s
5. Auto-approves all server-initiated requests (command execution, file changes, MCP elicitations)
6. Tracks token usage from `turn/completed` notifications

The orchestrator **drives Codex turns**: the forwarding loop polls the broker every 3s. If Codex has an active turn, messages are steered in instantly. If idle, a new turn is started via `driver.reply()`.

## Task State Machine

Every agent slot has a `task_state` that governs the review/approval workflow:

```
                    ┌──────────── (reviewer/QA roles) ────────────┐
                    │                                              ▼
idle ──► working ──► done_pending_review ──► addressing_feedback  approved ──► released
                         │                         │                ▲
                         │                         └────────────────┘
                         └──────────► approved ─────────────────────┘
```

- **idle → working**: Auto-transitions when agent calls `set_summary` or produces first output
- **working → done_pending_review**: Agent calls `signal_done`
- **working → approved**: Reviewer/QA agents auto-approve on `signal_done` (they don't need external review)
- **done_pending_review → addressing_feedback**: Reviewer calls `submit_feedback(actionable=true)`
- **addressing_feedback → done_pending_review**: Agent fixes issues and calls `signal_done` again
- **done_pending_review → approved**: Reviewer calls `approve`
- **approved → released**: Orchestrator calls `release_agent`

Agents **cannot disconnect** until explicitly released. This ensures the review loop completes.

## MCP Tools (Available to All Agents)

| Tool | Description |
|------|-------------|
| `list_peers` | Discover agents (filter by scope, type) |
| `send_message` | Send text message to a peer |
| `check_messages` | Poll for new messages |
| `set_summary` | Update your status (visible to peers and dashboard) |
| `check_team_status` | See all agents: roles, states, summaries |
| `get_plan` / `update_plan` | Track team progress against the plan |
| `signal_done` | Signal task completion (triggers review) |
| `submit_feedback` | Send review feedback (actionable or informational) |
| `approve` | Approve a teammate's work |
| `assign_role` / `rename_peer` | Assign roles and names |
| `acquire_file` / `release_file` | File lock management |
| `view_file_locks` | See active locks and ownership zones |
| `get_history` | Query session message history |
| `store_knowledge` | Store shared knowledge (decisions, patterns, conventions) |
| `query_knowledge` | Query knowledge entries by key or category |
| `remove_knowledge` | Remove outdated knowledge entries |

## Orchestrator Tools (Claude Desktop)

| Tool | Description |
|------|-------------|
| `create_team` | Spawn a team with roles, file ownership, and a plan |
| `get_team_status` | Live status of all agents with completion tracking |
| `broadcast_to_team` | Message all agents at once |
| `direct_agent` | Message a specific agent by name/role |
| `add_agent` / `remove_agent` | Add or remove agents mid-session |
| `control_session` | Pause/resume all or individual agents |
| `adjust_guardrail` | View or change session limits |
| `release_agent` / `release_all` | Release agents to disconnect |
| `get_session_log` | Full message history |
| `list_sessions` / `resume_session` | List and resume previous sessions |
| `end_session` / `delete_session` | Archive or permanently delete |
| `cleanup_dead_slots` | Remove stale disconnected slots |
| `get_guide` | Built-in documentation and tutorials |

## Sessions

Sessions persist across agent restarts:

```bash
multiagents session create "Auth Feature"    # Create session
multiagents session list                     # List all sessions
multiagents session resume auth-feature      # Resume (respawns agents)
multiagents session pause                    # Pause all agents
multiagents session delete auth-feature      # Permanently delete
```

## File Coordination

**Ownership Zones** (static, zero overhead):
```
create_team assigns: Engineer owns src/**, Reviewer owns tests/**
```

**File Locks** (dynamic, for shared files):
```
Engineer: acquire_file("package.json", "adding dependency")
→ Lock acquired, auto-expires in 5 minutes
```

## Shared Knowledge Store

Agents share a persistent key-value store to prevent context drift — the #1 failure mode in multi-agent systems.

```
Engineer:  store_knowledge("auth-pattern", "JWT with refresh rotation", category="decision")
Designer:  query_knowledge()  →  sees the decision before designing auth UI
Reviewer:  query_knowledge(category="decision")  →  reviews against team decisions
```

**Categories**: `decision`, `convention`, `discovery`, `blocker`, `context`

Knowledge persists across agent restarts and is scoped to the session. Agents are instructed to query knowledge on startup and store decisions as they work.

## Guardrails

Session monitoring stats and enforced limits:

| Guardrail | Default | Scope | Action |
|-----------|---------|-------|--------|
| Restart Limit | 5 | Per agent | Stop (prevents flapping) |
| Session Duration | Monitor | Session | Observe |
| Total Messages | Monitor | Session | Observe |
| Active Agents | Monitor | Session | Observe |
| Longest Idle | Monitor | Per agent | Observe |

Adjustable from the TUI dashboard (+/- keys) or via `adjust_guardrail` tool.

## TUI Dashboard

```bash
multiagents dashboard [session-id]
```

5-tab interface:
- **[1] Agents**: connection status, task state, summaries
- **[2] Messages**: auto-scrolling message log with filtering
- **[3] Stats**: guardrail monitoring and adjustment
- **[4] Plan**: progress tracking with completion percentage
- **[5] Files**: file locks and ownership zones

Keys: `1-5` switch tabs, `j/k` scroll, `p` pause all, `r` resume all, `+/-` adjust guardrails, `q` quit.

## CLI Commands

```
multiagents setup                     Interactive setup wizard
multiagents dashboard [session-id]    TUI dashboard
multiagents session <sub>             Session management (create/list/resume/pause/delete)
multiagents send <target> <msg>       Send message to agent
multiagents peers                     List connected agents
multiagents status                    Broker health + peers
multiagents broker start|stop|status  Manage broker daemon
multiagents install-mcp               Configure MCP servers
multiagents help [command]            Detailed help
```

## Architecture

```
multiagents/
├── broker.ts               SQLite broker daemon (sessions, slots, locks, messages, knowledge, guardrails)
├── server.ts               MCP server entry point (dispatches to adapter by --agent-type)
├── cli.ts                  CLI entry point
├── shared/
│   ├── types.ts            Type definitions (Peer, Slot, Session, Message, TaskState...)
│   ├── broker-client.ts    HTTP client for broker API
│   ├── constants.ts        Ports, intervals, thresholds
│   ├── summarize.ts        Auto-summary generation
│   └── utils.ts            Shared utilities
├── adapters/
│   ├── base-adapter.ts     Abstract MCP adapter (tools, registration, polling)
│   ├── claude-adapter.ts   Claude Code adapter (channel push delivery)
│   ├── codex-adapter.ts    Codex adapter (piggyback + file inbox delivery)
│   ├── gemini-adapter.ts   Gemini adapter (piggyback + file inbox delivery)
│   └── role-practices.ts   Role-specific best practices injection
├── orchestrator/
│   ├── orchestrator-server.ts  Orchestrator MCP server (team management)
│   ├── codex-driver.ts     CodexDriver: persistent codex app-server via JSON-RPC (steer/interrupt)
│   ├── launcher.ts         Agent spawning (CLI args, MCP configs, CodexDriver)
│   ├── monitor.ts          Process monitoring (stdout parsing, token tracking)
│   ├── recovery.ts         Crash recovery (flap detection, respawn with context)
│   ├── progress.ts         Team status aggregation
│   ├── session-control.ts  Pause/resume/broadcast
│   ├── guardrails.ts       Guardrail enforcement
│   └── guide.ts            Built-in documentation
└── cli/
    ├── commands.ts         CLI command router
    ├── dashboard.ts        TUI dashboard (ANSI, no dependencies)
    ├── session.ts          Session management commands
    ├── setup.ts            Interactive setup wizard
    └── install-mcp.ts      MCP server configuration
```

## Process Lifecycle

### Graceful Shutdown
- **Broker** (`SIGINT`/`SIGTERM`): kills all registered peer processes, closes SQLite cleanly
- **Orchestrator** (`SIGINT`/`SIGTERM`): kills all managed agent processes and CodexDriver instances
- **Adapters** (`SIGINT`/`SIGTERM`): unregister from broker, release file locks

### Orphan Prevention
- Broker's `cleanStalePeers` runs every 30s: removes dead peer records, kills orphan processes without sessions
- CodexDriver uses `.multiagents/.driver-mode` sentinel file to prevent internal MCP adapters from creating ghost slots
- Session delete/end handlers kill both regular processes and CodexDriver instances
- Flap detection stops auto-restart after 3 crashes in 5 minutes

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MULTIAGENTS_PORT` | `7899` | Broker HTTP port |
| `MULTIAGENTS_DB` | `~/.multiagents/peers.db` | SQLite database path |
| `MULTIAGENTS_SESSION` | - | Session ID (set by orchestrator) |
| `MULTIAGENTS_SLOT` | - | Slot ID (set by orchestrator) |
| `MULTIAGENTS_ROLE` | - | Agent role (set by orchestrator) |
| `MULTIAGENTS_NAME` | - | Agent display name (set by orchestrator) |
| `MULTIAGENTS_DRIVER_MODE` | - | Skip adapter registration (set by CodexDriver) |

## Requirements

- [Bun](https://bun.sh/) runtime (v1.1+)
- At least one of: Claude Code, Codex CLI, or Gemini CLI

## License

MIT

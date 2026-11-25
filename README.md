# multiagents

[![npm version](https://img.shields.io/npm/v/multiagents.svg)](https://www.npmjs.com/package/multiagents)
[![npm downloads](https://img.shields.io/npm/dm/multiagents.svg)](https://www.npmjs.com/package/multiagents)

Multi-agent orchestration platform for **Claude Code**, **Codex CLI**, and **Antigravity CLI** (the legacy **Gemini CLI** still works for accounts that can run it). Enables AI agents to discover each other, communicate in real-time, coordinate file edits, and work as a team on shared codebases.

Built on [MCP (Model Context Protocol)](https://modelcontextprotocol.io/).

## What It Does

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Claude Code  │     │  Codex CLI  │     │ Antigravity │
│ (Engineer)   │     │ (Reviewer)  │     │ (Designer)  │
└──────┬───────┘     └──────┬──────┘     └──────┬──────┘
       │ ClaudeDriver + MCP │ CodexDriver + MCP  │ AntigravityDriver + MCP
       └────────────┬───────┴────────────────────┘
                    │
            ┌───────▼────────┐
            │  Broker Daemon  │  SQLite + HTTP on localhost:7899
            │  (singleton)    │
            └───────┬────────┘
                    │
            ┌───────▼────────┐
            │  Orchestrator   │  MCP server for Claude Code (or Claude Desktop)
            │  (team manager) │  Spawns agents, delivers messages,
            └────────────────┘  monitors progress, respawns crashes
```

- **Peer discovery**: agents find each other via `list_peers`
- **Real-time messaging**: orchestrator-launched Claude and Codex agents receive teammate messages mid-turn (stream-json stdin / `turn/steer`); every agent also gets unread messages prepended to its next tool result, and a message is only marked read once it reached the model
- **Role assignment**: `assign_role`, `rename_peer` at runtime
- **File coordination**: exclusive locks + ownership zones prevent conflicts
- **Task lifecycle**: `idle → working → done_pending_review → addressing_feedback → approved → released`
- **Review loops**: `signal_done → submit_feedback → fix → re-review → approve`
- **Shared knowledge**: persistent key-value store for architectural decisions, discovered patterns, and project context — prevents context drift across agents
- **Persistent sessions**: survive agent restarts, full message history
- **Dashboards**: a web dashboard on `localhost:7900` with live WebSocket updates and a 5-tab TUI
- **Auto-restart**: crashed agents respawn with handoff context — a Claude agent resumes its session, a Codex agent its thread
- **Graceful shutdown**: released agents are closed once idle; broker and orchestrator kill all managed processes on exit
- **Self-update**: `multiagents update` upgrades the installation with whichever package manager installed it

## Quick Start

```bash
# Install globally
bun install -g multiagents

# Setup (detects CLIs, configures MCP servers, starts broker)
multiagents setup

# Restart your Claude Code / Codex / Antigravity sessions to load MCP tools

# Monitor
multiagents dashboard

# Later: upgrade to the latest release
multiagents update
```

### From Claude Code (Orchestrator)

`multiagents setup` registers two MCP servers in Claude Code (`~/.claude.json`): `multiagents` (the agent tools) and `multiagents-orch` (the orchestrator). Claude Desktop or any other MCP client can run the orchestrator too (`multiagents orchestrator`). Ask Claude to create a team:

> "Create a team of 3 agents: a Claude engineer, a Codex reviewer, and an Antigravity designer.
> Build a calculator web app in TypeScript."

The orchestrator handles everything: spawning agents, assigning roles, creating slots, launching the dashboards, delivering messages between agents, and respawning agents that crash.

## Agent Support

| Agent | Delivery Mechanism | Latency | Config |
|-------|-------------------|---------|--------|
| Claude Code | ClaudeDriver (`claude -p --input-format stream-json`): messages written as user messages, read mid-turn. Interactive sessions additionally get channel notifications. | ≤3s | `~/.claude.json` (driver-launched agents get an inline `--mcp-config`) |
| Codex CLI | CodexDriver (`codex app-server`): `turn/steer` mid-turn, new turn when idle | <3s mid-turn, 3-9s between turns | `~/.codex/config.toml` |
| Antigravity CLI (`agy`) | AntigravityDriver (`agy --input-format stream-json --output-format stream-json`): a new turn when idle; while a turn runs, messages ride on the agent's next multiagents tool result | ≤3s when idle, next tool call mid-turn | `<project>/.agents/mcp_config.json` (driver-launched agents), `~/.gemini/config/mcp_config.json` (`multiagents setup`) |
| Gemini CLI (legacy) | Prepended to MCP tool results + file inbox | next tool call | `~/.gemini/settings.json` |

All of them also receive unread messages under `[PENDING MESSAGES]` at the top of their next MCP tool result; a message counts as delivered only once it was surfaced to the model (acked), so a dropped delivery is retried instead of lost.

Google stopped serving Gemini CLI to free, AI Pro and AI Ultra accounts on June 18, 2026 in favour of Antigravity CLI; it keeps working with a paid Gemini API key or a Gemini Code Assist Standard/Enterprise licence, so the `gemini` agent type stays available for those accounts.

### Codex Integration (CodexDriver)

Codex CLI uses the **app-server protocol** — a JSON-RPC stdio interface with threads, turns, and rich notifications. The orchestrator uses a **CodexDriver** that:

1. Spawns a persistent `codex app-server` process with JSON-RPC handshake
2. Creates a thread (`thread/start`) and drives turns (`turn/start`) for task execution
3. Injects messages mid-turn via `turn/steer` — no waiting for the current turn to finish
4. Interrupts a turn that has produced nothing for >60s with no command running (`turn/interrupt`) and asks the agent to signal done
5. Answers server-initiated requests unattended: command execution, file changes and permission requests are approved for the session; elicitations and user-input questions are declined; dynamic tool calls are refused
6. Reads token usage from `thread/tokenUsage/updated` (cumulative per thread) and, after a crash, resumes the same thread (`thread/resume`)

Codex only loads MCP servers from the global `~/.codex/config.toml`, so each launch refreshes the `multiagents-peer` section there. The standalone `multiagents` server that `multiagents setup` installs in the same file is left untouched; orchestrated threads switch it off for themselves with a per-thread config override (`mcp_servers.multiagents.enabled = false` on `thread/start` and `thread/resume`), so an agent gets the team tools once.

The orchestrator **drives Codex turns**: the delivery loop polls the broker every 3s. If Codex has an active turn, messages are steered in and acked at once. If idle, a new turn is started via `driver.reply()` and the messages are acked when it completes.

### Claude Integration (ClaudeDriver)

Headless `claude -p` sessions drop MCP channel notifications, so orchestrator-launched Claude agents run inside a **ClaudeDriver**: one long-lived `claude -p --input-format stream-json --output-format stream-json --replay-user-messages` process per agent, with the team MCP server passed inline (`--mcp-config`). Teammate messages are written to its stdin as user messages, which Claude reads at its next tool-call boundary — even in the middle of a long turn. A message is acked only when Claude echoes it back (`isReplay`); until then it stays in flight so no tick writes it again, and if the process dies first the message stays queued for the respawned agent, which resumes the same session (`--resume`). Input and cache tokens are metered per API call from `assistant` events; output tokens at the turn's `result`. A released agent is closed gracefully (stdin EOF) once it goes idle.

### Antigravity Integration (AntigravityDriver)

Orchestrator-launched Antigravity agents run inside an **AntigravityDriver**: one long-lived `agy --input-format stream-json --output-format stream-json --dangerously-skip-permissions` process per agent, fed prompts on stdin as `{"event":"user","message":{"content":…}}` lines. The CLI has no system-prompt or per-launch MCP flag, so the team protocol and role practices ride on the first prompt and the `multiagents-peer` server is registered in the project's own `.agents/mcp_config.json`. The config the CLI shares with the Antigravity app and IDE (`~/.gemini/config/mcp_config.json`) is only touched when it already holds a multiagents entry, because `agy` prefers a same-named global entry over the project one. `agy` starts the adapter as its own child with its working directory and environment, so the adapter gets its slot from the launcher's environment variables, with a per-PID slot file as the fallback.

Antigravity runs one turn per prompt, so the delivery loop only starts a new turn when the session is idle and acks the messages once the CLI reports the prompt as read (`user_input` step). While a turn runs, messages stay unclaimed and reach the model on its next `multiagents-peer` tool call. Token usage comes from each turn's `result` event (cumulative over the conversation, so only the increase is recorded). After a crash the agent is respawned into its conversation (`--conversation <id>`; an id the CLI no longer knows simply starts a new one), and a released agent is closed gracefully (stdin EOF) once idle. `agy` must be signed in (it reuses the Antigravity app's sign-in from the keychain) or configured for a Gemini API key before the orchestrator can run it headless.

The driver follows the CLI's [headless-mode reference](https://antigravity.google/docs/cli/headless) and was checked against `agy` 1.5.13; `MULTIAGENTS_LIVE_TESTS=1 bun test tests/live-antigravity.test.ts` repeats that check against the `agy` installed on your machine, and the rest of the suite runs against a protocol fake (`tests/fakes/fake-agy.ts`).

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

## Orchestrator Tools

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
multiagents session archive auth-feature     # Archive a finished session
multiagents session export auth-feature      # Export the transcript as JSON
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
| Messages Per Agent | Monitor | Per agent | Observe |
| Longest Idle | Monitor | Per agent | Observe |

Adjustable from the TUI dashboard (+/- keys) or via the `adjust_guardrail` tool; the web dashboard shows them read-only (its `/api/guardrail` endpoint exists but has no UI yet).

## Web Dashboard

```bash
multiagents web [session-id]
```

Real-time web dashboard on `localhost:7900` with live WebSocket updates. Auto-opens in browser when a team is created via the orchestrator. 6-tab interface:

- **Agents**: agent cards with connection status, task state, role, summaries, token usage
- **Messages**: live message feed with type badges and sender names
- **Plan**: task progress with completion bar and assignee labels
- **Knowledge**: shared knowledge entries with categories and provenance
- **Files**: file locks and ownership zones
- **Stats**: session metrics (connected agents, working, tokens) and guardrail bars

Dark theme, responsive layout, keyboard shortcuts (`1-6` to switch tabs).

## TUI Dashboard

```bash
multiagents dashboard [session-id]
```

5-tab terminal interface (same data, ANSI rendering):
- **[1] Agents**: connection status, task state, summaries
- **[2] Messages**: auto-scrolling message log with filtering
- **[3] Stats**: guardrail monitoring and adjustment
- **[4] Plan**: progress tracking with completion percentage
- **[5] Files**: file locks and ownership zones

Keys: `1-5` switch tabs, `j/k` scroll, `p` pause all, `r` resume all, `+/-` adjust guardrails, `q` quit.

## CLI Commands

```
multiagents setup                     Interactive setup wizard
multiagents web [session-id]         Web dashboard (localhost:7900)
multiagents dashboard [session-id]    TUI dashboard
multiagents session <sub>             Session management (create/list/resume/pause/archive/delete/export)
multiagents send <target> <msg>       Send message to agent
multiagents peers                     List connected agents
multiagents status                    Broker health + peers
multiagents broker start|stop|status  Manage broker daemon
multiagents install-mcp               Configure MCP servers
multiagents update [--check|--dry-run] Update to the latest version on npm
multiagents version                   Print the installed version
multiagents help [command]            Detailed help
```

`multiagents mcp-server --agent-type <claude|codex|antigravity|gemini>` and `multiagents orchestrator` are the MCP server entry points the agent CLIs and the orchestrator host run; `multiagents setup` configures them.

## Architecture

```
multiagents/
├── broker.ts               SQLite broker daemon (sessions, slots, locks, messages, knowledge, guardrails)
├── server.ts               MCP server entry point (dispatches to adapter by --agent-type)
├── cli.ts                  CLI entry point
├── index.ts                Library entry (types, BrokerClient, constants)
├── noop-mcp.ts             No-op MCP server that neutralizes unwanted global MCP entries in Codex's config
├── shared/
│   ├── types.ts            Type definitions (Peer, Slot, Session, Message, TaskState...)
│   ├── broker-client.ts    HTTP client for broker API
│   ├── broker-url.ts       The one place MULTIAGENTS_PORT is resolved
│   ├── constants.ts        Ports, intervals, thresholds
│   ├── summarize.ts        Git-based activity summary (no API calls)
│   └── utils.ts            Shared utilities
├── adapters/
│   ├── base-adapter.ts     Abstract MCP adapter (tools, registration, pending-message delivery + ack)
│   ├── protocol-text.ts    Team protocol text (short form for MCP instructions, full form for prompts)
│   ├── inbox.ts            File-based inbox for hosts without push (Codex, Antigravity, Gemini)
│   ├── claude-adapter.ts   Claude Code adapter (tool-result delivery + best-effort channel push)
│   ├── codex-adapter.ts    Codex adapter (tool-result delivery + file inbox)
│   ├── antigravity-adapter.ts  Antigravity adapter (tool-result delivery, also under its driver)
│   ├── gemini-adapter.ts   Gemini adapter (tool-result delivery + file inbox)
│   └── role-practices.ts   Role-specific best practices injection
├── orchestrator/
│   ├── orchestrator-server.ts  Orchestrator MCP server (team management, driver delivery loop)
│   ├── claude-driver.ts    ClaudeDriver: long-lived `claude -p --input-format stream-json` session
│   ├── codex-driver.ts     CodexDriver: persistent codex app-server via JSON-RPC (steer/interrupt)
│   ├── antigravity-driver.ts  AntigravityDriver: long-lived `agy --input-format stream-json` session
│   ├── delivery.ts         Hands unacked messages to drivers, acks on confirmed hand-off
│   ├── launcher.ts         Agent spawning (drivers, MCP configs, prompts)
│   ├── monitor.ts          Process/driver monitoring (event parsing, token tracking)
│   ├── recovery.ts         Crash recovery (flap detection, respawn with context)
│   ├── respawn-guard.ts    One respawn per slot at a time
│   ├── supervision.ts      Driver registry, loop tick guard, release/watchdog verdicts
│   ├── progress.ts         Team status aggregation
│   ├── session-control.ts  Pause/resume/broadcast
│   ├── guardrails.ts       Guardrail enforcement
│   └── guide.ts            Built-in documentation
├── cli/
│   ├── commands.ts         CLI command router
│   ├── dashboard.ts        TUI dashboard (ANSI, no dependencies)
│   ├── session.ts          Session management commands
│   ├── setup.ts            Interactive setup wizard
│   ├── install-mcp.ts      MCP server configuration
│   └── update.ts           `multiagents update`
├── dashboard/
│   ├── server.ts           Web dashboard (Bun.serve + WebSocket, localhost:7900)
│   └── index.html          Web dashboard UI
└── scripts/
    ├── version.ts          Version bump + release commit/tag
    ├── postinstall.ts      Configures MCP servers after install
    ├── preuninstall.ts     Removes MCP configuration on uninstall
    └── launch-calculator-team.ts  Example team launched without the orchestrator
```

## Process Lifecycle

### Delivery and Supervision

- The orchestrator's delivery loop runs every 3s (one tick at a time): unacked messages for each driver-managed slot are handed to its driver and acked only on confirmed hand-off; a released slot's driver is closed once it is idle (a Codex driver is judged by its notifications, not heartbeats, with a 10-minute hard cap).
- Antigravity sessions take a new prompt only between turns: the loop leaves their messages unclaimed while a turn runs, so the agent's next multiagents tool call picks them up.
- Agents launched as plain processes (Gemini) get messages in their next tool result; a watchdog respawns one whose actionable messages stay unclaimed for more than 2 minutes, and respawns disconnected slots with pending messages.
- Every component resolves the broker port through `MULTIAGENTS_PORT`, and the orchestrator forwards it to the agents it spawns.

### Graceful Shutdown
- **Broker** (`SIGINT`/`SIGTERM`): kills all registered peer processes, closes SQLite cleanly
- **Orchestrator** (`SIGINT`/`SIGTERM`): kills all managed agent processes and drivers
- **Adapters** (`SIGINT`/`SIGTERM`): unregister from broker, release file locks

### Recovery and Orphan Prevention
- Broker's `cleanStalePeers` runs every 30s: detaches slots whose process died (their messages are kept for the respawned agent, which inherits its predecessor's inbox), releases their file locks, kills orphan adapters without a session
- Crashed agents are respawned with a handoff prompt — a Claude agent resumes its session, a Codex agent its thread — one respawn per slot at a time, never for a released slot
- Flap detection stops auto-restart after 3 crashes in 5 minutes
- `.multiagents/.driver-mode` tells a Codex agent's internal MCP adapter that the orchestrator owns delivery, so it registers against the launcher's slot instead of creating a ghost one
- Session end/delete handlers stop drivers and processes before anything else can respawn them

## Releasing

```bash
bun run version:minor      # bumps package.json, commits "release: vX.Y.Z", tags vX.Y.Z
git push && git push --tags
```

The tag triggers `.github/workflows/publish.yml`, which runs the test suite and publishes
to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC):
no npm token is stored in the repository or in GitHub secrets, and npm attaches a
provenance attestation automatically. The trusted publisher on npmjs.com (package
Settings → Trusted publishing) must name the `zetbrush/multiagents` repository, the
`publish.yml` workflow and the `npm` environment; that GitHub environment only lets `v*`
tags and `main` deploy, so no other ref can obtain a token npm accepts. The same workflow can be run by hand
from the Actions tab with "dry run" enabled to pack the tarball without publishing.
Every pull request runs `.github/workflows/ci.yml` (`bun install --frozen-lockfile`,
`bunx tsc --noEmit`, `bun test`).

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MULTIAGENTS_PORT` | `7899` | Broker HTTP port; every component resolves it the same way and the orchestrator forwards it to spawned agents (an invalid value falls back to the default with a warning) |
| `MULTIAGENTS_DB` | `~/.multiagents/peers.db` | SQLite database path |
| `MULTIAGENTS_WEB_PORT` | `7900` | Web dashboard port |
| `MULTIAGENTS_NO_OPEN` | - | Web dashboard: do not open the browser |
| `MULTIAGENTS_NO_DASHBOARD` | - | Orchestrator: do not launch the terminal or web dashboards (tests, headless hosts) |
| `MULTIAGENTS_CLAUDE_MODEL` | - | Model for driver-launched Claude agents (e.g. `haiku`) |
| `MULTIAGENTS_CLAUDE_COMMAND` / `MULTIAGENTS_CODEX_COMMAND` | `claude` / `codex app-server` | Override the CLI binaries the drivers run |
| `MULTIAGENTS_ANTIGRAVITY_COMMAND` | `agy` | Override the Antigravity CLI binary; extra words are passed as leading arguments (e.g. `agy --sandbox`) |
| `MULTIAGENTS_ANTIGRAVITY_MODEL` | - | Model slug for driver-launched Antigravity agents (see `agy models`) |
| `MULTIAGENTS_CLEANUP_INTERVAL_MS` | `30000` | Broker stale-peer sweep interval |
| `MULTIAGENTS_LIVE_TESTS` | - | `1` runs the live tests against the real CLIs (costs API usage) |
| `MULTIAGENTS_SESSION` / `MULTIAGENTS_SLOT` / `MULTIAGENTS_ROLE` / `MULTIAGENTS_NAME` | - | Agent identity, set by the orchestrator (also passed as `--session/--slot/--role/--name` args) |
| `MULTIAGENTS_DRIVER_MODE` | - | Set by the orchestrator for driver-managed agents: the adapter stops polling and leaves delivery to the driver |

## Development

```bash
HOME=$(mktemp -d) bun test          # unit + integration suite (the launcher tests write ~/.codex/config.toml otherwise)
bunx tsc --noEmit
MULTIAGENTS_PORT=17910 bun tests/e2e-team.ts --timeout 600   # real Claude + Codex team on an isolated broker
MULTIAGENTS_LIVE_TESTS=1 bun test tests/live-orchestrator.test.ts   # real team through the orchestrator server
MULTIAGENTS_LIVE_TESTS=1 bun test tests/live-antigravity.test.ts    # real `agy` agent (needs a signed-in Antigravity CLI)
```

Driver tests run against protocol fakes in `tests/fakes/`; adapters are exercised as real processes over MCP stdio. The e2e and live tests launch real CLIs and rewrite the `multiagents-peer` section of `~/.codex/config.toml` for the run's broker port — back it up first (the live tests restore it themselves, keeping anything your own Codex wrote meanwhile). Every pull request runs the unit/integration suite in CI.

## Requirements

- [Bun](https://bun.sh/) runtime (v1.1+)
- At least one of: Claude Code, Codex CLI, or Antigravity CLI (`agy`); Gemini CLI is supported as a legacy agent
- `lsof` (optional; ships with macOS): used by `multiagents broker stop`, and by `multiagents update` to find a broker that does not report its pid

## License

MIT

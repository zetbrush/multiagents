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
       │ ClaudeDriver + MCP │ CodexDriver + MCP  │ MCP (stdio)
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

# Restart your Claude Code / Codex / Gemini sessions to load MCP tools

# Monitor
multiagents dashboard

# Later: upgrade to the latest release
multiagents update
```

### From Claude Code (Orchestrator)

`multiagents setup` registers two MCP servers in Claude Code (`~/.claude.json`): `multiagents` (the agent tools) and `multiagents-orch` (the orchestrator). Claude Desktop or any other MCP client can run the orchestrator too (`multiagents orchestrator`). Ask Claude to create a team:

> "Create a team of 3 agents: a Claude engineer, a Codex reviewer, and a Gemini designer.
> Build a calculator web app in TypeScript."

The orchestrator handles everything: spawning agents, assigning roles, creating slots, launching the dashboards, delivering messages between agents, and respawning agents that crash.

## Agent Support

| Agent | Delivery Mechanism | Latency | Config |
|-------|-------------------|---------|--------|
| Claude Code | ClaudeDriver (`claude -p --input-format stream-json`): messages written as user messages, read mid-turn. Interactive sessions additionally get channel notifications. | ≤3s | `~/.claude.json` (driver-launched agents get an inline `--mcp-config`) |
| Codex CLI | CodexDriver (`codex app-server`): `turn/steer` mid-turn, new turn when idle | <3s mid-turn, 3-9s between turns | `~/.codex/config.toml` |
| Gemini CLI | Prepended to MCP tool results + file inbox | next tool call | `~/.gemini/settings.json` |

All three also receive unread messages under `[PENDING MESSAGES]` at the top of their next MCP tool result; a message counts as delivered only once it was surfaced to the model (acked), so a dropped delivery is retried instead of lost.

### Codex Integration (CodexDriver)

Codex CLI uses the **app-server protocol** — a JSON-RPC stdio interface with threads, turns, and rich notifications. The orchestrator uses a **CodexDriver** that:

1. Spawns a persistent `codex app-server` process with JSON-RPC handshake
2. Creates a thread (`thread/start`) and drives turns (`turn/start`) for task execution
3. Injects messages mid-turn via `turn/steer` — no waiting for the current turn to finish
4. Interrupts a turn that has produced nothing for >60s with no command running (`turn/interrupt`) and asks the agent to signal done
5. Answers server-initiated requests unattended: command execution, file changes and permission requests are approved for the session; elicitations and user-input questions are declined; dynamic tool calls are refused
6. Reads token usage from `thread/tokenUsage/updated` (cumulative per thread) and, after a crash, resumes the same thread (`thread/resume`)

The orchestrator **drives Codex turns**: the delivery loop polls the broker every 3s. If Codex has an active turn, messages are steered in and acked at once. If idle, a new turn is started via `driver.reply()` and the messages are acked when it completes.

### Claude Integration (ClaudeDriver)

Headless `claude -p` sessions drop MCP channel notifications, so orchestrator-launched Claude agents run inside a **ClaudeDriver**: one long-lived `claude -p --input-format stream-json --output-format stream-json --replay-user-messages` process per agent, with the team MCP server passed inline (`--mcp-config`). Teammate messages are written to its stdin as user messages, which Claude reads at its next tool-call boundary — even in the middle of a long turn. A message is acked only when Claude echoes it back (`isReplay`); until then it stays in flight so no tick writes it again, and if the process dies first the message stays queued for the respawned agent, which resumes the same session (`--resume`). Input and cache tokens are metered per API call from `assistant` events; output tokens at the turn's `result`. A released agent is closed gracefully (stdin EOF) once it goes idle.

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

Adjustable from the TUI dashboard (+/- keys), the web dashboard's Stats tab, or the `adjust_guardrail` tool.

## Web Dashboard

```bash
multiagents web [session-id]
```

Web control center on `localhost:7900` with live WebSocket updates. Auto-opens in browser when a team is created via the orchestrator, and starts the broker itself when it is not running. Besides watching, you can run a team from the browser. The layout has three panes, and both side panes can be collapsed (`Ctrl+B` / `Ctrl+J`) and resized:

- **Left: sessions and an explorer** of the session's project directory (read-only, refreshed while agents work; locked files show a lock).
- **Center: the team chat.** Your messages sit on the right, the agents' on the left with avatar, role and message type (feedback, task complete, approval…). System notices are folded into small centered lines. Send to one agent or the whole team (Enter sends, Shift+Enter starts a new line, IME-safe). File names that agents mention become links once the file is found in the project.
- **Right: file preview** (Markdown, code with line numbers, images, PDF, Word `.docx`, CSV, HTML in a sandbox, audio/video). It follows the open file as agents edit it. The **Team** tab lists every agent with quick actions.

Light, dark, or follow the system: pick it from the theme button in the top bar. The language button switches between English and 中文 (Chinese is the default for a Chinese-language browser). Text the agents write stays as they wrote it.

**Making it yours.** Agents show their CLI's icon (Claude, Gemini; Codex gets a neutral terminal glyph because OpenAI's logo isn't redistributable). Click an avatar on an agent card or in its settings to use initials, a color or your own image instead. The **Appearance** button in the top bar sets a background image under the whole page, how strongly it shows, how see-through the panels are, and your own avatar. These choices are kept in the browser (localStorage), not on the server.

**Watching and approving each step.** The **Activity** tab is a live timeline of what every agent does: its thinking, the files it reads, each edit as a diff, every command with its output, and the cost of each turn. Claude and Codex report every step; Gemini reports its tool calls. Each agent has an approval mode (**Settings** on its card, or when you add it):

| Mode | Claude | Codex |
|---|---|---|
| Fully autonomous (default) | `bypassPermissions` | approval policy `never` |
| Auto review — the CLI's reviewer passes safe steps, risky ones come to you | `auto` | `on-request` |
| Auto-approve edits — commands and other tools ask | `acceptEdits` | `untrusted` |
| Ask me every step | `default` | `untrusted` |

A step that needs you shows up as a card with the exact command or diff: **Allow**, **Always allow** (this tool, or this shell program, for the rest of the agent's session), or **Deny** with a note the agent reads. Team-protocol tools (`check_messages`, `send_message`…) never ask. Gemini runs unattended (yolo), so it is always fully autonomous.

**Models, usage and limit locks.** The same Settings dialog switches an agent's model (an alias such as `opus`/`sonnet`, or a full name) and its effort. Claude switches live via `set_model`; Codex switches at its next turn; Gemini and Claude's effort switch at the agent's next start. The **Usage** tab shows tokens (input, output, cache reads) and Claude's reported cost per agent. There you can set limits per agent or for the whole session, in tokens or USD. An agent that reaches a limit is paused and its running turn is interrupted; raise the limit, then resume it.

**Plan limits (5-hour / weekly).** The **Usage** tab starts with each CLI's subscription quota, read the way the CLIs' own `/usage` screens read it and without starting a model turn; the fullest window of each also shows in the top bar. Claude: the claude.ai plan's 5-hour window and weekly windows (all models, Opus, Sonnet, per-model ones), via Claude Code's `get_usage` control request. Codex: the ChatGPT plan's 5-hour (primary) and weekly (secondary) windows, via `account/rateLimits/read`. Gemini has no 5-hour or weekly windows; with a Google login it shows the daily per-model quota (Code Assist `retrieveUserQuota`, using the token Gemini CLI stored, only while it is valid). API-key logins have no plan windows and say so. Answers are cached for two minutes; **Refresh** asks again.

**Other models (any OpenAI-compatible API).** Besides Claude, Codex and Gemini, an agent can run on DeepSeek, Qwen, Kimi, GLM, OpenRouter, a local Ollama, the OpenAI API, or anything else with an OpenAI-compatible chat API. Add the service under **More ▾ → API providers…** (or **Manage providers…** in Add Agent / New Team): a name, the base URL (the part before `/chat/completions`), the API key and a default model — presets fill in the URL of the well-known ones, **Fetch models** reads the model list, an optional price per million tokens turns on cost and cost limits, and extra request fields (JSON) pass provider options such as Qwen's built-in web search. Keys stay in `~/.multiagents/providers.json` (mode 0600) and never reach the page; `$NAME` reads a key from an environment variable. Then pick **Other (OpenAI-compatible API)** as the agent type. Such an agent works like the others: it talks to the team and to you with the same team tools, reads, edits and searches the project's files and runs commands (inside the project directory), and fetches web pages; its thinking streams into the chat, its steps fill the Activity timeline, approval modes, Q&A mode, interrupting, live model switches, token and cost accounting and limit locks all apply. It is driven in-process by the dashboard, so no CLI is installed; plan limits (5-hour / weekly) do not exist for API keys.

**Talking to agents while they work.** Pick one agent under **To** and ask it anything: agents reply to you with `send_message(to_id="human")` and the answer lands in the chat. Tick **Interrupt** to stop what that agent is doing first, so it answers you right away. **Q&A mode** (session toolbar) puts the whole team on hold: every running turn stops, agents are told to wait and only answer you, edits and commands are refused (reading files stays allowed, so they can check before answering), and teammates' messages wait. Ask one agent, then another; **End Q&A** resumes everyone where they stopped, with the messages that waited.

**Seeing an agent think.** While an agent works, the chat shows it under the last message: typing dots, what it is doing (thinking, writing a reply, running `$ bun test`…) and how long, and its thinking as it forms, token by token (Claude with `--include-partial-messages`, Codex reasoning summaries, Gemini replies). **Collapse** keeps it to a few lines.

The tabs in the center hold everything else:

- **Sessions** (sidebar): New Team, empty session, open, pause/resume, relaunch disconnected agents, export JSON, archive, end, delete (typed confirmation)
- **Agents**: message, pause/resume, change role, rename, send back for revision, release, remove; Add Agent; Release all approved / Release all
- **Plan**: add, edit, reassign, change status (pending / in progress / blocked / done), delete
- **Knowledge**: add, edit, delete entries by category
- **Locks**: locks with holder and expiry, force unlock, reserve a file for an agent, assign ownership zones
- **Activity**: the step-by-step timeline and pending approvals (see above)
- **Usage**: plan limits, tokens and cost per agent, limit locks, and guardrail steppers (changes logged as "Adjusted via web dashboard")

**Human gate.** A team started from the browser can wait for you once every agent is approved: instead of ending itself, the session shows *Waiting for human approval* with **Approve & Release** and **Send back for revision** (actionable feedback to a worker, which restarts the review loop). Toggle it per session with the `human gate` chip; MCP's `create_team` takes `human_gate: true`.

Teams and agents launched from the browser are supervised by the dashboard process (the same orchestrator runtime the MCP server runs), so keep `multiagents web` running while they work; stopping it stops them. Agents another orchestrator launched stay under that orchestrator. See [docs/web-control-center.md](docs/web-control-center.md) for the API.

On narrow screens the side panes become drawers. Keyboard shortcuts: `1-6` switch tabs.

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

`multiagents mcp-server --agent-type <claude|codex|gemini>` and `multiagents orchestrator` are the MCP server entry points the agent CLIs and the orchestrator host run; `multiagents setup` configures them.

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
│   ├── session-ops.ts      Session create/export shared by the CLI and the web dashboard
│   ├── summarize.ts        Git-based activity summary (no API calls)
│   └── utils.ts            Shared utilities
├── adapters/
│   ├── base-adapter.ts     Abstract MCP adapter (tools, registration, pending-message delivery + ack)
│   ├── protocol-text.ts    Team protocol text (short form for MCP instructions, full form for prompts)
│   ├── inbox.ts            File-based inbox for hosts without push (Codex, Gemini)
│   ├── claude-adapter.ts   Claude Code adapter (tool-result delivery + best-effort channel push)
│   ├── codex-adapter.ts    Codex adapter (tool-result delivery + file inbox)
│   ├── gemini-adapter.ts   Gemini adapter (tool-result delivery + file inbox)
│   └── role-practices.ts   Role-specific best practices injection
├── orchestrator/
│   ├── orchestrator-server.ts  Orchestrator MCP server (stdio host of runtime.ts)
│   ├── runtime.ts          Orchestrator runtime: tools, agent processes, supervision loops (shared with the web dashboard)
│   ├── activity.ts         Activity timeline from each CLI's stream; tool approvals through the broker
│   ├── live.ts             What each agent is doing right now (streamed thinking, typing indicator)
│   ├── plan-usage.ts       Subscription plan limits of the CLIs (5-hour / weekly / daily)
│   ├── claude-driver.ts    ClaudeDriver: long-lived `claude -p --input-format stream-json` session
│   ├── codex-driver.ts     CodexDriver: persistent codex app-server via JSON-RPC (steer/interrupt)
│   ├── api-driver.ts       ApiDriver: agents on any OpenAI-compatible API (team + local tools, Claude-style events)
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
│   ├── control.ts          Web control API (POST /api/*)
│   ├── files.ts            Read-only project files for the explorer and preview (GET /api/fs/*)
│   ├── index.html          Web dashboard layout
│   ├── app.js              Web dashboard UI logic
│   ├── i18n.js             Web dashboard translations (English / 中文)
│   └── styles.css          Web dashboard themes and layout
└── scripts/
    ├── version.ts          Version bump + release commit/tag
    ├── postinstall.ts      Configures MCP servers after install
    ├── preuninstall.ts     Removes MCP configuration on uninstall
    └── launch-calculator-team.ts  Example team launched without the orchestrator
```

## Process Lifecycle

### Delivery and Supervision

- The orchestrator's delivery loop runs every 3s (one tick at a time): unacked messages for each driver-managed slot are handed to its driver and acked only on confirmed hand-off; a released slot's driver is closed once it is idle (a Codex driver is judged by its notifications, not heartbeats, with a 10-minute hard cap).
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
```

Driver tests run against protocol fakes in `tests/fakes/`; adapters are exercised as real processes over MCP stdio. The e2e and live tests launch real CLIs and rewrite `~/.codex/config.toml` for the run's broker port — back it up first (the live tests restore it themselves). Every pull request runs the unit/integration suite in CI.

## Requirements

- [Bun](https://bun.sh/) runtime (v1.1+)
- At least one of: Claude Code, Codex CLI, or Gemini CLI
- `lsof` (optional; ships with macOS): used by `multiagents broker stop`, and by `multiagents update` to find a broker that does not report its pid

## License

MIT

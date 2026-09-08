# multiagents

[![npm version](https://img.shields.io/npm/v/multiagents.svg)](https://www.npmjs.com/package/multiagents)
[![npm downloads](https://img.shields.io/npm/dm/multiagents.svg)](https://www.npmjs.com/package/multiagents)

Multi-agent orchestration platform for **Claude Code**, **Codex CLI**, and **Antigravity CLI (AGY)**. Enables AI agents to discover each other, communicate in real-time, coordinate file edits, and work as a team on shared codebases.

Built on [MCP (Model Context Protocol)](https://modelcontextprotocol.io/).

## What It Does

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Claude Code  │     │  Codex CLI  │     │   AGY CLI   │
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
            │  Orchestrator   │  MCP server hosted by Claude, Codex,
            │  (team manager) │  Spawns agents, forwards messages,
            └────────────────┘  or AGY; monitors and auto-restarts
```

- **Peer discovery**: agents find each other via `list_peers`
- **Real-time messaging**: instant for Claude (channel push), <3s for Codex (mid-turn steer), 1-3s for AGY (piggyback)
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

# Restart your Claude Code / Codex / AGY sessions to load MCP tools

# Monitor
multiagents dashboard
```

### From the selected orchestrator

Ask Claude, Codex, or AGY to create a team:

> "Create a team of 3 agents: a Claude engineer, a Codex reviewer, and an AGY designer.
> Build a calculator web app in TypeScript."

The orchestrator handles everything: spawning agents, assigning roles, creating slots, launching the dashboard, and forwarding messages between agents.

The first `multiagents setup` selects the first installed CLI in this order: Claude, Codex, AGY. You can switch later:

```bash
multiagents orchestrator status
multiagents orchestrator set agy
```

Restart the agent CLIs after switching. For an existing session, close the old host, then call `list_sessions` and `resume_session` from the new host.

## Agent Support

| Agent | Delivery Mechanism | Latency | Config |
|-------|-------------------|---------|--------|
| Claude Code | Channel push notifications | Instant | `~/.claude/settings.json` |
| Codex CLI | CodexDriver (`codex app-server`) | <3s mid-turn, 3-9s between turns | `~/.codex/config.toml` |
| Antigravity CLI (`agy`) | Piggyback on MCP tool responses | 1-3s | `~/.gemini/config/mcp_config.json` |

### Codex Integration (CodexDriver)

Codex CLI uses the **app-server protocol** — a JSON-RPC stdio interface with threads, turns, and rich notifications. The orchestrator uses a **CodexDriver** that:

1. Spawns a persistent `codex app-server` process with JSON-RPC handshake
2. Creates a thread (`thread/start`) and drives turns (`turn/start`) for task execution
3. Injects messages mid-turn via `turn/steer` — no waiting for the current turn to finish
4. Interrupts turns with no activity for >5 minutes via `turn/interrupt` and requests a progress diagnosis
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

## Orchestrator Tools (Claude, Codex, or AGY)

| Tool | Description |
|------|-------------|
| `create_team` | Spawn a team with roles, file ownership, and a plan |
| `get_team_status` | Live status of all agents with completion tracking |
| `get_optimization_report` | Model decisions, token budgets, escalation, and cost report |
| `adjust_token_budget` | Set or extend session/agent token budgets |
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

## Token and Model Optimization

Token optimization is enabled by default. Tasks are classified locally (no LLM call) into
`economy`, `balanced`, or `expert`, then mapped to a provider model and reasoning effort.
Explicit per-agent choices always win over automatic classification.

```json
{
  "session_name": "Auth work",
  "project_dir": "/workspace/app",
  "optimization": {
    "session_token_budget": 200000,
    "default_agent_token_budget": 50000,
    "auto_escalate": true,
    "right_size": "recommend",
    "tiers": {
      "codex": {
        "economy": { "model": "gpt-5.6-luna", "reasoning_effort": "low" },
        "balanced": { "model": "gpt-5.6-terra", "reasoning_effort": "medium" },
        "expert": { "model": "gpt-5.6-sol", "reasoning_effort": "high" }
      }
    },
    "pricing": {
      "your-model": { "input": 1.0, "output": 4.0, "cached_input": 0.2 }
    }
  },
  "agents": [{
    "agent_type": "codex",
    "name": "Engineer",
    "role": "Software Engineer",
    "role_description": "Implement and verify the requested change.",
    "initial_task": "Implement the endpoint and its tests.",
    "model_policy": { "token_budget": 40000 }
  }]
}
```

The optimizer also:

- recommends a smaller team for bounded work (`right_size: "enforce"` applies it);
- promotes an incomplete/crashed task one tier at a time when auto-escalation is enabled;
- stops agents or sessions at their token budget so they cannot silently restart;
- preserves routing metadata across summaries, crashes, and resumptions;
- reports model choice, decision reasons, tokens, cache reads, escalations, and estimated cost.

Use `get_optimization_report` for the report and `adjust_token_budget` to set or extend a
session/agent budget. Cost is only estimated when pricing is explicitly configured, avoiding
stale hard-coded prices.

Default model mappings can be replaced without code changes through the `tiers` configuration
or environment variables such as `MULTIAGENTS_CODEX_ECONOMY_MODEL`,
`MULTIAGENTS_CLAUDE_BALANCED_MODEL`, and `MULTIAGENTS_AGY_EXPERT_MODEL`.

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
│   ├── agy-adapter.ts      AGY adapter (piggyback + file inbox delivery)
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
- At least one of: Claude Code, Codex CLI, or Antigravity CLI (`agy`)

## License

MIT

## Autonomous plan execution (Codex → Gemini)

Use `execution_mode: "plan_execution"` when you want to discuss and approve a
plan with Codex, then let one Gemini worker implement it. Codex handles decisions
and final review. The existing team mode remains the default.

From a Codex session with the orchestrator MCP configured, call `create_team`
with a payload like this (replace the project path and select a model actually
available in your Antigravity account):

```json
{
  "project_dir": "/absolute/path/to/project",
  "session_name": "Document setup",
  "execution_mode": "plan_execution",
  "agents": [{
    "agent_type": "agy",
    "name": "Gemini",
    "role": "Software Engineer",
    "role_description": "Implement the approved plan autonomously. Escalate decisions that change its scope.",
    "initial_task": "Document the project's actual setup commands in docs/setup.md.",
    "model_policy": { "model": "gemini-3.8-flash" }
  }],
  "plan": [{
    "key": "setup_doc",
    "label": "Write the setup guide",
    "files": ["docs/setup.md"],
    "depends_on": [],
    "acceptance": ["Commands match the project's existing scripts", "Guide explains installation and how to run tests"],
    "checks": [{
      "argv": ["bun", "-e", "const s = await Bun.file('docs/setup.md').text(); if (s.trim().length < 100) process.exit(1)"],
      "cwd": ".",
      "timeout_ms": 10000
    }]
  }]
}
```

The example check only verifies that a substantive document exists. Codex still
reviews its accuracy. For code changes, specify the project's relevant test,
type-check and build commands in `checks`.

- Each step needs a unique `key`, `label`, `files`, `depends_on`, `acceptance` and
  1–10 executable `checks`. Dependencies must name earlier steps. Execution is
  sequential even when two steps have no dependency.
- Checks use argument arrays, without implicit shell expansion. Their `cwd` is
  relative to the project and must resolve inside it. Default timeout is 60 seconds;
  maximum is 300 seconds per check. Checks run with the broker's environment and
  permissions, so include only commands you intend to run in the approved plan.
- The plan is stored before the worker starts. `get_plan` returns the step IDs,
  criteria, decisions and recorded check results. The worker calls `update_plan`
  with `in_progress`, implements the step, then calls `verify_plan_step` with its
  `item_id` and a concise implementation/acceptance `summary`.
- The broker runs checks and records exit codes. Only successful checks mark the
  step `done`; an agent cannot bypass them through `update_plan(status: "done")`.
  Logs stay in `.multiagents/verification/<item-id>/`, capped at 1 MiB per check.
  Consider ignoring `.multiagents/` in your target repository.
- Two failed verification attempts pause the worker. For other persistent
  problems, the worker reports `update_plan` with `status: "blocked"` and a
  `reason` explaining the attempts and decision needed. Arbitrary reasoning
  attempts are self-reported; executable verification attempts are counted by
  the program.
- Optional `decision_required` text gates an individual step. The coordinator
  calls `resolve_plan_blocker({session_id, item_id, decision})` to allow progress.
  The resolution is persisted and a continuation message is sent to the worker.
- The coordinator uses `get_execution_plan({session_id})` for step IDs, blockers,
  decisions and verification evidence, and `get_team_status` for a compact summary.
- After all steps pass, the worker calls `signal_done`. Codex reviews the diff,
  qualitative criteria and check evidence, then calls
  `approve_execution({session_id, message})`. Missing reviewers and silence never
  imply approval. Use `release_agent` after approval, or let normal session
  completion release the worker.
- To request corrections at final review, call `resolve_plan_blocker` with
  `reopen: true` and the feedback in `decision`. That step and all later steps
  become pending and must be verified again; existing files are preserved.
- The explicit model is retained through retries and resumes. Automatic model
  escalation/decay and team expansion are disabled in this mode. Technical
  process restarts retain the existing bounded retry controls.
- Pausing or archiving a session cancels its active checks. Cancellation does not
  count as a failed implementation attempt. Interrupted verification must run again. On POSIX, verification subprocess
  groups are terminated when the broker dies, including abrupt termination.
  Windows descendant cleanup does not provide the same process-group guarantee.
  Incomplete execution slots are retained for resume. Use `end_session` or
  `delete_session` to cancel the session rather than releasing unfinished work.

This is a cooperative local workflow, not an authorization boundary against an
agent with arbitrary shell access. `files` describes the intended scope; it is
not an operating-system sandbox. The coordinator's final diff review remains
necessary. No additional dashboard is launched automatically in execution mode;
use `multiagents dashboard <session-id>` or `multiagents web <session-id>`.

Antigravity must be installed and authenticated before starting. Its official
[headless mode documentation](https://www.antigravity.google/docs/cli/headless)
describes cached authentication, model selection and streaming results. Model
availability and subscription quotas depend on your account; this package does
not convert a Google subscription into API credits. Reported token usage is
separate from subscription quotas. Unknown usage appears as `null` in optimization
reports and `unknown` in their text output; token budgets cannot be fully enforced
without provider usage. Antigravity terminal usage is recorded when supplied.

Development verification: `bun test` covers real broker persistence, subprocess
checks, abrupt shutdown and an end-to-end MCP flow with a fake `agy` executable.
That test does not establish live Google authentication or model availability.

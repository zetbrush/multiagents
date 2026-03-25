# multiagents

Multi-agent orchestration platform for **Claude Code**, **Codex CLI**, and **Gemini CLI**. Enables AI agents to discover each other, communicate in real-time, coordinate file edits, and work as a team on shared codebases.

Built on [MCP (Model Context Protocol)](https://modelcontextprotocol.io/).

## What It Does

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Claude Code  │     │  Codex CLI  │     │ Gemini CLI  │
│ (Architect)  │     │  (Builder)  │     │ (Reviewer)  │
└──────┬───────┘     └──────┬──────┘     └──────┬──────┘
       │   MCP (stdio)      │                    │
       └────────────┬───────┴────────────────────┘
                    │
            ┌───────▼────────┐
            │  Broker Daemon  │  SQLite + HTTP on localhost
            │  (one per machine)
            └────────────────┘
```

- Agents discover each other via `list_peers`
- Send messages with `send_message` (instant for Claude, 1-3s for Codex/Gemini)
- Assign roles at runtime: `assign_role`, `rename_peer`
- Coordinate file edits with locks and ownership zones
- Persistent sessions that survive agent restarts
- TUI dashboard for real-time monitoring
- Orchestration from Claude Desktop (spawn teams, monitor progress, control sessions)

## Quick Start

```bash
# Install
bun install

# Setup (detects installed CLIs, configures MCP, starts broker)
bun cli.ts setup

# Start agents in separate terminals
claude    # auto-connects via MCP
codex     # auto-connects via MCP
gemini    # auto-connects via MCP

# Monitor
bun cli.ts dashboard
```

## Agent Support

| Agent | Push Delivery | Effective Latency | Config Location |
|-------|--------------|-------------------|-----------------|
| Claude Code | `notifications/claude/channel` | Instant | `~/.claude/settings.json` |
| Codex CLI | Piggyback on tool responses | 1-3 seconds | `~/.codex/config.toml` |
| Gemini CLI | Piggyback on tool responses | 1-3 seconds | `~/.gemini/settings.json` |

## MCP Tools (Available to All Agents)

| Tool | Description |
|------|-------------|
| `list_peers` | Discover agents (filter by scope, type) |
| `send_message` | Send text message to a peer |
| `check_messages` | Manually poll for messages |
| `set_summary` | Update your status/summary |
| `assign_role` | Assign/change a peer's role |
| `rename_peer` | Give a peer a friendly name |
| `acquire_file` | Request exclusive edit access to a file |
| `release_file` | Release your lock on a file |
| `view_file_locks` | See active locks and ownership zones |
| `get_history` | Query session message history |

## Orchestrator Tools (Claude Desktop)

| Tool | Description |
|------|-------------|
| `create_team` | Spawn a team of agents with roles |
| `get_team_status` | Live status of all agents |
| `broadcast_to_team` | Message all agents at once |
| `direct_agent` | Message a specific agent by name/role |
| `add_agent` | Spawn an additional agent mid-session |
| `remove_agent` | Gracefully stop an agent |
| `control_session` | Pause/resume all or individual agents |
| `adjust_guardrail` | View or change session limits |
| `get_session_log` | Full message history |
| `end_session` | Stop all agents, archive session |

## Sessions

Sessions persist across agent restarts:

```bash
# Create a session
bun cli.ts session create "Auth Implementation"

# List sessions
bun cli.ts session list

# Resume a previous session (reconnects agents to their slots)
bun cli.ts session resume auth-implementation

# Export transcript
bun cli.ts session export auth-implementation
```

## File Coordination

Two mechanisms prevent agents from stepping on each other:

**Ownership Zones** (static, zero overhead):
```
Architect assigns: Builder-1 owns src/auth/*, Builder-2 owns src/email/*
```

**File Locks** (dynamic, for shared files):
```
Builder-1: acquire_file("package.json", "adding dependency")
-> Lock acquired, auto-expires in 5 minutes
```

## Guardrails

Dynamic limits that protect against runaway sessions:

| Guardrail | Default | Action |
|-----------|---------|--------|
| Session Duration | 30 min | Pause |
| Messages Per Agent | 200 | Pause |
| Max Agents | 6 | Stop |
| Restarts Per Agent | 3 | Stop |
| Files Changed | 50 | Warn |
| Agent Idle Timeout | 3 min | Warn |

All adjustable at runtime. When triggered, agents pause and the user can increase the limit to resume.

## CLI Commands

```
multiagents setup                     Interactive setup wizard
multiagents dashboard                 Live TUI dashboard
multiagents session create <name>     Create session
multiagents session list              List all sessions
multiagents session resume [id]       Resume a session
multiagents session pause [id]        Pause all agents
multiagents session archive <id>      Archive session
multiagents session export <id>       Export transcript
multiagents send <target> <msg>       Send message
multiagents peers                     List active peers
multiagents status                    Broker health + peers
multiagents broker start|stop|status  Manage broker
```

## Architecture

```
multiagents/
├── shared/           Type definitions, broker client, constants, utils
├── adapters/         Agent-specific MCP servers (Claude, Codex, Gemini)
├── orchestrator/     Claude Desktop orchestration (team management)
├── cli/              CLI tools (setup, dashboard, session management)
├── broker.ts         SQLite broker daemon (sessions, slots, locks, guardrails)
├── server.ts         Thin entry point (dispatches to adapter by --agent-type)
└── cli.ts            CLI entry point
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MULTIAGENTS_PORT` | 7899 | Broker HTTP port |
| `MULTIAGENTS_DB` | `~/.multiagents/peers.db` | SQLite database path |
| `ANTHROPIC_API_KEY` | - | Auto-summary via Claude |
| `OPENAI_API_KEY` | - | Auto-summary via OpenAI (fallback) |
| `MULTIAGENTS_SESSION` | - | Session ID (set by orchestrator) |
| `MULTIAGENTS_ROLE` | - | Agent role (set by orchestrator) |
| `MULTIAGENTS_NAME` | - | Agent display name (set by orchestrator) |

## Requirements

- [Bun](https://bun.sh/) runtime
- At least one of: Claude Code, Codex CLI, or Gemini CLI

## License

MIT

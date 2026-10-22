---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# multiagents

Peer discovery and messaging MCP channel for Claude Code instances.

## Architecture

- `broker.ts` — Singleton HTTP daemon on localhost:7899 + SQLite. Auto-launched by the MCP server. A message is `delivered` once a delivery mechanism picked it up and `acked` once it reached the model. A plain poll consumes what it returns; clients that confirm delivery themselves poll with `retain: true` and call `/ack-messages`, so a failed delivery is retried. Messages match by peer id or slot id, so an agent respawned into a slot inherits its predecessor's inbox. `/peek-undelivered` reports unacked and unclaimed counts; `/slots/update` takes `context_patch` to merge into the slot snapshot without clobbering other writers' keys (driver session ids).
- `server.ts` — MCP stdio server, one per agent CLI instance (`adapters/*`). Prepends unread messages to every tool result (`[PENDING MESSAGES]`) and acks them; Claude also gets a best-effort channel notification.
- `adapters/protocol-text.ts` — Team protocol: short form for MCP `instructions` (Claude Code caps them at 4096 chars, Codex reads 512), full form for orchestrator prompts.
- `orchestrator/claude-driver.ts` — Long-lived `claude -p --input-format stream-json` session; teammate messages are written to stdin and read mid-turn. `system/init` only arrives after the first message; closing stdin ends the session.
- `orchestrator/codex-driver.ts` — `codex app-server` JSON-RPC client (shapes verified against the 0.156.1 schema).
- `orchestrator/api-driver.ts` — Agent type `api` ("Other"): any OpenAI-compatible chat API, configured in `shared/providers.ts` (`~/.multiagents/providers.json`, 0600, keys never sent to the page; slots keep `provider_id`). In-process loop: spawns the team-tools MCP server in driver mode and talks MCP to it, adds local tools with Claude's names (Read/Write/Edit/LS/Glob/Grep/Bash/WebFetch, confined to the project), streams completions (`reasoning_content` → thinking) and emits Claude stream-json events, so it is a `ClaudeSession` and runs on every Claude path (`kind: "claude"` in the driver registry: delivery, approvals by permission mode, activity, live view, token and cost accounting, Q&A, interrupts). Tests use a scripted fake server (`tests/api-agent.test.ts`).
- `orchestrator/delivery.ts` — Hands unacked messages to a driver (`retain` poll) and acks them on confirmed hand-off.
- `orchestrator/runtime.ts` — The orchestrator itself: launched processes and drivers, background supervision loops, and the tool implementations (`ORCHESTRATOR_TOOLS`, `callOrchestratorTool`). Hosted by `orchestrator-server.ts` (MCP stdio) and by `dashboard/server.ts`; each host supervises only the agents it launched.
- `dashboard/control.ts` — Web control API (`POST /api/<action>`). Every mutation names its `session_id` and checks the slot belongs to it; lifecycle actions call `callOrchestratorTool`, record edits go to the broker. Human actions use sender id `human`. A session with `config.human_gate` is not auto-ended while agents sit in `approved`.
- `dashboard/files.ts` — Read-only `GET /api/fs/{list,raw,resolve,check,docx}` over the session's `project_dir`. Every path goes through `resolveInRoot` (realpath, so symlinks cannot escape); HTML/SVG are served with a sandbox CSP. `.docx` is rendered server-side (own zip reader, no dependency). UI: `dashboard/index.html` + `i18n.js` + `app.js` + `styles.css`, plain JS, themes via `html[data-theme]`. `i18n.js` loads first: `tr(english, vars)` looks the English text up in `ZH` (then `RULES_ZH` for server-generated text); static HTML is translated in place at boot. A new UI string needs a `ZH` entry (`tests/web-i18n.test.ts` checks). Avatars and the background are per-browser localStorage (`ma-avatars`, `ma-appearance`).
- `orchestrator/activity.ts` — Turns Claude stream-json, Codex app-server notifications and Gemini stream-json into one activity timeline (broker `/activity/*`), and waits on tool approvals stored in the broker (`/approvals/*`, polled, so any host's dashboard can answer). Per-slot settings live in the slot snapshot (`model`, `effort`, `approval_mode`, `token_limit`); `runtime.ts` reconciles running drivers with them each delivery tick (Claude: `set_model` / `set_permission_mode` control requests; Codex: `driver.settings` for the next turn), interrupts the turn of a paused slot, and enforces session `config.limits` (`limitVerdict`). Claude runs with `--permission-prompt-tool stdio`; its `can_use_tool` control requests go to `onPermissionRequest` (queued until a handler is set, denied after 30s without one).
- `orchestrator/live.ts` — `LiveTracker`: the block an agent is writing right now (Claude `stream_event` deltas from `--include-partial-messages`, Codex `item/*/delta`, Gemini message deltas) plus its phase, published to the broker's in-memory `/activity/live/*` (busy entries not refreshed for 60s expire). The chat polls `/api/live` for the typing indicator.
- `orchestrator/plan-usage.ts` — Subscription windows without a model turn: Claude `get_usage` control request on a throwaway `claude -p` (no MCP, hooks off, cwd tmp), Codex `account/rateLimits/read` on a throwaway app-server, Gemini Code Assist `retrieveUserQuota` with `~/.gemini/oauth_creds.json` (never refreshed here). Cached 2 min; `GET /api/plan-usage`.
- Talking to agents: `human` is a valid message target (agents see `HUMAN_SENDER_LABEL` with the id to reply to). `messages/send` with `interrupt` sets the slot's `interrupt_at`; the host running the driver stops its turn. Session `config.qa_mode` (Q&A mode, `session/qa`): the broker hands agents only `human` / orchestrator messages (`qaFilter`), `runtime.ts` interrupts running turns, runs drivers in ask mode and only lets read-only tools through, and skips nudges, respawns and auto-end.
- Broker updates: the broker is a daemon that keeps old code across updates. `/health` lists `BROKER_FEATURES` (shared/constants.ts — add one with each endpoint or behavior the dashboard needs); the dashboard shows a restart banner when some are missing and restarts an idle one at startup. `restartBroker` leaves agents running: SIGUSR2 (current builds exit without the SIGTERM handler that kills every registered peer) or SIGKILL for older builds (WAL keeps committed data).
- `orchestrator/supervision.ts` — Driver registry (one driver per slot), non-overlapping loop ticks, release, watchdog and dead-slot verdicts; pure enough to unit-test. The background cleanup deletes only orphan slots (`deadSlotVerdict`: connected once, never worked or messaged, session not on hold); finished agents stay listed as offline until a person removes them.
- `orchestrator/monitor.ts` — Slot summaries and token accounting. Claude's `result.usage` is per turn (added as is); Codex's `thread/tokenUsage/updated.total` is cumulative (diffed).
- `shared/types.ts` — Shared TypeScript types for broker API.
- `shared/summarize.ts` — Git-based summary of what an agent is working on (no API calls).
- `cli.ts` — CLI utility for inspecting broker state.

## Running

```bash
# Start Claude Code with the channel:
claude --dangerously-load-development-channels server:multiagents

# Or just add to .mcp.json and use as regular MCP (no channel push, but tools work):
# { "multiagents": { "command": "bun", "args": ["./server.ts"] } }
# Channel push only renders in interactive sessions started with the flag; headless
# `-p` sessions drop it. Messages still arrive inside the next tool result.

# Env knobs: MULTIAGENTS_PORT (broker port; every component resolves it through
# shared/broker-url.ts and the orchestrator forwards it to spawned agents — an
# invalid value falls back to the default with a warning),
# MULTIAGENTS_CLAUDE_MODEL (model for driver-launched Claude agents),
# MULTIAGENTS_CLAUDE_COMMAND / MULTIAGENTS_CODEX_COMMAND (override the CLI binaries),
# MULTIAGENTS_CLEANUP_INTERVAL_MS (broker stale-peer sweep), MULTIAGENTS_NO_DASHBOARD=1
# (orchestrator opens no terminal/web dashboards — tests, headless hosts),
# MULTIAGENTS_LIVE_TESTS=1 (run the live tests against the real CLIs, costs API usage).

# CLI:
bun cli.ts status
bun cli.ts peers
bun cli.ts send <peer-id> <message>
bun cli.ts kill-broker
bun cli.ts update --check   # installed vs latest; `update` upgrades with the owning package manager
```

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Releasing

`bun run version:<patch|minor|major>` bumps package.json and creates the `vX.Y.Z` commit and tag;
`git push && git push --tags` makes `.github/workflows/publish.yml` test and publish to npm via
trusted publishing (OIDC — no token in the repo or secrets; the publisher on npmjs.com names
`publish.yml` and the `npm` environment). Pull requests run `.github/workflows/ci.yml`.

## Testing

Use `bun test` to run tests. `tests/launcher.test.ts` writes the global `~/.codex/config.toml` /
`~/.gemini/settings.json` (it saves and restores them); run the suite with a throwaway
`HOME=$(mktemp -d) bun test` to keep your real configs untouched. Driver tests run against
`tests/fakes/fake-claude.ts` and `tests/fakes/fake-codex-app-server.ts`.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

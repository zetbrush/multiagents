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
- `orchestrator/codex-driver.ts` — `codex app-server` JSON-RPC client (shapes verified against the 0.156.1 schema, re-checked on 0.170.0). The launcher rewrites only the `multiagents-peer` table of `~/.codex/config.toml`; a standalone `multiagents` server there stays and is switched off per thread (`config: {"mcp_servers.multiagents.enabled": false}` on `thread/start`/`thread/resume`, sent only when that table exists — Codex rejects the override for an unknown server).
- `orchestrator/antigravity-driver.ts` — Long-lived `agy --input-format stream-json --output-format stream-json` session (event shapes from https://antigravity.google/docs/cli/headless, verified on agy 1.5.13). `init` is printed at startup; one turn per prompt: a prompt written mid-turn waits, so delivery only writes when the driver is idle and the adapter keeps surfacing unclaimed messages in tool results. No per-launch MCP flag: the launcher registers `multiagents-peer` in `<project>/.agents/mcp_config.json` (a same-named entry in the global `~/.gemini/config/mcp_config.json` wins, so that one is repointed when present). agy starts MCP servers as direct children with its cwd and environment; the adapter takes its slot from the env, falling back to `.multiagents/slots/<agy pid>.json`.
- `orchestrator/delivery.ts` — Hands unacked messages to a driver (`retain` poll) and acks them on confirmed hand-off.
- `orchestrator/supervision.ts` — Driver registry (one driver per slot), non-overlapping loop ticks, release and watchdog verdicts; pure enough to unit-test.
- `orchestrator/monitor.ts` — Slot summaries and token accounting. Claude's `result.usage` is per turn (added as is); Codex's `thread/tokenUsage/updated.total` and Antigravity's `result.usage` are cumulative (diffed; a resumed Antigravity conversation's first turn is counted from its steps).
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
# MULTIAGENTS_CLAUDE_COMMAND / MULTIAGENTS_CODEX_COMMAND / MULTIAGENTS_ANTIGRAVITY_COMMAND
# (override the CLI binaries), MULTIAGENTS_ANTIGRAVITY_MODEL (model slug for Antigravity agents),
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
`tests/fakes/fake-claude.ts`, `tests/fakes/fake-codex-app-server.ts` and `tests/fakes/fake-agy.ts`;
`tests/antigravity-team.test.ts` runs the real orchestrator, broker and adapter against the fake `agy`.

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

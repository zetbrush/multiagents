# Web Control Center

`multiagents web` (localhost:7900) runs a team from the browser. This page maps each
browser action to the code that does the work, so the CLI, the orchestrator MCP tools
and the web share one implementation.

## Architecture

```
Claude Desktop ──MCP stdio──> orchestrator-server.ts ─┐
                                                      ├─> orchestrator/runtime.ts ──> broker (7899)
Browser ──POST /api/*──> dashboard/server.ts          │   (launch, supervise, release,
         <──WebSocket──  └─ dashboard/control.ts ─────┘    end, resume...)
                              └─ BrokerClient ─────────────> broker (messages, plan, knowledge, locks)
CLI ─────────────────────> shared/session-ops.ts, BrokerClient ──> broker
```

Agent processes live in the memory of the process that launched them: the drivers, the
process map, the delivery and respawn loops. So lifecycle actions cannot be done by the
web with broker calls alone. `orchestrator/runtime.ts` holds that state and the tool
implementations; both the MCP server and the web dashboard host it. Agents started from the
browser are supervised by the dashboard process, and agents an MCP orchestrator started stay
with it. Release and remove are recorded in the broker, so the owning process stops its
agent either way.

## Action map

All mutations are `POST /api/<action>` with a JSON body that names `session_id`
(`team/create` and `session/create` create one). The answer is `{ ok: true, result }`, or
`{ ok: false, error }` with a 4xx/5xx status. The server checks that every `slot_id`
belongs to the named session. Human actions are sent as `human`.

| Feature | API action | Implementation | CLI / MCP equivalent |
|---|---|---|---|
| Message an agent | `messages/send` `{slot_id, text}` | `BrokerClient.sendMessage` (by slot) | `multiagents send`, `direct_agent` |
| Broadcast | `messages/send` `{slot_id: "all"}` | `broadcastToTeam` | `broadcast_to_team` |
| Pause / resume session | `session/control` `{action}` | `controlSession(pause_all / resume_all)` | `session pause`, `control_session` |
| Pause / resume agent | `agents/control` `{slot_id, action}` | `controlSession(pause_agent / resume_agent)` | `control_session` |
| Release agent | `agents/release` | runtime `release_agent` | `release_agent` |
| Release all (approved) | `agents/release-all` `{approved_only}` | runtime `release_all` | `release_all` |
| Remove agent | `agents/remove` | runtime `remove_agent` | `remove_agent` |
| Add agent | `agents/add` | runtime `add_agent` | `add_agent` |
| Rename | `agents/rename` | `BrokerClient.renamePeer` | — |
| Change role | `agents/role` | `BrokerClient.setRole` | — |
| Send back for revision | `agents/feedback` | `BrokerClient.submitFeedback` (actionable) | — |
| New team | `team/create` | runtime `create_team` (+ `human_gate`) | `create_team` |
| Create session | `session/create` | `createSessionRecord` | `session create` |
| Relaunch agents | `session/relaunch` | runtime `resume_session` | `resume_session` |
| Archive | `session/archive` | `BrokerClient.updateSession` | `session archive` |
| End session | `session/end` | runtime `end_session` | `end_session` |
| Delete session | `session/delete` `{confirm: <id>}` | runtime `delete_session` | `session delete`, `delete_session` |
| Export | `GET /api/session/export?session_id=` | `exportSessionData` (JSON) | `session export` (Markdown) |
| Human gate | `session/human-gate` `{enabled}` | `updateSession({config_patch})` | `create_team({human_gate})` |
| Plan add / edit / delete | `plan/add`, `plan/edit`, `plan/delete` | broker `/plan/add-item`, `/plan/edit-item`, `/plan/delete-item` | `update_plan` (agents) |
| Knowledge put / delete | `knowledge/put`, `knowledge/delete` | `putKnowledge`, `deleteKnowledge` | `store_knowledge`, `remove_knowledge` |
| Reserve a file | `files/acquire` `{slot_id, file_path, minutes}` | `acquireFile` on the agent's behalf | `acquire_file` (agents) |
| Force unlock | `files/release` `{lock_id}` | `releaseFile` as the holder | — |
| Ownership zone | `files/ownership` `{slot_id, patterns}` | `assignOwnership` | `assign_ownership` |
| Guardrail | `guardrail` `{guardrail_id, value, reason}` | `controlSession(set_budget)` (resumes a guardrail pause) | `adjust_guardrail` |
| Broker status | `GET /api/broker` | `BrokerClient` | `multiagents status` |
| CLI availability | `GET /api/agents/available` | `detectAgent` (cached 5 min) | — |

## Activity, approvals, models and limits

| Feature | API | Implementation |
|---|---|---|
| Activity timeline | `GET /api/activity?session_id=&slot_id=&after_id=&limit=` | broker `/activity/list`, written by `ActivityRecorder` in the host that runs the agent |
| Decide a pending step | `approvals/decide` `{approval_id, decision: allow\|deny, always, note}` | broker `/approvals/decide`; the waiting host polls `/approvals/get` |
| Model / effort / approval mode / token limit | `agents/settings` `{slot_id, model, effort, approval_mode, token_limit}` | slot snapshot via `context_patch`; `reconcileDriver` applies it to the running driver |
| Limit locks | `session/limits` `{limits: {agent_tokens, agent_cost_usd, session_tokens, session_cost_usd}}` | session `config.limits`; `enforceUsageLimits` pauses and interrupts |

Pending approvals are pushed with the dashboard state (`state.approvals`). A decision can be
made only once; a request whose agent exits is cancelled.

## Project files (explorer and preview)

Read-only, scoped to the session's `project_dir`, all `GET` with `session_id`:

| Endpoint | Returns |
|---|---|
| `/api/fs/list?path=` | Directory entries (folders first, `.git` hidden) |
| `/api/fs/raw?path=[&download=1]` | The file, inline or as a download. HTML, SVG and XML get `Content-Security-Policy: sandbox` |
| `/api/fs/resolve?path=` | The project path for a reference (`parser.ts` → `src/lib/parser.ts`), with size and mtime |
| `/api/fs/check?ref=…&ref=…` | A batch of references from chat messages → project path or `null` |
| `/api/fs/docx?path=` | A `.docx` rendered to HTML (headings, emphasis, lists, tables) |

Paths are resolved with `realpath`, so neither `..` nor a symlink can reach outside the
project. A file name only becomes a link in the chat once `check` has found it.

## Lifecycle and the human gate

`idle → working → done_pending_review → addressing_feedback → approved → released`

`approved` is not `released`. Without a gate, the orchestrator ends a session on its own
30 s after every agent is approved or released. With `config.human_gate` set (on by default
for teams started from the browser) it leaves approved agents waiting. The dashboard then
shows **Waiting for human approval**:

- **Approve & Release** releases every approved agent (`release_all` with `approved_only`).
- **Send back for revision** sends actionable feedback from `human` to the agent you pick. The
  agent moves to `addressing_feedback` and the review loop runs again.

The workflow checkboxes in New Team become rules in every agent's initial prompt (reviewer
approval required, actionable feedback, wait for the human). The human gate itself is enforced
by the orchestrator.

## Safety

- Launches are serialized per session (per project directory for `team/create`), so a
  double click cannot spawn agents twice. An agent name already used in the session is refused.
- Destructive actions ask for confirmation in the UI. Delete also needs the session id
  typed, and the server checks it (`confirm`).
- Actions capture the session id when they start, and dialogs show it. Switching sessions
  mid-way cannot redirect an action.
- State pushes are sequenced: a slow poll that started before a mutation cannot overwrite
  the state fetched after it.
- Agent cards show the slot id (stable seat in the session) and the peer id (the running
  process's registration) separately.

## Not covered yet

- Starting or stopping the broker from the browser. The dashboard starts it if it is down;
  stop it with `multiagents kill-broker`.
- Removing an ownership zone (the broker has no endpoint for it).
- Moving agents between hosts. A dashboard that is stopped stops the agents it launched;
  **Relaunch disconnected agents** brings them back under the next host.

// ============================================================================
// multiagents — Session operations shared by the CLI and the web dashboard
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { BrokerClient, type PlanState } from "./broker-client.ts";
import { SESSION_DIR, SESSION_FILE } from "./constants.ts";
import { getGitRoot, uniqueSessionId } from "./utils.ts";
import type { Session, SessionFile } from "./types.ts";

/**
 * Create a session record for a project directory and write its local
 * `.multiagents/session.json` (what `multiagents session create` does).
 * The id is the slugified name, suffixed when a session already has it.
 */
export async function createSessionRecord(
  client: BrokerClient,
  name: string,
  projectDir: string,
  brokerPort: number,
): Promise<Session> {
  const gitRoot = await getGitRoot(projectDir);
  const existing = (await client.listSessions().catch(() => [] as Session[])).map((s) => s.id);
  const id = uniqueSessionId(name, existing);

  const session = await client.createSession({ id, name, project_dir: projectDir, git_root: gitRoot });

  const sessionDir = path.join(projectDir, SESSION_DIR);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile: SessionFile = {
    session_id: session.id,
    created_at: new Date().toISOString(),
    broker_port: brokerPort,
  };
  await Bun.write(path.join(projectDir, SESSION_FILE), JSON.stringify(sessionFile, null, 2));
  return session;
}

/** Everything the broker knows about a session, as one JSON document. */
export async function exportSessionData(client: BrokerClient, sessionId: string) {
  const [session, slots, messages, plan, knowledge, guardrails] = await Promise.all([
    client.getSession(sessionId),
    client.listSlots(sessionId),
    client.getMessageLog(sessionId, { limit: 10000 }),
    client.getPlan(sessionId).catch((): PlanState | null => null),
    client.listKnowledge(sessionId).catch(() => []),
    client.getGuardrails(sessionId).catch(() => []),
  ]);
  return {
    exported_at: new Date().toISOString(),
    session,
    agents: slots,
    messages, // oldest first, as the broker returns them
    plan,
    knowledge,
    guardrails,
  };
}

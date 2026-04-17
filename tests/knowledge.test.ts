#!/usr/bin/env bun
/**
 * Knowledge Store tests — validates CRUD operations, session isolation,
 * category filtering, upsert behavior, and cleanup on session delete.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";

const BROKER_PORT = 17899;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
let brokerProc: import("bun").Subprocess | null = null;
let testCounter = 0;

function uid(prefix = "test"): string {
  return `${prefix}-${Date.now()}-${++testCounter}`;
}

async function post(path: string, body: any): Promise<any> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

beforeAll(async () => {
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  const tmpDb = `/tmp/multiagents-knowledge-test-${Date.now()}.db`;
  brokerProc = Bun.spawn(["bun", brokerPath], {
    env: { ...process.env, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_DB: tmpDb },
    stdout: "pipe",
    stderr: "pipe",
  });

  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BROKER_URL}/healthz`);
      if (res.ok) break;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }
});

afterAll(() => {
  brokerProc?.kill();
});

/** Helper: create a session for knowledge tests */
async function createKnowledgeSession() {
  const sessionId = uid("ks-session");
  await post("/sessions/create", {
    id: sessionId,
    name: "knowledge-test",
    project_dir: "/tmp/knowledge-test",
  });
  return sessionId;
}

describe("Knowledge Store — put and get", () => {
  test("put creates a new knowledge entry", async () => {
    const sessionId = await createKnowledgeSession();

    const result = await post("/knowledge/put", {
      session_id: sessionId,
      key: "auth-pattern",
      value: "Using JWT tokens with refresh rotation",
      category: "decision",
      slot_id: 1,
      slot_name: "Engineer",
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe("created");
    expect(result.entry.key).toBe("auth-pattern");
    expect(result.entry.value).toBe("Using JWT tokens with refresh rotation");
    expect(result.entry.category).toBe("decision");
    expect(result.entry.created_by_slot).toBe(1);
    expect(result.entry.created_by_name).toBe("Engineer");
    expect(result.entry.created_at).toBeGreaterThan(0);
    expect(result.entry.updated_at).toBeGreaterThan(0);
  });

  test("get retrieves an entry by key", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", {
      session_id: sessionId,
      key: "db-choice",
      value: "PostgreSQL with Drizzle ORM",
      category: "decision",
    });

    const entry = await post("/knowledge/get", {
      session_id: sessionId,
      key: "db-choice",
    });

    expect(entry.key).toBe("db-choice");
    expect(entry.value).toBe("PostgreSQL with Drizzle ORM");
    expect(entry.category).toBe("decision");
  });

  test("get returns error for nonexistent key", async () => {
    const sessionId = await createKnowledgeSession();

    const result = await post("/knowledge/get", {
      session_id: sessionId,
      key: "nonexistent",
    });

    expect(result.error).toContain("No knowledge entry found");
  });
});

describe("Knowledge Store — upsert", () => {
  test("put updates existing entry (same key)", async () => {
    const sessionId = await createKnowledgeSession();

    const first = await post("/knowledge/put", {
      session_id: sessionId,
      key: "api-style",
      value: "REST with versioned URLs",
      category: "decision",
    });
    expect(first.action).toBe("created");

    const second = await post("/knowledge/put", {
      session_id: sessionId,
      key: "api-style",
      value: "GraphQL with code-first schema",
      category: "decision",
      slot_name: "Architect",
    });
    expect(second.action).toBe("updated");
    expect(second.entry.value).toBe("GraphQL with code-first schema");
    expect(second.entry.created_by_name).toBe("Architect");
    expect(second.entry.updated_at).toBeGreaterThanOrEqual(first.entry.updated_at);
  });
});

describe("Knowledge Store — list and filter", () => {
  test("list returns all entries for a session", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "k1", value: "v1", category: "decision" });
    await post("/knowledge/put", { session_id: sessionId, key: "k2", value: "v2", category: "discovery" });
    await post("/knowledge/put", { session_id: sessionId, key: "k3", value: "v3", category: "blocker" });

    const entries = await post("/knowledge/list", { session_id: sessionId });
    expect(entries.length).toBe(3);
  });

  test("list filters by category", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "d1", value: "v1", category: "decision" });
    await post("/knowledge/put", { session_id: sessionId, key: "d2", value: "v2", category: "decision" });
    await post("/knowledge/put", { session_id: sessionId, key: "b1", value: "v3", category: "blocker" });

    const decisions = await post("/knowledge/list", { session_id: sessionId, category: "decision" });
    expect(decisions.length).toBe(2);
    expect(decisions.every((e: any) => e.category === "decision")).toBe(true);

    const blockers = await post("/knowledge/list", { session_id: sessionId, category: "blocker" });
    expect(blockers.length).toBe(1);
  });

  test("list returns empty array for session with no entries", async () => {
    const sessionId = await createKnowledgeSession();

    const entries = await post("/knowledge/list", { session_id: sessionId });
    expect(entries).toEqual([]);
  });
});

describe("Knowledge Store — delete", () => {
  test("delete removes an entry", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "temp", value: "temporary", category: "context" });

    const beforeDelete = await post("/knowledge/get", { session_id: sessionId, key: "temp" });
    expect(beforeDelete.key).toBe("temp");

    const result = await post("/knowledge/delete", { session_id: sessionId, key: "temp" });
    expect(result.ok).toBe(true);

    const afterDelete = await post("/knowledge/get", { session_id: sessionId, key: "temp" });
    expect(afterDelete.error).toBeDefined();
  });
});

describe("Knowledge Store — session isolation", () => {
  test("entries are isolated between sessions", async () => {
    const session1 = await createKnowledgeSession();
    const session2 = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: session1, key: "shared-key", value: "session1-value", category: "context" });
    await post("/knowledge/put", { session_id: session2, key: "shared-key", value: "session2-value", category: "context" });

    const entry1 = await post("/knowledge/get", { session_id: session1, key: "shared-key" });
    expect(entry1.value).toBe("session1-value");

    const entry2 = await post("/knowledge/get", { session_id: session2, key: "shared-key" });
    expect(entry2.value).toBe("session2-value");
  });
});

describe("Knowledge Store — cleanup on session delete", () => {
  test("deleting session removes all knowledge entries", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "k1", value: "v1", category: "decision" });
    await post("/knowledge/put", { session_id: sessionId, key: "k2", value: "v2", category: "discovery" });

    const before = await post("/knowledge/list", { session_id: sessionId });
    expect(before.length).toBe(2);

    await post("/sessions/delete", { id: sessionId });

    const after = await post("/knowledge/list", { session_id: sessionId });
    expect(after.length).toBe(0);
  });
});

describe("Knowledge Store — validation", () => {
  test("rejects empty key", async () => {
    const sessionId = await createKnowledgeSession();

    const result = await post("/knowledge/put", {
      session_id: sessionId,
      key: "",
      value: "some value",
    });

    expect(result.error).toBeDefined();
  });

  test("rejects empty value", async () => {
    const sessionId = await createKnowledgeSession();

    const result = await post("/knowledge/put", {
      session_id: sessionId,
      key: "valid-key",
      value: "",
    });

    expect(result.error).toBeDefined();
  });

  test("rejects missing session_id", async () => {
    const result = await post("/knowledge/put", {
      key: "some-key",
      value: "some-value",
    });

    expect(result.error).toBeDefined();
  });

  test("defaults category to context when omitted", async () => {
    const sessionId = await createKnowledgeSession();

    const result = await post("/knowledge/put", {
      session_id: sessionId,
      key: "no-category",
      value: "default category test",
    });

    expect(result.ok).toBe(true);
    expect(result.entry.category).toBe("context");
  });
});

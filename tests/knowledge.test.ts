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

describe("Knowledge Store — list pagination and limits", () => {
  test("list defaults to 20 entries", async () => {
    const sessionId = await createKnowledgeSession();

    for (let i = 0; i < 25; i++) {
      await post("/knowledge/put", { session_id: sessionId, key: `pg-${i}`, value: `v${i}`, category: "context" });
    }

    const entries = await post("/knowledge/list", { session_id: sessionId });
    expect(entries.length).toBe(20);
  });

  test("list honours an explicit limit", async () => {
    const sessionId = await createKnowledgeSession();

    for (let i = 0; i < 10; i++) {
      await post("/knowledge/put", { session_id: sessionId, key: `lim-${i}`, value: `v${i}`, category: "context" });
    }

    const entries = await post("/knowledge/list", { session_id: sessionId, limit: 3 });
    expect(entries.length).toBe(3);
  });

  test("list clamps limit to the hard max of 100", async () => {
    const sessionId = await createKnowledgeSession();

    for (let i = 0; i < 105; i++) {
      await post("/knowledge/put", { session_id: sessionId, key: `max-${i}`, value: `v${i}`, category: "context" });
    }

    const entries = await post("/knowledge/list", { session_id: sessionId, limit: 5000 });
    expect(entries.length).toBe(100);
  });

  test("list falls back to the default for a non-positive limit", async () => {
    const sessionId = await createKnowledgeSession();

    for (let i = 0; i < 25; i++) {
      await post("/knowledge/put", { session_id: sessionId, key: `zero-${i}`, value: `v${i}`, category: "context" });
    }

    expect((await post("/knowledge/list", { session_id: sessionId, limit: 0 })).length).toBe(20);
    expect((await post("/knowledge/list", { session_id: sessionId, limit: -5 })).length).toBe(20);
  });

  test("list returns newest entries first and limit keeps the newest", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "old", value: "old", category: "context" });
    await new Promise((r) => setTimeout(r, 5));
    await post("/knowledge/put", { session_id: sessionId, key: "new", value: "new", category: "context" });

    const entries = await post("/knowledge/list", { session_id: sessionId, limit: 1 });
    expect(entries.length).toBe(1);
    expect(entries[0].key).toBe("new");
  });

  test("limit composes with the category filter", async () => {
    const sessionId = await createKnowledgeSession();

    for (let i = 0; i < 5; i++) {
      await post("/knowledge/put", { session_id: sessionId, key: `d-${i}`, value: `v${i}`, category: "decision" });
      await post("/knowledge/put", { session_id: sessionId, key: `b-${i}`, value: `v${i}`, category: "blocker" });
    }

    const entries = await post("/knowledge/list", { session_id: sessionId, category: "decision", limit: 2 });
    expect(entries.length).toBe(2);
    expect(entries.every((e: any) => e.category === "decision")).toBe(true);
  });
});

describe("Knowledge Store — since filter", () => {
  test("since returns only entries updated at or after the cutoff", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "before-1", value: "v", category: "context" });
    await post("/knowledge/put", { session_id: sessionId, key: "before-2", value: "v", category: "context" });

    await new Promise((r) => setTimeout(r, 10));
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 10));

    await post("/knowledge/put", { session_id: sessionId, key: "after-1", value: "v", category: "context" });

    const recent = await post("/knowledge/list", { session_id: sessionId, since: cutoff });
    expect(recent.length).toBe(1);
    expect(recent[0].key).toBe("after-1");

    const all = await post("/knowledge/list", { session_id: sessionId });
    expect(all.length).toBe(3);
  });

  test("since accepts an ISO timestamp as well as ms-epoch", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "before", value: "v", category: "context" });
    await new Promise((r) => setTimeout(r, 10));
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 10));
    await post("/knowledge/put", { session_id: sessionId, key: "after", value: "v", category: "context" });

    const iso = await post("/knowledge/list", { session_id: sessionId, since: new Date(cutoff).toISOString() });
    expect(iso.map((e: any) => e.key)).toEqual(["after"]);

    // An unparseable cutoff degrades to "no filter" rather than hiding every entry.
    const bogus = await post("/knowledge/list", { session_id: sessionId, since: "not-a-date" });
    expect(bogus.length).toBe(2);
  });

  test("since sees an updated entry because updated_at moves forward", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "moving", value: "first", category: "context" });

    await new Promise((r) => setTimeout(r, 10));
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 10));

    await post("/knowledge/put", { session_id: sessionId, key: "moving", value: "second", category: "context" });

    const recent = await post("/knowledge/list", { session_id: sessionId, since: cutoff });
    expect(recent.length).toBe(1);
    expect(recent[0].value).toBe("second");
  });

  test("a future since cutoff returns nothing", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "k", value: "v", category: "context" });

    const entries = await post("/knowledge/list", { session_id: sessionId, since: Date.now() + 60_000 });
    expect(entries).toEqual([]);
  });

  test("since composes with category and limit", async () => {
    const sessionId = await createKnowledgeSession();

    const cutoff = Date.now();
    for (let i = 0; i < 4; i++) {
      await post("/knowledge/put", { session_id: sessionId, key: `sd-${i}`, value: `v${i}`, category: "decision" });
      await post("/knowledge/put", { session_id: sessionId, key: `sb-${i}`, value: `v${i}`, category: "blocker" });
    }

    const entries = await post("/knowledge/list", { session_id: sessionId, category: "decision", since: cutoff, limit: 2 });
    expect(entries.length).toBe(2);
    expect(entries.every((e: any) => e.category === "decision")).toBe(true);
  });
});

describe("Knowledge Store — value truncation in list", () => {
  const long = "x".repeat(1200);

  test("list truncates long values to 500 chars with a marker", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "verbose", value: long, category: "context" });

    const [entry] = await post("/knowledge/list", { session_id: sessionId });
    expect(entry.truncated).toBe(true);
    expect(entry.value).toBe(
      `${"x".repeat(500)}... [truncated, 1200 chars total — use knowledge_get for the full value]`
    );
  });

  test("full: true returns the untruncated value", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "verbose", value: long, category: "context" });

    const [entry] = await post("/knowledge/list", { session_id: sessionId, full: true });
    expect(entry.value).toBe(long);
    expect(entry.value.length).toBe(1200);
    expect(entry.truncated).toBeUndefined();
  });

  test("short values are returned intact and untagged", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "brief", value: "short value", category: "context" });

    const [entry] = await post("/knowledge/list", { session_id: sessionId });
    expect(entry.value).toBe("short value");
    expect(entry.truncated).toBeUndefined();
  });

  test("a value of exactly 500 chars is not truncated", async () => {
    const sessionId = await createKnowledgeSession();
    const exact = "y".repeat(500);

    await post("/knowledge/put", { session_id: sessionId, key: "exact", value: exact, category: "context" });

    const [entry] = await post("/knowledge/list", { session_id: sessionId });
    expect(entry.value).toBe(exact);
    expect(entry.truncated).toBeUndefined();
  });

  test("get is unaffected by list truncation", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "verbose", value: long, category: "context" });

    const entry = await post("/knowledge/get", { session_id: sessionId, key: "verbose" });
    expect(entry.value).toBe(long);
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

  test("rejects a value longer than 4000 chars", async () => {
    const sessionId = await createKnowledgeSession();

    const result = await post("/knowledge/put", {
      session_id: sessionId,
      key: "too-big",
      value: "z".repeat(4001),
      category: "context",
    });

    expect(result.error).toContain("value too long");
    expect(result.error).toContain("4001");
    expect(result.error).toContain("max 4000");

    // Nothing was stored.
    const stored = await post("/knowledge/get", { session_id: sessionId, key: "too-big" });
    expect(stored.error).toBeDefined();
  });

  test("rejecting an oversized update leaves the previous value intact", async () => {
    const sessionId = await createKnowledgeSession();

    await post("/knowledge/put", { session_id: sessionId, key: "keep", value: "original", category: "context" });

    const result = await post("/knowledge/put", {
      session_id: sessionId,
      key: "keep",
      value: "z".repeat(5000),
      category: "context",
    });
    expect(result.error).toContain("value too long");

    const stored = await post("/knowledge/get", { session_id: sessionId, key: "keep" });
    expect(stored.value).toBe("original");
  });

  test("accepts a value of exactly 4000 chars", async () => {
    const sessionId = await createKnowledgeSession();
    const atLimit = "z".repeat(4000);

    const result = await post("/knowledge/put", {
      session_id: sessionId,
      key: "at-limit",
      value: atLimit,
      category: "context",
    });

    expect(result.ok).toBe(true);
    expect(result.entry.value).toBe(atLimit);
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

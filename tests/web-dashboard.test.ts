#!/usr/bin/env bun
/**
 * Web Dashboard tests — validates the dashboard server starts, serves HTML,
 * accepts WebSocket connections, and pushes broker state to clients.
 *
 * Requires a real broker on a test port (same pattern as session-lifecycle.test.ts).
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";

const BROKER_PORT = 17899;
const DASHBOARD_PORT = 17900;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;
let brokerProc: import("bun").Subprocess | null = null;
let dashboardProc: import("bun").Subprocess | null = null;
let testCounter = 0;

function uid(prefix = "test"): string {
  return `${prefix}-${Date.now()}-${++testCounter}`;
}

async function brokerPost(path: string, body: any): Promise<any> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

beforeAll(async () => {
  // Start broker on test port
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  const tmpDb = `/tmp/multiagents-web-dash-test-${Date.now()}.db`;
  brokerProc = Bun.spawn(["bun", brokerPath], {
    env: { ...process.env, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_DB: tmpDb },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for broker
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BROKER_URL}/healthz`);
      if (res.ok) break;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Create a test session so the dashboard has data to show
  await brokerPost("/sessions/create", {
    id: "dash-test-session",
    name: "Dashboard Test",
    project_dir: "/tmp/dash-test",
  });

  await brokerPost("/slots/create", {
    session_id: "dash-test-session",
    display_name: "Test-Agent",
    agent_type: "claude",
    role: "Software Engineer",
  });

  // Start web dashboard
  const dashPath = new URL("../dashboard/server.ts", import.meta.url).pathname;
  dashboardProc = Bun.spawn(["bun", dashPath, "dash-test-session"], {
    env: {
      ...process.env,
      MULTIAGENTS_PORT: String(BROKER_PORT),
      MULTIAGENTS_WEB_PORT: String(DASHBOARD_PORT),
      // Prevent auto-open browser during tests
      MULTIAGENTS_NO_OPEN: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for dashboard server
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(DASHBOARD_URL);
      if (res.ok) break;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }
});

afterAll(() => {
  dashboardProc?.kill();
  brokerProc?.kill();
});

describe("Web Dashboard — HTTP server", () => {
  test("serves index.html on /", async () => {
    const res = await fetch(DASHBOARD_URL);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("multiagents");
  });

  test("serves index.html on /index.html", async () => {
    const res = await fetch(`${DASHBOARD_URL}/index.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("multiagents");
  });

  test("returns 404 for unknown paths", async () => {
    const res = await fetch(`${DASHBOARD_URL}/nonexistent`);
    expect(res.status).toBe(404);
  });
});

describe("Web Dashboard — API endpoints", () => {
  test("/api/sessions returns session list", async () => {
    const res = await fetch(`${DASHBOARD_URL}/api/sessions`);
    expect(res.status).toBe(200);
    const sessions = await res.json() as any[];
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.some((s: any) => s.id === "dash-test-session")).toBe(true);
  });

  test("/api/session switches session", async () => {
    const res = await fetch(`${DASHBOARD_URL}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "dash-test-session" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.session_id).toBe("dash-test-session");
  });

  test("/api/guardrail records the new limit on the broker", async () => {
    const res = await fetch(`${DASHBOARD_URL}/api/guardrail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "dash-test-session", guardrail_id: "max_restarts", value: 7, reason: "test" }),
    });
    expect(res.status).toBe(200);
    const guardrails = await brokerPost("/guardrails", { session_id: "dash-test-session" });
    const maxRestarts = guardrails.find((g: any) => g.id === "max_restarts");
    expect(maxRestarts.current_value).toBe(7);
    expect(maxRestarts.is_overridden).toBe(true);
  });

  test("/api/session rejects missing session_id", async () => {
    const res = await fetch(`${DASHBOARD_URL}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("Web Dashboard — WebSocket", () => {
  test("connects and receives state", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${DASHBOARD_PORT}/ws`);

    const statePromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket state timeout")), 5000);
      ws.onmessage = (e) => {
        clearTimeout(timeout);
        try {
          const msg = JSON.parse(e.data as string);
          resolve(msg);
        } catch (err) {
          reject(err);
        }
      };
      ws.onerror = (e) => { clearTimeout(timeout); reject(e); };
    });

    const msg = await statePromise;
    ws.close();

    expect(msg.type).toBe("state");
    expect(msg.data).toBeDefined();
    expect(msg.data.brokerAlive).toBe(true);
    expect(msg.data.sessionId).toBe("dash-test-session");
    expect(msg.data.slots.length).toBeGreaterThanOrEqual(1);
    expect(msg.data.session?.name).toBe("Dashboard Test");
  });

  test("responds to ping with pong", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${DASHBOARD_PORT}/ws`);

    const pongPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Pong timeout")), 5000);
      ws.onmessage = (e) => {
        const data = e.data as string;
        // Skip state pushes — look for the "pong" response
        if (data === "pong") {
          clearTimeout(timeout);
          resolve(data);
        }
      };
      ws.onopen = () => {
        // Send ping after connection is established
        setTimeout(() => ws.send("ping"), 300);
      };
      ws.onerror = (e) => { clearTimeout(timeout); reject(e); };
    });

    const response = await pongPromise;
    ws.close();
    expect(response).toBe("pong");
  });

  test("state includes knowledge data", async () => {
    // Add a knowledge entry via broker
    await brokerPost("/knowledge/put", {
      session_id: "dash-test-session",
      key: "test-key",
      value: "test-value",
      category: "decision",
    });

    // The dashboard refreshes from the broker every DASHBOARD_REFRESH ms; reconnect until the entry shows up
    const firstState = () => new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${DASHBOARD_PORT}/ws`);
      const timeout = setTimeout(() => { ws.close(); reject(new Error("Timeout")); }, 5000);
      ws.onmessage = (e) => { clearTimeout(timeout); ws.close(); resolve(JSON.parse(e.data as string)); };
      ws.onerror = (e) => { clearTimeout(timeout); reject(e); };
    });
    let msg: any;
    const deadline = Date.now() + 10_000;
    while (true) {
      msg = await firstState();
      if (msg.data?.knowledge?.some((k: any) => k.key === "test-key")) break;
      if (Date.now() > deadline) throw new Error("knowledge never appeared in the dashboard state");
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(msg.data.knowledge.length).toBeGreaterThanOrEqual(1);
    const entry = msg.data.knowledge.find((k: any) => k.key === "test-key");
    expect(entry).toBeDefined();
    expect(entry.value).toBe("test-value");
    expect(entry.category).toBe("decision");
  });
});

describe("Web Dashboard — UI assets", () => {
  test("the page has the chat, the explorer and the preview", async () => {
    const html = await (await fetch(DASHBOARD_URL)).text();
    for (const tab of ["chat", "agents", "plan", "knowledge", "files", "stats"]) expect(html).toContain(`data-tab="${tab}"`);
    expect(html).toContain('id="explorer-tree"');
    expect(html).toContain('id="preview-body"');
    expect(html).toContain('src="/app.js"');
    expect(html).toContain('href="/styles.css"');
    // Translations load first: app.js calls tr() while it boots
    expect(html.indexOf('src="/i18n.js"')).toBeGreaterThan(-1);
    expect(html.indexOf('src="/i18n.js"')).toBeLessThan(html.indexOf('src="/app.js"'));
  });

  test("serves the translations", async () => {
    const res = await fetch(`${DASHBOARD_URL}/i18n.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("function tr(");
  });

  test("serves the script with the WebSocket logic", async () => {
    const res = await fetch(`${DASHBOARD_URL}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js).toContain("new WebSocket");
    expect(js).toContain("connectWs");
    expect(js).toContain("ws.onmessage");
  });

  test("serves the stylesheet with light and dark themes", async () => {
    const res = await fetch(`${DASHBOARD_URL}/styles.css`);
    expect(res.headers.get("content-type")).toContain("text/css");
    const css = await res.text();
    expect(css).toContain('html[data-theme="light"]');
    expect(css).toContain('html[data-theme="dark"]');
  });

  test("serves nothing else from the dashboard directory", async () => {
    expect((await fetch(`${DASHBOARD_URL}/server.ts`)).status).toBe(404);
    expect((await fetch(`${DASHBOARD_URL}/control.ts`)).status).toBe(404);
  });
});

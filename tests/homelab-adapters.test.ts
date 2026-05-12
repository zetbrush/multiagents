import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TEST_PORT = "7901"; // éviter conflit avec brokers dev/prod

let broker: Subprocess;

beforeAll(async () => {
  broker = spawn({
    cmd: ["bun", `${ROOT}/broker.ts`],
    env: { ...process.env, MULTIAGENTS_PORT: TEST_PORT },
    stdout: "pipe",
    stderr: "pipe",
  });
  // attendre que le broker bind le port
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
      if (r.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("broker did not start within 3s");
});

afterAll(() => {
  broker?.kill();
});

describe("homelab adapters register with correct prefix", () => {
  const cases: Array<{ type: string; prefix: string; className: string }> = [
    { type: "kimi",    prefix: "km-", className: "KimiAdapter" },
    { type: "copilot", prefix: "cp-", className: "CopilotAdapter" },
    { type: "qwen",    prefix: "qw-", className: "QwenAdapter" },
    { type: "jinn",    prefix: "jn-", className: "JinnAdapter" },
  ];

  for (const { type, prefix, className } of cases) {
    test(`${type} → ${className} registers with ${prefix} prefix`, async () => {
      const adapter = spawn({
        cmd: ["bun", `${ROOT}/server.ts`, "--agent-type", type],
        env: { ...process.env, MULTIAGENTS_PORT: TEST_PORT },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      // Send MCP initialize to unblock the handshake
      adapter.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-probe", version: "1" },
        },
      }) + "\n");
      adapter.stdin.flush();

      // Give the adapter time to register with the broker
      await Bun.sleep(2500);

      // Read stderr to capture the registration line
      const reader = adapter.stderr.getReader();
      const chunks: string[] = [];
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        const race = await Promise.race([
          reader.read(),
          new Promise<any>((res) => setTimeout(() => res({ done: true, value: null }), 100)),
        ]);
        if (race.done || !race.value) break;
        chunks.push(new TextDecoder().decode(race.value));
      }
      const stderrText = chunks.join("");

      adapter.kill();
      await Bun.sleep(200);

      const match = stderrText.match(/Registered as peer (\S+)/);
      expect(match).not.toBeNull();
      expect(match![1]).toMatch(new RegExp(`^${prefix}`));
    }, 10000); // timeout 10s
  }
});

/**
 * The standalone `multiagents` server that `multiagents setup` installs in
 * ~/.codex/config.toml survives Codex launches. Orchestrated threads keep it
 * from loading next to multiagents-peer with a per-thread config override,
 * which Codex only accepts for a server that is configured (verified on
 * codex-cli 0.170.0: an override for an unknown server fails thread/start
 * with "invalid transport").
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rewriteCodexMcpConfig, codexThreadConfigFor, launchAgent } from "../orchestrator/launcher.ts";
import { respawnAgent } from "../orchestrator/recovery.ts";

const FAKE_CODEX = new URL("./fakes/fake-codex-app-server.ts", import.meta.url).pathname;
const PEER = { args: ["/install/cli.ts", "mcp-server", "--agent-type", "codex"], port: null as string | null };
const DISABLE_STANDALONE = { "mcp_servers.multiagents.enabled": false };

const STANDALONE = `[mcp_servers.multiagents]
command = "/Users/me/.bun/bin/bun"
args = ["/Users/me/multiagents/server.ts", "--agent-type", "codex"]
default_tools_approval_mode = "approve"
`;

const peerSections = (toml: string) => toml.match(/^\[mcp_servers\."multiagents-peer"\]$/gm) ?? [];

describe("rewriteCodexMcpConfig", () => {
  test("the standalone server installed by setup is kept as it is", () => {
    const before = `model = "gpt-test"\n\n[mcp_servers.figma]\nurl = "https://f"\n\n${STANDALONE}\n[features]\nmemories = true\n`;
    const after = rewriteCodexMcpConfig(before, PEER);

    expect(after).toContain(STANDALONE);
    expect(after).toContain("[mcp_servers.figma]");
    expect(after).toContain("[features]\nmemories = true");
    expect(peerSections(after)).toHaveLength(1);
  });

  test("a standalone entry without an array value does not take the next section with it", () => {
    const before = `[mcp_servers.multiagents]\ncommand = "multiagents-server"\n\n[features]\nmemories = true\n\n[tui]\nx = 1\n`;
    const after = rewriteCodexMcpConfig(before, PEER);

    expect(after).toContain('[mcp_servers.multiagents]\ncommand = "multiagents-server"');
    expect(after).toContain("[features]\nmemories = true");
    expect(after).toContain("[tui]\nx = 1");
  });

  test("tool tables left behind without their server are removed, since Codex rejects them", () => {
    const before = `[mcp_servers.multiagents.tools.check_messages]\napproval_mode = "approve"\n\n[mcp_servers.multiagents.tools.set_summary]\napproval_mode = "approve"\n\n[features]\nmemories = true\n`;
    const after = rewriteCodexMcpConfig(before, PEER);

    expect(after).not.toContain("[mcp_servers.multiagents.tools");
    expect(after).toContain("[features]\nmemories = true");
  });

  test("tool tables of a configured standalone server are kept", () => {
    const before = `${STANDALONE}\n[mcp_servers.multiagents.tools.check_messages]\napproval_mode = "approve"\n`;
    const after = rewriteCodexMcpConfig(before, PEER);

    expect(after).toContain(STANDALONE);
    expect(after).toContain('[mcp_servers.multiagents.tools.check_messages]\napproval_mode = "approve"');
  });

  test("the peer section is replaced by one fresh entry and its tool tables stay", () => {
    const before = `[mcp_servers."multiagents-peer"]\ncommand = "bun"\nargs = ["/old/cli.ts", "mcp-server", "--agent-type", "codex"]\nenv = { MULTIAGENTS_PORT = "17999" }\n\n[mcp_servers."multiagents-peer".tools.check_messages]\napproval_mode = "approve"\n\n[features]\nmemories = true\n`;
    const after = rewriteCodexMcpConfig(before, PEER);

    expect(peerSections(after)).toHaveLength(1);
    expect(after).not.toContain("/old/cli.ts");
    expect(after).not.toContain("MULTIAGENTS_PORT");
    expect(after).toContain('args = ["/install/cli.ts", "mcp-server", "--agent-type", "codex"]');
    expect(after).toContain('default_tools_approval_mode = "approve"');
    expect(after).toContain('[mcp_servers."multiagents-peer".tools.check_messages]\napproval_mode = "approve"');
    expect(after).toContain("[features]\nmemories = true");
  });

  test("everything else in the file is reproduced exactly, also when it starts with a table", () => {
    const before = `[projects."/Users/me/app"]\ntrust_level = "trusted"\n\n${STANDALONE}\n[features]\nmemories = true\n`;
    const entry = `\n[mcp_servers."multiagents-peer"]\ncommand = "bun"\nargs = ["/install/cli.ts", "mcp-server", "--agent-type", "codex"]\ndefault_tools_approval_mode = "approve"\n`;

    expect(rewriteCodexMcpConfig(before, PEER)).toBe(before.trimEnd() + "\n" + entry);
  });

  test("a broker port override goes into the peer entry", () => {
    const after = rewriteCodexMcpConfig("", { ...PEER, port: "17999" });
    expect(after).toContain('env = { MULTIAGENTS_PORT = "17999" }');
  });

  test("rewriting twice changes nothing more", () => {
    const once = rewriteCodexMcpConfig(`${STANDALONE}\n[features]\nmemories = true\n`, PEER);
    expect(rewriteCodexMcpConfig(once, PEER)).toBe(once);
  });
});

describe("codexThreadConfigFor", () => {
  test("a configured standalone server is switched off for the thread", () => {
    expect(codexThreadConfigFor(`${STANDALONE}\n[features]\nmemories = true\n`)).toEqual(DISABLE_STANDALONE);
    expect(codexThreadConfigFor(`[mcp_servers."multiagents"]\ncommand = "multiagents-server"\n`)).toEqual(DISABLE_STANDALONE);
  });

  test("without a standalone server no override is sent", () => {
    expect(codexThreadConfigFor("")).toBeUndefined();
    expect(codexThreadConfigFor(`[mcp_servers."multiagents-peer"]\ncommand = "bun"\n\n[mcp_servers.multiagents.tools.check_messages]\napproval_mode = "approve"\n`)).toBeUndefined();
  });
});

describe("Codex threads started by the orchestrator", () => {
  const configPath = path.join(process.env.HOME ?? "", ".codex", "config.toml");
  const saved = { config: null as string | null, command: process.env.MULTIAGENTS_CODEX_COMMAND, log: process.env.FAKE_CODEX_LOG };
  const kills: Array<() => Promise<void>> = [];
  let projectDir = "";
  let logPath = "";

  beforeEach(() => {
    try { saved.config = fs.readFileSync(configPath, "utf-8"); } catch { saved.config = null; }
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-standalone-"));
    logPath = path.join(projectDir, "fake-codex.log");
    process.env.MULTIAGENTS_CODEX_COMMAND = `bun ${FAKE_CODEX}`;
    process.env.FAKE_CODEX_LOG = logPath;
  });
  afterEach(async () => {
    for (const kill of kills.splice(0)) await kill();
    if (saved.config !== null) fs.writeFileSync(configPath, saved.config); else fs.rmSync(configPath, { force: true });
    if (saved.command === undefined) delete process.env.MULTIAGENTS_CODEX_COMMAND; else process.env.MULTIAGENTS_CODEX_COMMAND = saved.command;
    if (saved.log === undefined) delete process.env.FAKE_CODEX_LOG; else process.env.FAKE_CODEX_LOG = saved.log;
  });

  const writeConfig = (toml: string) => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, toml);
  };
  const requests = (method: string) => fs.existsSync(logPath)
    ? fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.request === method)
    : [];
  async function request(method: string): Promise<{ params: Record<string, unknown> }> {
    const deadline = Date.now() + 10_000;
    while (requests(method).length === 0) {
      if (Date.now() > deadline) throw new Error(`the fake app-server never received ${method}`);
      await Bun.sleep(50);
    }
    return requests(method)[0];
  }
  const launch = async () => {
    const broker = { createSlot: async () => ({ id: 7 }), updateSlot: async () => ({}) } as any;
    const launched = await launchAgent("codex-session", projectDir, {
      agent_type: "codex", name: "Reviewer", role: "Code Reviewer", role_description: "", initial_task: "Review the change.",
    }, broker);
    kills.push(() => launched.codexDriver!.kill());
  };
  const respawn = async (snapshot: Record<string, unknown>) => {
    const slot = { id: 7, session_id: "codex-session", agent_type: "codex", display_name: "Reviewer", role: "Code Reviewer", role_description: "", context_snapshot: JSON.stringify(snapshot) };
    const broker = { getSlot: async () => slot, getMessageLog: async () => [], listSlots: async () => [], updateSlot: async () => ({}) } as any;
    const respawned = await respawnAgent("codex-session", 7, broker, projectDir);
    kills.push(() => respawned.codexDriver!.kill());
  };

  test("a launch keeps the standalone server in the config and switches it off for its thread", async () => {
    writeConfig(`${STANDALONE}\n[features]\nmemories = true\n`);

    await launch();

    expect((await request("thread/start")).params.config).toEqual(DISABLE_STANDALONE);
    const config = fs.readFileSync(configPath, "utf-8");
    expect(config).toContain(STANDALONE);
    expect(config).toContain("[features]\nmemories = true");
    expect(peerSections(config)).toHaveLength(1);
  });

  test("a launch without a standalone server sends no override", async () => {
    writeConfig(`[features]\nmemories = true\n`);

    await launch();

    expect((await request("thread/start")).params.config).toBeUndefined();
  });

  test("a respawn that resumes the thread switches the standalone server off again", async () => {
    writeConfig(`${STANDALONE}\n[mcp_servers."multiagents-peer"]\ncommand = "bun"\nargs = ["/install/cli.ts", "mcp-server", "--agent-type", "codex"]\n`);

    await respawn({ codex_thread_id: "thr_42" });

    const resume = await request("thread/resume");
    expect(resume.params.threadId).toBe("thr_42");
    expect(resume.params.config).toEqual(DISABLE_STANDALONE);
  });

  test("a respawn into a fresh thread does the same", async () => {
    writeConfig(`${STANDALONE}\n[mcp_servers."multiagents-peer"]\ncommand = "bun"\nargs = ["/install/cli.ts", "mcp-server", "--agent-type", "codex"]\n`);

    await respawn({});

    expect((await request("thread/start")).params.config).toEqual(DISABLE_STANDALONE);
  });
});

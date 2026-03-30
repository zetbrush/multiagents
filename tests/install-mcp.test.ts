import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = process.cwd();
const SAFE_PATH = "/usr/bin:/bin";
const BUN_BIN = process.execPath;

const tempHomes: string[] = [];

function decode(output: Uint8Array | null | undefined): string {
  return new TextDecoder().decode(output ?? new Uint8Array());
}

function makeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-mcp-test-"));
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  tempHomes.push(home);
  return home;
}

function writeExecutable(home: string, name: string, script: string): void {
  fs.writeFileSync(path.join(home, "bin", name), script, { mode: 0o755 });
}

function runWithHome(home: string, command: string[]): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(command, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${path.join(home, "bin")}:${SAFE_PATH}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: proc.exitCode,
    stdout: decode(proc.stdout),
    stderr: decode(proc.stderr),
  };
}

function runInstall(home: string): { exitCode: number | null; stdout: string; stderr: string } {
  return runWithHome(home, [
    BUN_BIN,
    "-e",
    'import { installMcpSilent } from "./cli/install-mcp.ts"; await installMcpSilent();',
  ]);
}

function runPreuninstall(home: string): { exitCode: number | null; stdout: string; stderr: string } {
  return runWithHome(home, [BUN_BIN, "run", "scripts/preuninstall.ts"]);
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("install-mcp / preuninstall", () => {
  test("installs safe Claude/Codex/Gemini config and removes Codex cleanly", () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });

    for (const name of ["claude", "codex", "gemini", "multiagents-server", "multiagents-orch"]) {
      writeExecutable(home, name, "#!/bin/sh\nexit 0\n");
    }

    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Read", "mcp__multiagents__*", "mcp__multiagents-orch__*"],
        },
      }, null, 2) + "\n",
    );

    const install = runInstall(home);
    expect(install.exitCode).toBe(0);

    const claudeSettings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf-8"));
    expect(claudeSettings.permissions.allow).toContain("mcp__multiagents");
    expect(claudeSettings.permissions.allow).toContain("mcp__multiagents-orch");
    expect(claudeSettings.permissions.allow).not.toContain("mcp__multiagents__*");
    expect(claudeSettings.permissions.allow).not.toContain("mcp__multiagents-orch__*");

    const codexToml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf-8");
    expect(codexToml).toContain("[mcp_servers.multiagents]");
    expect(codexToml).toContain('default_approval_mode = "approve"');
    expect(codexToml).toContain('args = ["--agent-type", "codex"]');

    const geminiSettings = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf-8"));
    expect(geminiSettings.mcpServers.multiagents.args).toEqual(["--agent-type", "gemini"]);
    expect(geminiSettings.mcpServers.multiagents.timeout).toBe(30000);
    expect(geminiSettings.mcpServers.multiagents.trust).toBe(true);

    const uninstall = runPreuninstall(home);
    expect(uninstall.exitCode).toBe(0);

    const cleanedCodex = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf-8");
    expect(cleanedCodex).not.toContain("[mcp_servers.multiagents]");
    expect(cleanedCodex).not.toContain('args = ["--agent-type", "codex"]');
  });

  test("does not overwrite malformed ~/.claude.json when Claude CLI add fails", () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });

    writeExecutable(
      home,
      "claude",
      "#!/bin/sh\nif [ \"$1\" = \"mcp\" ] && [ \"$2\" = \"add\" ]; then\n  exit 1\nfi\nexit 0\n",
    );
    for (const name of ["codex", "multiagents-server", "multiagents-orch"]) {
      writeExecutable(home, name, "#!/bin/sh\nexit 0\n");
    }

    fs.writeFileSync(path.join(home, ".claude.json"), "{malformed-json");

    const install = runInstall(home);
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain("skipping ~/.claude.json update");
    expect(fs.readFileSync(path.join(home, ".claude.json"), "utf-8")).toBe("{malformed-json");

    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf-8"));
    expect(settings.permissions.allow).toEqual(["mcp__multiagents", "mcp__multiagents-orch"]);
  });
});

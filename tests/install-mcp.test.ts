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

function switchOrchestrator(home: string, host: "claude" | "codex" | "agy") {
  return runWithHome(home, [BUN_BIN, "cli.ts", "orchestrator", "set", host]);
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("install-mcp / preuninstall", () => {
  test("installs safe Claude/Codex/Antigravity config and removes it cleanly", () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });

    for (const name of ["claude", "codex", "agy", "multiagents-server", "multiagents-orch"]) {
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
    const hostConfig = JSON.parse(fs.readFileSync(path.join(home, ".multiagents", "config.json"), "utf-8"));
    expect(hostConfig.orchestrator_host).toBe("claude");

    const claudeSettings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf-8"));
    expect(claudeSettings.permissions.allow).toContain("mcp__multiagents");
    expect(claudeSettings.permissions.allow).toContain("mcp__multiagents-orch");
    expect(claudeSettings.permissions.allow).not.toContain("mcp__multiagents__*");
    expect(claudeSettings.permissions.allow).not.toContain("mcp__multiagents-orch__*");

    const codexToml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf-8");
    expect(codexToml).toContain("[mcp_servers.multiagents]");
    expect(codexToml).toContain('default_approval_mode = "approve"');
    // Args now include server.ts path + agent type (self-resolving paths)
    expect(codexToml).toContain('"--agent-type", "codex"');
    expect(codexToml).toContain("server.ts");
    expect(codexToml).not.toContain("[mcp_servers.multiagents-orch]");

    const agyConfigPath = path.join(home, ".gemini", "config", "mcp_config.json");
    const agyConfig = JSON.parse(fs.readFileSync(agyConfigPath, "utf-8"));
    expect(agyConfig.mcpServers.multiagents.args).toContain("--agent-type");
    expect(agyConfig.mcpServers.multiagents.args).toContain("agy");
    expect(agyConfig.mcpServers["multiagents-orch"]).toBeUndefined();

    const uninstall = runPreuninstall(home);
    expect(uninstall.exitCode).toBe(0);

    const cleanedCodex = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf-8");
    expect(cleanedCodex).not.toContain("[mcp_servers.multiagents]");
    expect(cleanedCodex).not.toContain("--agent-type");
    const cleanedAgy = JSON.parse(fs.readFileSync(agyConfigPath, "utf-8"));
    expect(cleanedAgy.mcpServers.multiagents).toBeUndefined();
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

  test("switches the orchestrator between AGY and Codex", () => {
    const home = makeTempHome();
    for (const name of ["codex", "agy", "multiagents-server", "multiagents-orch"]) {
      writeExecutable(home, name, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 1.0.0; fi\nexit 0\n");
    }

    const agySwitch = switchOrchestrator(home, "agy");
    expect(agySwitch.exitCode).toBe(0);
    expect(agySwitch.stdout).toContain("Orchestrator switched to agy");

    const hostConfig = JSON.parse(fs.readFileSync(path.join(home, ".multiagents", "config.json"), "utf-8"));
    expect(hostConfig.orchestrator_host).toBe("agy");

    let agyConfig = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf-8"));
    expect(agyConfig.mcpServers["multiagents-orch"].args.join(" ")).toContain("orchestrator-server.ts");

    let codexToml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf-8");
    expect(codexToml).not.toContain("[mcp_servers.multiagents-orch]");

    const codexSwitch = switchOrchestrator(home, "codex");
    expect(codexSwitch.exitCode).toBe(0);
    expect(codexSwitch.stdout).toContain("Orchestrator switched to codex");

    codexToml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf-8");
    expect(codexToml).toContain("[mcp_servers.multiagents-orch]");
    expect(codexToml).toContain("orchestrator-server.ts");

    agyConfig = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf-8"));
    expect(agyConfig.mcpServers["multiagents-orch"]).toBeUndefined();
  });

  test("selects Codex automatically when Claude is unavailable", () => {
    const home = makeTempHome();
    for (const name of ["codex", "agy", "multiagents-server", "multiagents-orch"]) {
      writeExecutable(home, name, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 1.0.0; fi\nexit 0\n");
    }

    const install = runInstall(home);
    expect(install.exitCode).toBe(0);

    const hostConfig = JSON.parse(fs.readFileSync(path.join(home, ".multiagents", "config.json"), "utf-8"));
    expect(hostConfig.orchestrator_host).toBe("codex");

    const codexToml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf-8");
    expect(codexToml).toContain("[mcp_servers.multiagents-orch]");
  });
});

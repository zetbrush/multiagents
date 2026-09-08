import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type OrchestratorHost = "claude" | "codex" | "agy";

export function orchestratorConfigPath(): string {
  return path.join(os.homedir(), ".multiagents", "config.json");
}

export function readOrchestratorHost(): OrchestratorHost | null {
  const configPath = orchestratorConfigPath();
  if (!fs.existsSync(configPath)) return null;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const host = config?.orchestrator_host;
    return host === "claude" || host === "codex" || host === "agy" ? host : null;
  } catch {
    return null;
  }
}

export function writeOrchestratorHost(host: OrchestratorHost): void {
  const configPath = orchestratorConfigPath();
  const configDir = path.dirname(configPath);
  let config: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${configPath} is not a JSON object`);
    }
    config = parsed as Record<string, unknown>;
  }

  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  config.orchestrator_host = host;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

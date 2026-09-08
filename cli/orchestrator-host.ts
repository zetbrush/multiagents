import { readOrchestratorHost, writeOrchestratorHost, type OrchestratorHost } from "../shared/orchestrator-host.ts";

const HOSTS = new Set<OrchestratorHost>(["claude", "codex", "agy"]);

export async function orchestratorHostCommand(args: string[]): Promise<void> {
  const action = args[0] ?? "status";

  if (action === "status" || action === "get") {
    const host = readOrchestratorHost();
    console.log(host
      ? `Current orchestrator host: ${host}`
      : "No orchestrator host selected yet. Run `multiagents install-mcp` to select the first available CLI.");
    return;
  }

  if (action !== "set" || !HOSTS.has(args[1] as OrchestratorHost)) {
    console.error("Usage: multiagents orchestrator <status|set claude|codex|agy>");
    process.exitCode = 1;
    return;
  }

  const host = args[1] as OrchestratorHost;
  const { detectAgent } = await import("../orchestrator/launcher.ts");
  const detection = await detectAgent(host);
  if (!detection.available) {
    console.error(`Cannot switch orchestrator: ${host} CLI is not installed or not available on PATH.`);
    process.exitCode = 1;
    return;
  }

  writeOrchestratorHost(host);

  const { installMcpSilent } = await import("./install-mcp.ts");
  await installMcpSilent();

  console.log(`\nOrchestrator switched to ${host}.`);
  console.log("Restart Claude, Codex, and AGY so they reload their MCP configuration.");
}

// ============================================================================
// multiagents — `multiagents update`
// ============================================================================
// Upgrades this installation to the registry's latest version with the package
// manager that owns it, then stops an idle broker so the next start runs the
// new code. Every external effect is injected so the flow is unit-testable.
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrokerPort, brokerUrl } from "../shared/broker-url.ts";

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";
export type InstallKind = PackageManager | "local" | "source" | "unknown";

/** What the broker's /health reports; anything else answering on the port is some other service. */
export interface BrokerHealth {
  peers: number;
  pid?: number;
  version?: string;
  /** Capabilities of the running build (absent on brokers older than the list) */
  features?: string[];
}

export interface UpdateDeps {
  /** Directory holding the package.json of the running copy. */
  packageRoot: string;
  installedVersion: string;
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
  fetchLatestVersion: () => Promise<string>;
  /** Runs the upgrade with visible output; resolves with its exit code. */
  run: (cmd: string[]) => Promise<number>;
  /** null when no broker answers on the configured port. */
  brokerHealth: () => Promise<BrokerHealth | null>;
  stopBroker: (health: BrokerHealth) => Promise<void>;
  log: (line: string) => void;
}

export type UpdateAction = "updated" | "up-to-date" | "check" | "dry-run" | "source-checkout" | "local-dependency" | "unknown-install" | "failed";

export interface UpdateResult {
  ok: boolean;
  action: UpdateAction;
  kind: InstallKind;
  installed: string;
  latest?: string;
  command?: string[];
  brokerRestarted?: boolean;
}

const PACKAGE = "multiagents";
const REGISTRY_LATEST = `https://registry.npmjs.org/${PACKAGE}/latest`;

export function detectInstall(root: string, opts: { env: Record<string, string | undefined>; exists: (p: string) => boolean }): InstallKind {
  if (opts.exists(path.join(root, ".git"))) return "source";
  const where = root.replace(/\\/g, "/");
  const bunGlobal = opts.env.BUN_INSTALL ? path.join(opts.env.BUN_INSTALL, "install", "global").replace(/\\/g, "/") : null;
  if (where.includes("/.bun/install/global/") || (bunGlobal !== null && where.startsWith(bunGlobal))) return "bun";
  if (where.includes("/pnpm/")) return "pnpm";
  if (where.includes("/yarn/")) return "yarn";
  // npm's global prefix keeps packages under lib/node_modules (npm/node_modules on Windows);
  // any other node_modules is a project's own dependency.
  if (where.includes("/lib/node_modules/") || where.includes("/npm/node_modules/")) return "npm";
  if (where.includes("/node_modules/")) return "local";
  return "unknown";
}

export function upgradeCommand(kind: PackageManager, version: string): string[] {
  const spec = `${PACKAGE}@${version}`;
  switch (kind) {
    case "bun": return ["bun", "add", "-g", spec];
    case "npm": return ["npm", "install", "-g", spec];
    case "pnpm": return ["pnpm", "add", "-g", spec];
    case "yarn": return ["yarn", "global", "add", spec];
  }
}

/** Numeric x.y.z comparison; anything after a dash (prerelease) sorts below the plain version. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split("-", 2);
    return { nums: core!.split(".").map((n) => parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const diff = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export async function runUpdate(args: string[], deps: UpdateDeps): Promise<UpdateResult> {
  const check = args.includes("--check");
  const dryRun = args.includes("--dry-run");
  const installed = deps.installedVersion;
  const kind = detectInstall(deps.packageRoot, deps);

  const sourceCheckout = (): UpdateResult => {
    deps.log(`This copy (${deps.packageRoot}) is a source checkout — update it with git pull, then bun install.`);
    return { ok: true, action: "source-checkout", kind, installed };
  };
  const localDependency = (): UpdateResult => {
    deps.log(`This copy (${deps.packageRoot}) is a dependency of a project; update it there with \`bun update multiagents\` or \`npm update multiagents\`.`);
    return { ok: true, action: "local-dependency", kind, installed };
  };
  if (kind === "source" && !check) return sourceCheckout();
  if (kind === "local" && !check) return localDependency();

  let latest: string;
  try {
    latest = await deps.fetchLatestVersion();
  } catch (err) {
    deps.log(`Could not read the latest version from the npm registry: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, action: "failed", kind, installed };
  }

  deps.log(`Installed: ${installed}   Latest: ${latest}`);
  if (check) return { ok: true, action: "check", kind, installed, latest };
  if (kind === "source") return sourceCheckout();
  if (kind === "local") return localDependency();
  const cmp = compareVersions(installed, latest);
  if (cmp === 0) {
    deps.log(`multiagents ${installed} is already the latest version.`);
    return { ok: true, action: "up-to-date", kind, installed, latest };
  }
  if (cmp > 0) {
    deps.log(`multiagents ${installed} is newer than the registry's latest (${latest}); nothing to update.`);
    return { ok: true, action: "up-to-date", kind, installed, latest };
  }

  if (kind === "unknown") {
    deps.log(`Could not tell how this copy (${deps.packageRoot}) was installed. Upgrade it yourself with one of:`);
    for (const manager of ["bun", "npm", "pnpm", "yarn"] as const) deps.log(`  ${upgradeCommand(manager, latest).join(" ")}`);
    return { ok: false, action: "unknown-install", kind, installed, latest };
  }

  const command = upgradeCommand(kind, latest);
  if (dryRun) {
    deps.log(`Would run: ${command.join(" ")}`);
    return { ok: true, action: "dry-run", kind, installed, latest, command };
  }

  deps.log(`Updating multiagents ${installed} → ${latest}: ${command.join(" ")}`);
  let code: number;
  try {
    code = await deps.run(command);
  } catch (err) {
    deps.log(`Could not run ${command[0]}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, action: "failed", kind, installed, latest, command };
  }
  if (code !== 0) {
    deps.log(`${command[0]} exited with code ${code}; multiagents ${installed} is still installed.`);
    return { ok: false, action: "failed", kind, installed, latest, command };
  }

  // The broker is a daemon that keeps running the old code until it is restarted.
  let brokerRestarted = false;
  const health = await deps.brokerHealth();
  if (health && health.peers === 0) {
    try {
      await deps.stopBroker(health);
      brokerRestarted = true;
      deps.log("Stopped the idle broker; it restarts on the new version with the next agent.");
    } catch (err) {
      deps.log(`The idle broker could not be stopped (${err instanceof Error ? err.message : String(err)}); run \`multiagents broker stop\` so it restarts on ${latest}.`);
    }
  } else if (health) {
    deps.log(`The broker still runs ${health.version ?? installed} with ${health.peers} agent(s) registered; run \`multiagents broker stop\` once they are done and it restarts on ${latest}.`);
  }

  deps.log(`multiagents ${installed} → ${latest} installed. Restart open Claude Code / Codex sessions to pick up the new version.`);
  return { ok: true, action: "updated", kind, installed, latest, command, brokerRestarted };
}

/** The broker's /health within `timeoutMs`; null for no answer, a wedged server, or something that is not the broker. */
export async function probeBrokerHealth(url: string, timeoutMs = 3000): Promise<BrokerHealth | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    return parseBrokerHealth(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function parseBrokerHealth(body: unknown): BrokerHealth | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.status !== "ok" || typeof b.peers !== "number") return null;
  const health: BrokerHealth = { peers: b.peers };
  if (typeof b.pid === "number") health.pid = b.pid;
  if (typeof b.version === "string") health.version = b.version;
  if (Array.isArray(b.features)) health.features = b.features.filter((f): f is string => typeof f === "string");
  return health;
}

/**
 * Pids listening on the port — not the clients connected to it, which
 * `lsof -ti :port` would also list — or null when lsof is unavailable.
 */
export function listeningPids(port: number, opts: { lsof?: string } = {}): string[] | null {
  try {
    const proc = Bun.spawnSync([opts.lsof ?? "lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
    return new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/** Stop the broker: the pid it reported, else whatever listens on the port. Returns the pids signalled. */
export function stopBrokerProcess(health: BrokerHealth, port: number, opts: { lsof?: string } = {}): number[] {
  if (health.pid !== undefined) {
    process.kill(health.pid, "SIGTERM");
    return [health.pid];
  }
  const pids = listeningPids(port, opts);
  if (pids === null) throw new Error("the broker did not report its pid and lsof is not available to find it");
  for (const pid of pids) process.kill(parseInt(pid, 10), "SIGTERM");
  return pids.map((pid) => parseInt(pid, 10));
}

/** Stop the broker listening on the port (it shuts down cleanly on SIGTERM); returns the pids signalled. */
export function stopBrokerOnPort(port: number): string[] {
  const pids = listeningPids(port);
  if (pids === null) throw new Error("lsof is not available, so the broker process cannot be found; stop it by pid instead");
  for (const pid of pids) process.kill(parseInt(pid, 10), "SIGTERM");
  return pids;
}

export function defaultUpdateDeps(): UpdateDeps {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as { version: string };
  return {
    packageRoot,
    installedVersion: pkg.version,
    env: process.env,
    exists: (p) => fs.existsSync(p),
    fetchLatestVersion: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(REGISTRY_LATEST, { signal: controller.signal });
        if (!res.ok) throw new Error(`registry answered ${res.status}`);
        const body = (await res.json()) as { version?: string };
        if (!body.version) throw new Error("registry answer carried no version");
        return body.version;
      } finally {
        clearTimeout(timer);
      }
    },
    run: (cmd) => Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] }).exited,
    brokerHealth: () => probeBrokerHealth(brokerUrl()),
    stopBroker: async (health) => { stopBrokerProcess(health, resolveBrokerPort()); },
    log: (line) => console.log(line),
  };
}

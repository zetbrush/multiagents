import * as fs from "node:fs";

type TomlSection = { head: string; lines: string[] };

function tomlSections(toml: string): TomlSection[] {
  const sections: TomlSection[] = [{ head: "", lines: [] }];
  for (const line of toml.split("\n")) {
    if (line.startsWith("[")) sections.push({ head: line.trim(), lines: [line] });
    else sections.at(-1)!.lines.push(line);
  }
  return sections;
}

const renderToml = (sections: TomlSection[]) => sections.flatMap((s) => s.lines).join("\n");

/**
 * What ~/.codex/config.toml should hold after a live team run. A Codex launch
 * rewrites the launcher's two multiagents servers and Codex itself records the
 * test project (its path contains `runProjectMark`) as trusted. If nothing else
 * changed the backup is returned as is; if the user's Codex wrote to the file
 * meanwhile, their version is kept and only those sections are put back.
 */
export function codexConfigAfterRun(current: string, backup: string, runProjectMark: string): string {
  const touchedByRun = (head: string) =>
    head === '[mcp_servers."multiagents-peer"]' ||
    head === "[mcp_servers.multiagents]" ||
    (head.startsWith('[projects."') && head.includes(runProjectMark));
  const rest = (toml: string) => tomlSections(toml).filter((s) => !touchedByRun(s.head));
  const comparable = (toml: string) => renderToml(rest(toml)).replace(/\n{2,}/g, "\n").trim();

  if (comparable(current) === comparable(backup)) return backup;
  const ours = tomlSections(backup).filter((s) => touchedByRun(s.head));
  return `${renderToml(rest(current)).trimEnd()}\n\n${renderToml(ours).trimEnd()}\n`;
}

export function restoreCodexConfig(configPath: string, backup: string, runProjectMark: string): void {
  const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
  const restored = codexConfigAfterRun(current, backup, runProjectMark);
  if (restored !== current) fs.writeFileSync(configPath, restored);
}

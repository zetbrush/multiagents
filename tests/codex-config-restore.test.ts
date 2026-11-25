/**
 * Restoring ~/.codex/config.toml after a live team run: the launcher rewrites
 * its multiagents sections there and Codex records the test project as trusted,
 * while the user's own Codex may be writing to the same file.
 */

import { test, expect, describe } from "bun:test";
import { codexConfigAfterRun } from "./helpers/codex-config.ts";

const BEFORE = `model = "gpt-test"

[projects."/Users/me/app"]
trust_level = "trusted"

[mcp_servers.figma]
url = "https://example.test/mcp"

[mcp_servers."multiagents-peer"]
command = "bun"
args = ["/Users/me/multiagents/cli.ts", "mcp-server", "--agent-type", "codex"]

[mcp_servers."multiagents-peer".tools.check_messages]
approval_mode = "approve"

[mcp_servers.multiagents]
command = "/Users/me/.bun/bin/bun"
args = ["/Users/me/multiagents/server.ts", "--agent-type", "codex"]
default_tools_approval_mode = "approve"

[features]
memories = true
`;

/** What a Codex launch on a test broker leaves behind (see ensureMcpConfigs and Codex's own trust bookkeeping). */
const AFTER_RUN = `model = "gpt-test"

[projects."/Users/me/app"]
trust_level = "trusted"

[projects."/private/var/folders/x/T/live-agy-codex-AbC123/project"]
trust_level = "trusted"

[mcp_servers.figma]
url = "https://example.test/mcp"

[mcp_servers."multiagents-peer".tools.check_messages]
approval_mode = "approve"

[features]
memories = true

[mcp_servers."multiagents-peer"]
command = "bun"
args = ["/tmp/worktree/cli.ts", "mcp-server", "--agent-type", "codex"]
default_tools_approval_mode = "approve"
env = { MULTIAGENTS_PORT = "17912" }
`;

describe("codexConfigAfterRun", () => {
  test("when only the run touched the file, the backup comes back byte for byte", () => {
    expect(codexConfigAfterRun(AFTER_RUN, BEFORE, "/live-agy-codex-")).toBe(BEFORE);
  });

  test("an untouched file stays as it is", () => {
    expect(codexConfigAfterRun(BEFORE, BEFORE, "/live-agy-codex-")).toBe(BEFORE);
  });

  test("changes the user's Codex made meanwhile are kept, and only the run's sections are put back", () => {
    const concurrent = AFTER_RUN
      .replace('model = "gpt-test"', 'model = "gpt-newer"')
      .replace("[features]", '[projects."/Users/me/other"]\ntrust_level = "trusted"\n\n[features]');

    const restored = codexConfigAfterRun(concurrent, BEFORE, "/live-agy-codex-");

    expect(restored).toContain('model = "gpt-newer"');
    expect(restored).toContain('[projects."/Users/me/other"]');
    expect(restored).toContain('args = ["/Users/me/multiagents/cli.ts", "mcp-server", "--agent-type", "codex"]');
    expect(restored).toContain('args = ["/Users/me/multiagents/server.ts", "--agent-type", "codex"]');
    expect(restored).toContain('[mcp_servers."multiagents-peer".tools.check_messages]');
    expect(restored).not.toContain("/tmp/worktree/cli.ts");
    expect(restored).not.toContain("MULTIAGENTS_PORT");
    expect(restored).not.toContain("live-agy-codex-AbC123");
    expect(restored.match(/^\[mcp_servers\."multiagents-peer"\]$/gm)).toHaveLength(1);
    expect(restored.match(/^\[mcp_servers\.multiagents\]$/gm)).toHaveLength(1);
  });

  test("a file that starts with a table gets no blank line put in front of it", () => {
    const before = `[projects."/Users/me/app"]\ntrust_level = "trusted"\n\n[mcp_servers.multiagents]\ncommand = "multiagents-server"\n`;
    const concurrent = `[projects."/Users/me/app"]\ntrust_level = "trusted"\n\n[projects."/Users/me/other"]\ntrust_level = "trusted"\n\n[mcp_servers."multiagents-peer"]\ncommand = "bun"\n`;

    const restored = codexConfigAfterRun(concurrent, before, "/live-agy-codex-");

    expect(restored.startsWith('[projects."/Users/me/app"]\ntrust_level = "trusted"\n\n[projects."/Users/me/other"]')).toBe(true);
    expect(restored).toContain('[mcp_servers.multiagents]\ncommand = "multiagents-server"');
    expect(restored).not.toContain("multiagents-peer");
  });
});

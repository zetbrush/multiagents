// ============================================================================
// multiagents — Auto-Summary Generation
// ============================================================================
// Generates a brief summary of what a developer is working on using git
// context (branch name, recently modified files). No LLM API calls — fast,
// free, and no hardcoded model names to maintain.
// ============================================================================

export interface SummaryContext {
  cwd: string;
  git_root: string | null;
  git_branch?: string | null;
  recent_files?: string[];
}

/**
 * Generate a 1-2 sentence summary of what the agent is working on.
 * Uses git context only — no external API calls.
 */
export async function generateSummary(
  context: SummaryContext
): Promise<string> {
  const parts: string[] = [];

  if (context.git_branch && context.git_branch !== "main" && context.git_branch !== "master") {
    parts.push(`Branch: ${context.git_branch}`);
  }

  if (context.recent_files?.length) {
    const topFiles = context.recent_files.slice(0, 5).join(", ");
    parts.push(`Files: ${topFiles}`);
  }

  if (parts.length === 0) {
    const dirName = context.cwd.split("/").pop() ?? context.cwd;
    return `Working in ${dirName}`;
  }

  return parts.join(" | ");
}

/** Get the current git branch name */
export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

/** Get recently modified tracked files in the git repo */
export async function getRecentFiles(
  cwd: string,
  limit = 10
): Promise<string[]> {
  try {
    const diffProc = Bun.spawn(["git", "diff", "--name-only", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const diffText = await new Response(diffProc.stdout).text();
    await diffProc.exited;

    const files = diffText
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    if (files.length >= limit) {
      return files.slice(0, limit);
    }

    const logProc = Bun.spawn(
      ["git", "log", "--oneline", "--name-only", "-5", "--format="],
      { cwd, stdout: "pipe", stderr: "ignore" }
    );
    const logText = await new Response(logProc.stdout).text();
    await logProc.exited;

    const logFiles = logText
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    return [...new Set([...files, ...logFiles])].slice(0, limit);
  } catch {
    return [];
  }
}

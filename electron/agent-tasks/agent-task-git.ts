import { foreignGitEnv, gitBinary, runCommand } from "../worktree-manager.ts";

const GIT_TIMEOUT_MS = 15_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const stdout = await runCommand(gitBinary(), args, {
    cwd,
    env: foreignGitEnv(),
    timeoutMs: GIT_TIMEOUT_MS,
    operation: `git ${args[0] ?? ""}`.trim(),
    stdout: "pipe",
  });
  return stdout.trim();
}

/** HEAD commit of a checkout, or null when it has none (or git fails). */
export async function headSha(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "HEAD"])) || null;
  } catch {
    return null;
  }
}

/**
 * Files a task changed in its own worktree: committed since `sinceSha`, plus
 * anything staged, unstaged or untracked now. Sorted and de-duplicated.
 */
export async function changedFiles(cwd: string, sinceSha: string | null): Promise<string[]> {
  const files = new Set<string>();
  if (sinceSha) {
    const committed = await git(cwd, ["diff", "--name-only", `${sinceSha}..HEAD`]);
    for (const line of committed.split("\n")) if (line) files.add(line);
  }
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3);
    // Renames read "old -> new"; the new path is what exists now.
    const arrow = path.indexOf(" -> ");
    files.add(arrow >= 0 ? path.slice(arrow + 4) : path);
  }
  return [...files].sort();
}

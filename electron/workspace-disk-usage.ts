import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceDiskUsage, WorkspaceDiskUsageReport } from "../contracts/storage.ts";
import { listProjects } from "./projects.ts";
import { listWorktrees } from "./worktree-manager.ts";

/**
 * Read-only disk accounting for workspace checkouts (R21). Nothing here
 * deletes or moves files: the report lets the user see which worktrees hold
 * regenerable dependency/build output before deciding what to clean up.
 *
 * The walk is asynchronous, never follows symlinks (a shared `node_modules`
 * symlink is not double counted), skips nested checkouts (worktrees created
 * inside the project root are reported separately) and stops at an entry
 * budget so a huge checkout cannot stall the scan indefinitely.
 */

type Category = "source" | "dependency" | "build";

/**
 * Folders a package manager recreates, across ecosystems: JavaScript, Python
 * virtualenvs, CocoaPods, Bundler, Elixir and Dart. Display-only: nothing is
 * deleted based on these names.
 */
const DEPENDENCY_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "Pods",
  ".bundle",
  "deps",
  ".dart_tool",
  "elm-stuff",
]);
/** Build and tool caches: JS bundlers, Rust/Maven `target`, Swift, Gradle, Python, Elixir. */
const BUILD_DIRS = new Set([
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".turbo",
  ".parcel-cache",
  "coverage",
  ".cache",
  "target",
  ".build",
  "DerivedData",
  ".gradle",
  "_build",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);
/** Git metadata is shared across a project's worktrees; never counted. */
const SKIPPED = new Set([".git"]);
const DEFAULT_ENTRY_BUDGET = 400_000;
/** Directory reads kept in flight at once. */
const CONCURRENCY = 16;

export interface DirectoryUsage {
  sourceBytes: number;
  dependencyBytes: number;
  buildBytes: number;
  fileCount: number;
  truncated: boolean;
}

function categoryFor(parent: Category, name: string): Category {
  if (parent !== "source") return parent;
  if (DEPENDENCY_DIRS.has(name)) return "dependency";
  if (BUILD_DIRS.has(name)) return "build";
  return "source";
}

export async function measureDirectoryUsage(
  root: string,
  options: { entryBudget?: number } = {},
): Promise<DirectoryUsage> {
  const budget = options.entryBudget ?? DEFAULT_ENTRY_BUDGET;
  const usage: DirectoryUsage = {
    sourceBytes: 0,
    dependencyBytes: 0,
    buildBytes: 0,
    fileCount: 0,
    truncated: false,
  };
  let entries = 0;
  const pending: Array<{ dir: string; category: Category }> = [{ dir: root, category: "source" }];

  const visit = async (dir: string, category: Category) => {
    let children: Dirent[];
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable or vanished directory: skip it.
    }
    // A nested checkout (another worktree, repository or submodule) is
    // measured on its own, never as part of the workspace that contains it.
    if (dir !== root && children.some((child) => child.name === ".git")) return;
    for (const child of children) {
      if (entries >= budget) {
        usage.truncated = true;
        return;
      }
      entries += 1;
      if (SKIPPED.has(child.name)) continue;
      const path = join(dir, child.name);
      if (child.isDirectory()) {
        pending.push({ dir: path, category: categoryFor(category, child.name) });
      } else if (child.isFile()) {
        try {
          const { size } = await lstat(path);
          usage.fileCount += 1;
          if (category === "dependency") usage.dependencyBytes += size;
          else if (category === "build") usage.buildBytes += size;
          else usage.sourceBytes += size;
        } catch {
          // Deleted between readdir and lstat.
        }
      }
      // Symlinks and special files are not followed or counted.
    }
  };

  // Read up to CONCURRENCY directories at a time until the tree is done.
  while (pending.length > 0 && !usage.truncated) {
    const batch = pending.splice(0, CONCURRENCY);
    await Promise.all(batch.map(({ dir, category }) => visit(dir, category)));
  }
  return usage;
}

async function measureProjectWorkspaces(project: {
  id: string;
  name: string;
  path: string;
}): Promise<WorkspaceDiskUsage[]> {
  let worktrees;
  try {
    worktrees = await listWorktrees(project.path);
  } catch {
    return []; // Not a Git repository (or Git unavailable): nothing to report.
  }
  const results: WorkspaceDiskUsage[] = [];
  // One checkout at a time keeps the scan's IO pressure bounded.
  for (const worktree of worktrees) {
    const usage = await measureDirectoryUsage(worktree.path);
    results.push({
      projectId: project.id,
      projectName: project.name,
      path: worktree.path,
      name: worktree.workspaceName ?? worktree.branch ?? worktree.path,
      isProjectRoot: worktree.isProjectRoot === true,
      ...usage,
    });
  }
  return results;
}

let inflight: Promise<WorkspaceDiskUsageReport> | null = null;

/** Scan every project's worktrees. Concurrent callers share one scan. */
export function scanWorkspaceDiskUsage(): Promise<WorkspaceDiskUsageReport> {
  inflight ??= (async () => {
    const workspaces: WorkspaceDiskUsage[] = [];
    for (const project of listProjects()) {
      workspaces.push(...(await measureProjectWorkspaces(project)));
    }
    return { workspaces, scannedAt: Date.now() };
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

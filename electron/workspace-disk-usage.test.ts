import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureDirectoryUsage } from "./workspace-disk-usage.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(root: string, path: string, bytes: number) {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, Buffer.alloc(bytes));
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "pipper-usage-"));
  dirs.push(root);
  file(root, "src/index.ts", 100);
  file(root, "README.md", 20);
  file(root, "node_modules/pkg/index.js", 1_000);
  // Build-named folders inside dependencies stay dependencies.
  file(root, "node_modules/pkg/dist/bundle.js", 500);
  file(root, "packages/app/node_modules/lib/index.js", 300);
  file(root, "dist/main.js", 4_000);
  file(root, "packages/app/.next/cache.bin", 700);
  // Shared Git metadata is not this workspace's cost.
  file(root, ".git/objects/pack.bin", 9_999);
  return root;
}

test("splits a workspace into source, dependency and build bytes", async () => {
  expect(await measureDirectoryUsage(workspace())).toEqual({
    sourceBytes: 120,
    dependencyBytes: 1_800,
    buildBytes: 4_700,
    fileCount: 7,
    truncated: false,
  });
});

test("does not follow symlinks into shared directories", async () => {
  const root = workspace();
  const shared = mkdtempSync(join(tmpdir(), "pipper-shared-"));
  dirs.push(shared);
  file(shared, "huge.bin", 50_000);
  symlinkSync(shared, join(root, "linked_modules"));
  expect((await measureDirectoryUsage(root)).sourceBytes).toBe(120);
});

test("does not count a nested worktree as part of its parent", async () => {
  const root = workspace();
  file(root, ".claude/worktrees/feature/.git", 40);
  file(root, ".claude/worktrees/feature/node_modules/big.js", 80_000);
  expect((await measureDirectoryUsage(root)).dependencyBytes).toBe(1_800);
});

test("stops at the entry budget and reports a partial scan", async () => {
  const usage = await measureDirectoryUsage(workspace(), { entryBudget: 3 });
  expect(usage.truncated).toBe(true);
  expect(usage.fileCount).toBeLessThan(7);
});

test("measuring never modifies the workspace", async () => {
  const root = workspace();
  const before = readdirSync(root, { recursive: true }).sort();
  await measureDirectoryUsage(root);
  expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
});

test("recognizes dependency and build folders beyond JavaScript", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipper-usage-"));
  dirs.push(root);
  file(root, "src/main.rs", 50);
  file(root, "target/debug/app", 2_000);
  file(root, ".venv/lib/site.py", 300);
  file(root, "app/__pycache__/mod.pyc", 40);
  file(root, "ios/Pods/Lib/lib.a", 600);
  file(root, ".build/release/tool", 1_000);
  expect(await measureDirectoryUsage(root)).toMatchObject({
    sourceBytes: 50,
    dependencyBytes: 900,
    buildBytes: 3_040,
  });
});

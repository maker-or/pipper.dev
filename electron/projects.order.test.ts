import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: { getPath: () => process.env.PIPPER_LIBRARY_PATH ?? process.env.TMPDIR ?? "/tmp" },
}));

let root: string | null = null;

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), "pipper-project-order-"));
  process.env.PIPPER_LIBRARY_PATH = root;
});

afterEach(async () => {
  const { closeDb } = await import("./db.ts");
  closeDb();
  delete process.env.PIPPER_LIBRARY_PATH;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

const names = (projects: Array<{ name: string }>) => projects.map((project) => project.name);

test("the rail order is saved, survives a restart, and new projects join the end", async () => {
  let projects = await import("./projects.ts");
  const web = projects.createProject({ name: "web", path: "/repo/web", icon: "circle" });
  const api = projects.createProject({ name: "api", path: "/repo/api", icon: "heart" });
  const docs = projects.createProject({ name: "docs", path: "/repo/docs", icon: "gem" });
  expect(names(projects.listProjects())).toEqual(["web", "api", "docs"]);

  expect(names(projects.reorderProjects([docs.id, web.id, api.id]))).toEqual([
    "docs",
    "web",
    "api",
  ]);

  const { closeDb } = await import("./db.ts");
  closeDb();
  vi.resetModules();
  projects = await import("./projects.ts");
  expect(names(projects.listProjects())).toEqual(["docs", "web", "api"]);

  projects.createProject({ name: "blog", path: "/repo/blog", icon: "flower" });
  expect(names(projects.listProjects())).toEqual(["docs", "web", "api", "blog"]);
});

test("an order missing a project keeps it, after the ones that were listed", async () => {
  const projects = await import("./projects.ts");
  const a = projects.createProject({ name: "a", path: "/repo/a", icon: "circle" });
  const b = projects.createProject({ name: "b", path: "/repo/b", icon: "circle" });
  projects.createProject({ name: "c", path: "/repo/c", icon: "circle" });

  // A stale window that never saw "c", plus an id that no longer exists.
  expect(names(projects.reorderProjects([b.id, "gone", a.id, b.id]))).toEqual(["b", "a", "c"]);
});

test("projects from before reordering keep their name order", async () => {
  const legacy = new DatabaseSync(join(root!, "omni.sqlite"));
  legacy.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, icon TEXT);
    INSERT INTO projects VALUES ('p1', '/z', 'zeta', NULL), ('p2', '/a', 'alpha', NULL), ('p3', '/m', 'Mid', NULL);
  `);
  legacy.close();

  const projects = await import("./projects.ts");
  expect(names(projects.listProjects())).toEqual(["alpha", "Mid", "zeta"]);
  projects.createProject({ name: "beta", path: "/b", icon: "circle" });
  expect(names(projects.listProjects())).toEqual(["alpha", "Mid", "zeta", "beta"]);
});

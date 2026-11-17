import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Project } from "../contracts/projects.ts";
import { parseOpenFolderLink, projectForFolder, type OpenFolderDeps } from "./open-folder-link.ts";

function link(url: string): string | null {
  return parseOpenFolderLink(new URL(url));
}

describe("parseOpenFolderLink", () => {
  test("reads an absolute folder, with spaces and a trailing slash", () => {
    expect(link("pipper://open?path=/Users/me/arena")).toBe("/Users/me/arena");
    expect(link("pipper://open/?path=%2FUsers%2Fme%2Fmy%20repo%2F")).toBe("/Users/me/my repo");
  });

  test("ignores other routes, relative paths and missing paths", () => {
    expect(link("pipper://siri/abc")).toBeNull();
    expect(link("pipper://open?path=arena")).toBeNull();
    expect(link("pipper://open")).toBeNull();
    expect(link("https://open?path=/tmp")).toBeNull();
  });
});

describe("projectForFolder", () => {
  let root: string;
  let projects: Project[];
  const deps: OpenFolderDeps = {
    listProjects: () => projects,
    createProject: (input) => {
      const project = { ...input, id: `project-${projects.length}` };
      projects.push(project);
      return project;
    },
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pipper-open-folder-"));
    projects = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("adds a folder once and reopens the same project after", () => {
    const first = projectForFolder(root, deps);
    expect(first.path).toBe(root);
    expect(projectForFolder(root, deps).id).toBe(first.id);
    expect(projects).toHaveLength(1);
  });

  test("matches a project saved with a trailing slash", () => {
    projects.push({ id: "saved", name: "saved", path: `${root}/`, icon: "circle" });
    expect(projectForFolder(root, deps).id).toBe("saved");
    expect(projects).toHaveLength(1);
  });

  test("refuses a missing path or a file, and adds nothing", () => {
    const file = join(root, "notes.txt");
    writeFileSync(file, "");
    expect(() => projectForFolder(join(root, "missing"), deps)).toThrow("Not a folder");
    expect(() => projectForFolder(file, deps)).toThrow("Not a folder");
    expect(projects).toHaveLength(0);
  });
});

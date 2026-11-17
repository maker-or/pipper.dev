import { statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { shapeForSeed, type Project } from "../contracts/projects.ts";

/**
 * `pipper://open?path=<absolute folder>` opens a folder as the active project,
 * the same as picking it in the sidebar. It adds the project when no project
 * has that path yet. It never starts a thread or sends a prompt, so a link
 * from anywhere can at most add a folder to the list.
 *
 * This is the scripted way in for tools that cannot click through the folder
 * picker, such as the ADEMark harness (`open "pipper://open?path=..."`).
 */
export function parseOpenFolderLink(url: URL): string | null {
  if (url.protocol !== "pipper:" || `${url.host}${url.pathname}`.replace(/\/+$/, "") !== "open") {
    return null;
  }
  const raw = url.searchParams.get("path");
  if (!raw || !isAbsolute(raw)) return null;
  return resolve(raw);
}

export interface OpenFolderDeps {
  listProjects: () => Project[];
  createProject: (input: { name: string; path: string; icon: string }) => Project;
}

/** The project for `folder`, added when missing. Throws when it is not a directory. */
export function projectForFolder(folder: string, deps: OpenFolderDeps): Project {
  let isDirectory = false;
  try {
    isDirectory = statSync(folder).isDirectory();
  } catch {
    // Missing or unreadable: reported below.
  }
  if (!isDirectory) throw new Error(`Not a folder: ${folder}`);
  const existing = deps.listProjects().find((project) => resolve(project.path) === folder);
  if (existing) return existing;
  const name = basename(folder) || "Project";
  return deps.createProject({ name, path: folder, icon: shapeForSeed(name) });
}

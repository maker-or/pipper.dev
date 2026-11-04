export interface Project {
  id: string;
  path: string;
  name: string;
  /** The project's shape id (see PROJECT_SHAPES). Older projects may hold a
   *  retired icon name or null; read it through projectShape(). */
  icon: string | null;
}

/** The shapes a project can be marked with, in picker order. */
export const PROJECT_SHAPES = [
  "circle",
  "square",
  "slanted",
  "arch",
  "semicircle",
  "oval",
  "pill",
  "triangle",
  "arrow",
  "fan",
  "diamond",
  "clamshell",
  "pentagon",
  "gem",
  "very-sunny",
  "sunny",
  "cookie-4",
  "cookie-6",
  "cookie-7",
  "cookie-9",
  "cookie-12",
  "clover-4",
  "clover-8",
  "burst",
  "soft-burst",
  "boom",
  "soft-boom",
  "flower",
  "puffy",
  "puffy-diamond",
  "ghost",
  "pixel-circle",
  "pixel-triangle",
  "bun",
  "heart",
] as const;
export type ProjectShapeId = (typeof PROJECT_SHAPES)[number];

export function isProjectShapeId(value: unknown): value is ProjectShapeId {
  return typeof value === "string" && (PROJECT_SHAPES as readonly string[]).includes(value);
}

/** A stable shape for a seed string, for projects created without a choice. */
export function shapeForSeed(seed: string): ProjectShapeId {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PROJECT_SHAPES[hash % PROJECT_SHAPES.length];
}

/** The project's shape: its stored choice, or a stable one picked by id for
 *  projects that predate shapes. */
export function projectShape(project: Pick<Project, "id" | "icon">): ProjectShapeId {
  return isProjectShapeId(project.icon) ? project.icon : shapeForSeed(project.id);
}

export type ProjectFileGitStatus =
  | "added"
  | "deleted"
  | "ignored"
  | "modified"
  | "renamed"
  | "untracked";

export interface ProjectFileTreeSnapshot {
  paths: string[];
  gitStatus: Array<{
    path: string;
    status: ProjectFileGitStatus;
  }>;
}

export type NewProject = Omit<Project, "id">;

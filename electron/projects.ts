import { randomUUID } from "node:crypto";
import type { Project } from "../contracts/projects.ts";
import { getDb } from "./db.ts";

export function listProjects(): Project[] {
  const db = getDb();
  const query = db.prepare("SELECT * FROM projects ORDER BY name ASC");
  return query.all() as unknown as Project[];
}

export function getProject(id: string): Project | null {
  const db = getDb();
  const query = db.prepare("SELECT * FROM projects WHERE id = ?");
  return (query.get(id) as unknown as Project) || null;
}

export function createProject(input: { name: string; path: string; icon: string }): Project {
  const db = getDb();
  const row: Project = {
    id: randomUUID(),
    name: input.name.trim(),
    path: input.path,
    icon: input.icon,
  };

  try {
    const stmt = db.prepare("INSERT INTO projects (id, name, path, icon) VALUES (?, ?, ?, ?)");
    stmt.run(row.id, row.name, row.path, row.icon);
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      throw new Error("A project already exists at this path.");
    }
    throw err;
  }

  return row;
}

export function removeProject(id: string): void {
  const db = getDb();
  const result = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  if (Number(result.changes) === 0) throw new Error("Project not found.");
}

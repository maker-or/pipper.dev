import { randomUUID } from "node:crypto";
import type { Project } from "../contracts/projects.ts";
import { getDb } from "./db.ts";

export function listProjects(): Project[] {
  const db = getDb();
  const query = db.prepare(
    "SELECT id, path, name, icon FROM projects ORDER BY sort_order ASC, name COLLATE NOCASE ASC",
  );
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
    // A new project goes to the end of the rail.
    const stmt = db.prepare(
      `INSERT INTO projects (id, name, path, icon, sort_order)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects))`,
    );
    stmt.run(row.id, row.name, row.path, row.icon);
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      throw new Error("A project already exists at this path.");
    }
    throw err;
  }

  return row;
}

/**
 * Put projects in the given order and return the saved list. Unknown or
 * repeated ids are ignored, and projects the caller didn't list (one added
 * in another window meanwhile) keep their relative order after the rest.
 */
export function reorderProjects(ids: readonly string[]): Project[] {
  const db = getDb();
  const current = listProjects();
  const known = new Set(current.map((project) => project.id));
  const ordered = [...new Set(ids.filter((id) => known.has(id)))];
  const listed = new Set(ordered);
  for (const project of current) if (!listed.has(project.id)) ordered.push(project.id);
  const update = db.prepare("UPDATE projects SET sort_order = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    ordered.forEach((id, index) => update.run(index, id));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return listProjects();
}

export function removeProject(id: string): void {
  const db = getDb();
  const result = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  if (Number(result.changes) === 0) throw new Error("Project not found.");
}

import { randomUUID } from "node:crypto";
import type { Thread, ThreadPage } from "../contracts/threads.ts";
import { getDb } from "./db.ts";

export function listThreads(): Thread[] {
  const db = getDb();
  const query = db.prepare(
    "SELECT * FROM threads ORDER BY last_used_at DESC, created_at DESC, rowid DESC",
  );
  return query.all() as unknown as Thread[];
}

export function listProjectThreads(projectId: string, limit = 10, offset = 0): ThreadPage {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 50));
  const safeOffset = Math.max(0, Math.trunc(offset));
  const query = db.prepare(`
    SELECT *
    FROM threads
    WHERE project_id = ?
    ORDER BY last_used_at DESC, created_at DESC, rowid DESC
    LIMIT ? OFFSET ?
  `);
  const rows = query.all(projectId, safeLimit + 1, safeOffset) as unknown as Thread[];
  const threads = rows.slice(0, safeLimit);
  return {
    threads,
    hasMore: rows.length > safeLimit,
    nextOffset: safeOffset + threads.length,
  };
}

export function getThread(id: string): Thread | null {
  const db = getDb();
  const query = db.prepare("SELECT * FROM threads WHERE id = ?");
  return (query.get(id) as unknown as Thread) || null;
}

export function listThreadsByIds(ids: string[]): Thread[] {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) return [];

  const db = getDb();
  const placeholders = uniqueIds.map(() => "?").join(",");
  const query = db.prepare(`SELECT * FROM threads WHERE id IN (${placeholders})`);
  const rows = query.all(...uniqueIds) as unknown as Thread[];
  const byId = new Map(rows.map((thread) => [thread.id, thread]));
  return uniqueIds.map((id) => byId.get(id)).filter((thread): thread is Thread => Boolean(thread));
}

export function getMaxThreadSortOrder(): number {
  const db = getDb();
  const query = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS maxSortOrder FROM threads");
  const row = query.get() as { maxSortOrder?: number } | undefined;
  return row?.maxSortOrder ?? 0;
}

export function getThreadSortOrder(id: string): number | null {
  const thread = getThread(id);
  if (!thread) return null;
  const order = thread.sort_order;
  return typeof order === "number" ? order : null;
}

export function createThread(
  projectId: string,
  title: string | null,
  agentId: string,
  agentSessionId: string,
  sortOrder?: number,
  worktreePath?: string | null,
): Thread {
  const db = getDb();
  const nextSortOrder = sortOrder ?? getMaxThreadSortOrder() + 1;
  if (sortOrder != null) {
    const shift = db.prepare(
      "UPDATE threads SET sort_order = sort_order + 1 WHERE sort_order >= ?",
    );
    shift.run(sortOrder);
  }
  const now = Date.now();
  const row: Thread = {
    id: randomUUID(),
    project_id: projectId,
    agent_id: agentId,
    agent_session_id: agentSessionId,
    title: title?.trim() || null,
    worktree_path: worktreePath ?? null,
    created_at: now,
    last_used_at: now,
  };
  const stmt = db.prepare(
    `INSERT INTO threads (id, project_id, agent_id, agent_session_id, title, worktree_path, sort_order, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    row.id,
    row.project_id,
    row.agent_id,
    row.agent_session_id,
    row.title,
    row.worktree_path ?? null,
    nextSortOrder,
    row.created_at,
    row.last_used_at,
  );
  return row;
}

export function deleteThread(id: string): void {
  const db = getDb();
  const thread = getThread(id);
  const stmt = db.prepare("DELETE FROM threads WHERE id = ?");
  stmt.run(id);
  const sortOrder = thread && typeof thread.sort_order === "number" ? thread.sort_order : null;
  if (sortOrder != null) {
    const shift = db.prepare("UPDATE threads SET sort_order = sort_order - 1 WHERE sort_order > ?");
    shift.run(sortOrder);
  }
}

export function updateThreadAgentSessionId(id: string, agentSessionId: string): void {
  const db = getDb();
  db.prepare("UPDATE threads SET agent_session_id = ? WHERE id = ?").run(agentSessionId, id);
}

/** Bind a thread to a worktree, or to the project root with null. */
export function updateThreadWorktreePath(id: string, worktreePath: string | null): void {
  getDb().prepare("UPDATE threads SET worktree_path = ? WHERE id = ?").run(worktreePath, id);
}

export function updateThreadTitle(id: string, title: string | null): void {
  const db = getDb();
  const stmt = db.prepare("UPDATE threads SET title = ? WHERE id = ?");
  stmt.run(title?.trim() || null, id);
}

export function touchThread(id: string, timestamp = Date.now()): void {
  const db = getDb();
  const stmt = db.prepare("UPDATE threads SET last_used_at = ? WHERE id = ?");
  stmt.run(timestamp, id);
}

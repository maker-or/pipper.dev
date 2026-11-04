import type { DatabaseSync } from "node:sqlite";

/**
 * Who created which resource. A thread owns what it created and what its child
 * threads created; destructive agent calls on anything else need the user.
 * User actions write no row: a resource without one is the user's, which also
 * covers everything created before this table existed.
 */
export type ProvenanceKind = "workspace";

export function ensureProvenanceSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provenance (
      kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_by_thread TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (kind, resource_id)
    );
  `);
}

export class ProvenanceStore {
  private readonly db: () => DatabaseSync;

  constructor(db: () => DatabaseSync) {
    this.db = db;
  }

  record(kind: ProvenanceKind, resourceId: string, threadId: string, now = Date.now()): void {
    this.db()
      .prepare(
        `INSERT INTO provenance (kind, resource_id, created_by_thread, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (kind, resource_id)
         DO UPDATE SET created_by_thread = excluded.created_by_thread,
                       created_at = excluded.created_at`,
      )
      .run(kind, resourceId, threadId, now);
  }

  /** The thread that created it, or null for the user's. */
  createdBy(kind: ProvenanceKind, resourceId: string): string | null {
    const row = this.db()
      .prepare("SELECT created_by_thread FROM provenance WHERE kind = ? AND resource_id = ?")
      .get(kind, resourceId) as { created_by_thread: string } | undefined;
    return row?.created_by_thread ?? null;
  }

  forget(kind: ProvenanceKind, resourceId: string): void {
    this.db()
      .prepare("DELETE FROM provenance WHERE kind = ? AND resource_id = ?")
      .run(kind, resourceId);
  }
}

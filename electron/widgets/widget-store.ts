import { createHash } from "node:crypto";
import { getDb } from "../db.ts";
import type { InlineWidgetRecord } from "../../contracts/acp.ts";

/**
 * Widgets an agent showed in a thread. The thread's timeline keeps only the
 * `show_widget` tool call; the widget code lives here, keyed by id, so the
 * transcript never carries the markup and widgets survive reloads.
 */
/** Identifies a show_widget call by what it was called with. */
export function widgetInputHash(title: string, code: string): string {
  return createHash("sha256").update(title).update("\0").update(code).digest("hex");
}

export interface WidgetStore {
  insert(widget: InlineWidgetRecord): void;
  /**
   * The widget a show_widget call with this title and code created in this
   * thread, newest first. Matches the original input, so it still finds a
   * widget whose code update_widget later replaced.
   */
  findByInput(threadId: string | null, title: string, code: string): InlineWidgetRecord | null;
  update(id: string, changes: { code: string; summary?: string; updatedAt: number }): boolean;
  get(id: string): InlineWidgetRecord | null;
}

interface WidgetRow {
  id: string;
  thread_id: string | null;
  session_id: string | null;
  title: string;
  summary: string;
  code: string;
  created_at: number;
  updated_at: number;
  input_hash: string | null;
}

function fromRow(row: WidgetRow): InlineWidgetRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    sessionId: row.session_id,
    title: row.title,
    summary: row.summary,
    code: row.code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const sqliteWidgetStore: WidgetStore = {
  insert(widget) {
    getDb()
      .prepare(
        `INSERT INTO inline_widgets (id, thread_id, session_id, title, summary, code, created_at, updated_at, input_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        widget.id,
        widget.threadId,
        widget.sessionId,
        widget.title,
        widget.summary,
        widget.code,
        widget.createdAt,
        widget.updatedAt,
        widgetInputHash(widget.title, widget.code),
      );
  },
  findByInput(threadId, title, code) {
    const hash = widgetInputHash(title, code);
    const rows = getDb()
      .prepare(
        `SELECT * FROM inline_widgets
         WHERE title = ? AND (thread_id = ? OR thread_id IS NULL)
         ORDER BY created_at DESC LIMIT 50`,
      )
      .all(title, threadId) as unknown as WidgetRow[];
    // Rows from before input_hash existed fall back to hashing their code.
    const match = rows.find(
      (row) => (row.input_hash ?? widgetInputHash(row.title, row.code)) === hash,
    );
    return match ? fromRow(match) : null;
  },
  update(id, changes) {
    const result = getDb()
      .prepare(
        `UPDATE inline_widgets SET code = ?, summary = COALESCE(?, summary), updated_at = ?
         WHERE id = ?`,
      )
      .run(changes.code, changes.summary ?? null, changes.updatedAt, id);
    return Number(result.changes) > 0;
  },
  get(id) {
    const row = getDb().prepare("SELECT * FROM inline_widgets WHERE id = ?").get(id) as
      | WidgetRow
      | undefined;
    return row ? fromRow(row) : null;
  },
};

/** In-memory store for tests. */
export function memoryWidgetStore(): WidgetStore {
  const rows = new Map<string, InlineWidgetRecord>();
  const inputHashes = new Map<string, string>();
  return {
    insert(widget) {
      rows.set(widget.id, { ...widget });
      inputHashes.set(widget.id, widgetInputHash(widget.title, widget.code));
    },
    findByInput(threadId, title, code) {
      const hash = widgetInputHash(title, code);
      const match = [...rows.values()]
        .filter(
          (row) => row.title === title && (row.threadId === threadId || row.threadId === null),
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .find((row) => inputHashes.get(row.id) === hash);
      return match ? { ...match } : null;
    },
    update(id, changes) {
      const row = rows.get(id);
      if (!row) return false;
      rows.set(id, {
        ...row,
        code: changes.code,
        summary: changes.summary ?? row.summary,
        updatedAt: changes.updatedAt,
      });
      return true;
    },
    get(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
  };
}

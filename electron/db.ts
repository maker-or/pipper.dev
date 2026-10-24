import { DatabaseSync } from "node:sqlite";
import { app } from "electron";
import { join } from "node:path";
import { ensureThreadSnapshotSchema } from "./thread-snapshot-schema.ts";

let db: DatabaseSync | null = null;

function ensureColumn(table: string, column: string, ddl: string): void {
  const identifierRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!identifierRegex.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  if (!identifierRegex.test(column)) {
    throw new Error(`Invalid column name: ${column}`);
  }

  const ddlPrefix = `ALTER TABLE ${table} ADD COLUMN ${column}`.toLowerCase();
  const normalizedDdl = ddl.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalizedDdl.startsWith(ddlPrefix)) {
    throw new Error(`Invalid DDL statement: ${ddl}`);
  }

  const current = db?.prepare(`PRAGMA table_info(${table})`).all() as
    | Array<{ name: string }>
    | undefined;
  if (!current?.some((row) => row.name === column)) {
    db?.exec(ddl);
  }
}

function columnExists(table: string, column: string): boolean {
  const current = db?.prepare(`PRAGMA table_info(${table})`).all() as
    | Array<{ name: string }>
    | undefined;
  return Boolean(current?.some((row) => row.name === column));
}

/**
 * Legacy installs created `threads` with NOT NULL constraints the current
 * model no longer has (e.g. `title TEXT NOT NULL`, while ACP threads are
 * born untitled and named by the agent later). `CREATE TABLE IF NOT EXISTS`
 * never updates an existing table's constraints, so inserts of a null title
 * fail with "NOT NULL constraint failed: threads.title" on those databases.
 * SQLite can't drop a column constraint in place — rebuild the table once.
 */
function rebuildThreadsTableIfLegacyConstraints(): void {
  if (!db) return;

  const info = db.prepare(`PRAGMA table_info(threads)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  // Columns the app intentionally writes NULL into (or omits on insert).
  const mustBeNullable = new Set([
    "title",
    "worktree_path",
    "sort_order",
    "created_at",
    "last_used_at",
    "session_file",
  ]);
  const needsRebuild = info.some(
    (column) => mustBeNullable.has(column.name) && column.notnull === 1,
  );
  if (!needsRebuild) return;

  // Copy only the canonical columns that exist in the legacy table; legacy
  // extras (e.g. an already-backfilled `session_file`) are dropped with it.
  const canonicalColumns = [
    "id",
    "project_id",
    "agent_id",
    "agent_session_id",
    "title",
    "worktree_path",
    "sort_order",
    "created_at",
    "last_used_at",
  ];
  const copyColumns = canonicalColumns
    .filter((column) => info.some((existing) => existing.name === column))
    .join(", ");

  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE threads_rebuilt (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        title TEXT,
        worktree_path TEXT,
        sort_order INTEGER,
        created_at INTEGER,
        last_used_at INTEGER,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
    `);
    db.exec(`INSERT INTO threads_rebuilt (${copyColumns}) SELECT ${copyColumns} FROM threads;`);
    db.exec("DROP TABLE threads;");
    db.exec("ALTER TABLE threads_rebuilt RENAME TO threads;");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);
      CREATE INDEX IF NOT EXISTS idx_threads_project_last_used
        ON threads(project_id, last_used_at DESC, created_at DESC);
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function migrateThreadsTable(): void {
  if (!db) return;

  // New columns for ACP
  ensureColumn("threads", "agent_id", "ALTER TABLE threads ADD COLUMN agent_id TEXT;");
  ensureColumn(
    "threads",
    "agent_session_id",
    "ALTER TABLE threads ADD COLUMN agent_session_id TEXT;",
  );

  // Worktree binding: which worktree a thread's session runs in (app-only hint;
  // git remains source of truth). Nullable — most threads run in the project root.
  ensureColumn("threads", "worktree_path", "ALTER TABLE threads ADD COLUMN worktree_path TEXT;");

  // Backfill from legacy session_file when present
  if (columnExists("threads", "session_file")) {
    db.exec(`
      UPDATE threads
      SET agent_session_id = COALESCE(agent_session_id, session_file, id),
          agent_id = COALESCE(agent_id, 'legacy-pi')
      WHERE agent_session_id IS NULL OR agent_id IS NULL;
    `);
  } else {
    db.exec(`
      UPDATE threads
      SET agent_session_id = COALESCE(agent_session_id, id),
          agent_id = COALESCE(agent_id, 'pipper-mock')
      WHERE agent_session_id IS NULL OR agent_id IS NULL;
    `);
  }

  // Title may be null in ACP model. Runs after the backfill above so every
  // row has an agent_id/agent_session_id before the rebuilt table (which
  // requires them) copies the data over.
  rebuildThreadsTableIfLegacyConstraints();
  db.exec(`UPDATE threads SET title = NULL WHERE title = '';`);

  // Drop messages table (agent is source of truth)
  db.exec(`DROP TABLE IF EXISTS messages;`);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);
    CREATE INDEX IF NOT EXISTS idx_threads_project_last_used
      ON threads(project_id, last_used_at DESC, created_at DESC);
  `);
}

export function getDb(): DatabaseSync {
  if (db) return db;

  const filePath = join(app.getPath("userData"), "omni.sqlite");
  db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys = ON;");
  // Monitor writes are handled by a dedicated worker connection. WAL allows
  // the main process to read the same database while that writer is active;
  // busy_timeout prevents transient writer contention from surfacing as an
  // application error.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      icon TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      title TEXT,
      sort_order INTEGER,
      created_at INTEGER,
      last_used_at INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);
    CREATE INDEX IF NOT EXISTS idx_threads_project_last_used
      ON threads(project_id, last_used_at DESC, created_at DESC);
  `);

  // Legacy installs may still have old schema; migrate columns
  ensureColumn("threads", "sort_order", "ALTER TABLE threads ADD COLUMN sort_order INTEGER;");
  ensureColumn("threads", "session_file", "ALTER TABLE threads ADD COLUMN session_file TEXT;");
  ensureColumn("threads", "created_at", "ALTER TABLE threads ADD COLUMN created_at INTEGER;");
  ensureColumn("threads", "last_used_at", "ALTER TABLE threads ADD COLUMN last_used_at INTEGER;");
  db.exec("UPDATE threads SET sort_order = rowid WHERE sort_order IS NULL;");
  migrateThreadsTable();

  // A thread snapshot is a display cache, never the source of truth for the
  // agent session. The lean reduced slice stays in SQLite so a tab activation
  // can paint synchronously; tool bodies and large images live in
  // generation-named body files (see thread-snapshot-store.ts).
  ensureThreadSnapshotSchema(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_agent_selections (
      agent_id TEXT PRIMARY KEY,
      selected_at INTEGER NOT NULL
    );
  `);

  // One row per provider instance (account/configuration). The default
  // instance for a driver reuses the driver id as its primary key, so legacy
  // threads and selections resolve unchanged; additional accounts get ids like
  // `codex-acp:work`. `env_json` holds per-instance environment overrides
  // (including credential-root paths such as CODEX_HOME).
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_instances (
      id TEXT PRIMARY KEY,
      driver_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      env_json TEXT,
      config_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_instances_driver ON agent_instances(driver_id);
  `);

  // Small key/value store for app-level pointers that don't deserve a column
  // (e.g. the last-used provider instance).
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Last-known-good GitHub PR data. This is a display cache: local git stays
  // authoritative, while the cached remote slice keeps the workflow panel
  // useful during network/auth outages and across app restarts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_pr_snapshots (
      repository TEXT NOT NULL,
      branch TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (repository, branch)
    );
    CREATE INDEX IF NOT EXISTS idx_github_pr_snapshots_updated_at
      ON github_pr_snapshots(updated_at ASC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport_type TEXT NOT NULL,
      url TEXT,
      command TEXT,
      args TEXT,
      env TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS inline_widgets (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      session_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inline_widgets_thread
      ON inline_widgets(thread_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      provider TEXT NOT NULL,
      provider_user_id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT,
      avatar_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_users_last_seen
      ON auth_users(last_seen_at DESC);
  `);

  db.exec(`
    UPDATE threads
    SET created_at = COALESCE(
      created_at,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000
    ),
    last_used_at = COALESCE(
      last_used_at,
      created_at,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000
    );
  `);

  return db;
}

/**
 * Release the sqlite handle so the next `getDb()` reopens from disk. Windows
 * refuses to unlink a file with a live handle, so tests that delete their temp
 * library must close first — `rmSync(..., { force: true })` only swallows
 * ENOENT, not EBUSY.
 */
export function closeDb(): void {
  db?.close();
  db = null;
}

export interface GithubPrSnapshotRecord {
  snapshotJson: string;
  updatedAt: number;
}

export function getGithubPrSnapshot(
  repository: string,
  branch: string,
): GithubPrSnapshotRecord | null {
  const row = getDb()
    .prepare(
      `SELECT snapshot_json, updated_at
       FROM github_pr_snapshots
       WHERE repository = ? AND branch = ?`,
    )
    .get(repository, branch) as { snapshot_json: string; updated_at: number } | undefined;
  return row ? { snapshotJson: row.snapshot_json, updatedAt: row.updated_at } : null;
}

export function saveGithubPrSnapshot(
  repository: string,
  branch: string,
  snapshotJson: string,
  updatedAt: number,
): void {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO github_pr_snapshots (repository, branch, snapshot_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repository, branch) DO UPDATE SET
         snapshot_json = excluded.snapshot_json,
         updated_at = excluded.updated_at`,
    )
    .run(repository, branch, snapshotJson, updatedAt);
  // Branch names are effectively unbounded over an install's lifetime. Keep
  // enough history for active work without allowing cached comments/bodies to
  // grow the database forever.
  database
    .prepare(
      `DELETE FROM github_pr_snapshots
       WHERE rowid IN (
         SELECT rowid FROM github_pr_snapshots
         ORDER BY updated_at DESC
         LIMIT -1 OFFSET 200
       )`,
    )
    .run();
}

export interface AuthUserRecord {
  provider: string;
  provider_user_id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
}

export function upsertAuthUser(input: {
  provider: string;
  providerUserId: string;
  email?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
}): AuthUserRecord {
  const database = getDb();
  const now = Date.now();
  const existing = database
    .prepare("SELECT * FROM auth_users WHERE provider_user_id = ?")
    .get(input.providerUserId) as AuthUserRecord | undefined;

  const record: AuthUserRecord = {
    provider: input.provider,
    provider_user_id: input.providerUserId,
    email: input.email ?? null,
    name: input.name ?? null,
    avatar_url: input.avatarUrl ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    last_seen_at: now,
  };

  database
    .prepare(
      `INSERT INTO auth_users (
        provider, provider_user_id, email, name, avatar_url, created_at, updated_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_user_id) DO UPDATE SET
        provider = excluded.provider,
        email = excluded.email,
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at`,
    )
    .run(
      record.provider,
      record.provider_user_id,
      record.email,
      record.name,
      record.avatar_url,
      record.created_at,
      record.updated_at,
      record.last_seen_at,
    );

  return record;
}

export function getAuthUser(providerUserId: string): AuthUserRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM auth_users WHERE provider_user_id = ?")
    .get(providerUserId) as AuthUserRecord | undefined;
  return row ?? null;
}

export function getSelectedAgentIds(): string[] {
  const rows = getDb()
    .prepare("SELECT agent_id FROM user_agent_selections ORDER BY selected_at ASC")
    .all() as Array<{ agent_id: string }>;
  return rows.map((r) => r.agent_id);
}

export function setSelectedAgentIds(agentIds: string[]): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare("DELETE FROM user_agent_selections").run();
    const stmt = db.prepare(
      "INSERT INTO user_agent_selections (agent_id, selected_at) VALUES (?, ?)",
    );
    const now = Date.now();
    for (const id of agentIds) {
      stmt.run(id, now);
    }
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Transaction may already have been rolled back by SQLite.
    }
    throw error;
  }
}

export function getMostRecentAuthUser(): AuthUserRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM auth_users ORDER BY last_seen_at DESC LIMIT 1")
    .get() as AuthUserRecord | undefined;
  return row ?? null;
}

export function getAppSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

export function setAppSetting(key: string, value: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

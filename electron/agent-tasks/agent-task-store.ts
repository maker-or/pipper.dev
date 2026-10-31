import type { DatabaseSync } from "node:sqlite";
import type {
  AgentTaskOutcome,
  AgentTaskStatus,
  AgentTaskWorkspaceMode,
  ThreadProposalSnapshot,
} from "../../contracts/agent-tasks.ts";
import { parseNextStep, type NextStep } from "../../contracts/next-step.ts";

/**
 * Durable task rows. A task's transcript lives in its child thread like any
 * other thread; this table holds only what makes it a task: who started it,
 * where it works, its status and the last receipt facts.
 *
 * `child_thread_id` has no foreign key: a deleted child thread leaves the row
 * (marked cancelled by the service) so the parent can still list what happened.
 */
export function ensureAgentTaskSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      request_key TEXT,
      status TEXT NOT NULL,
      outcome TEXT,
      workspace_mode TEXT NOT NULL,
      workspace_path TEXT,
      branch TEXT,
      created_workspace INTEGER NOT NULL DEFAULT 0,
      start_sha TEXT,
      depth INTEGER NOT NULL,
      turns INTEGER NOT NULL DEFAULT 0,
      report TEXT,
      next_step TEXT,
      stop_reason TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent
      ON agent_tasks(parent_thread_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_child
      ON agent_tasks(child_thread_id) WHERE child_thread_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_request_key
      ON agent_tasks(parent_thread_id, request_key) WHERE request_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS thread_proposals (
      id TEXT PRIMARY KEY,
      caller_thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      task TEXT NOT NULL,
      model TEXT,
      workspace TEXT NOT NULL,
      install_dependencies INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      thread_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const columns = db.prepare("PRAGMA table_info(agent_tasks)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "next_step")) {
    db.exec("ALTER TABLE agent_tasks ADD COLUMN next_step TEXT;");
  }
}

export interface AgentTaskRow {
  id: string;
  parentThreadId: string;
  childThreadId: string | null;
  projectId: string;
  agentId: string;
  title: string;
  brief: string;
  requestKey: string | null;
  status: AgentTaskStatus;
  outcome: AgentTaskOutcome | null;
  workspaceMode: AgentTaskWorkspaceMode;
  workspacePath: string | null;
  branch: string | null;
  createdWorkspace: boolean;
  startSha: string | null;
  depth: number;
  turns: number;
  report: string | null;
  /** The last settled turn's wrap_up, if it called one. */
  nextStep: NextStep | null;
  stopReason: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

type NewAgentTask = Omit<
  AgentTaskRow,
  "turns" | "report" | "nextStep" | "stopReason" | "error" | "outcome" | "createdAt" | "updatedAt"
>;

export type AgentTaskPatch = Partial<
  Pick<
    AgentTaskRow,
    | "childThreadId"
    | "status"
    | "outcome"
    | "workspacePath"
    | "branch"
    | "createdWorkspace"
    | "startSha"
    | "turns"
    | "report"
    | "nextStep"
    | "stopReason"
    | "error"
  >
>;

const COLUMNS: Record<keyof AgentTaskPatch, string> = {
  childThreadId: "child_thread_id",
  status: "status",
  outcome: "outcome",
  workspacePath: "workspace_path",
  branch: "branch",
  createdWorkspace: "created_workspace",
  startSha: "start_sha",
  turns: "turns",
  report: "report",
  nextStep: "next_step",
  stopReason: "stop_reason",
  error: "error",
};

interface RawRow {
  id: string;
  parent_thread_id: string;
  child_thread_id: string | null;
  project_id: string;
  agent_id: string;
  title: string;
  brief: string;
  request_key: string | null;
  status: string;
  outcome: string | null;
  workspace_mode: string;
  workspace_path: string | null;
  branch: string | null;
  created_workspace: number;
  start_sha: string | null;
  depth: number;
  turns: number;
  report: string | null;
  next_step: string | null;
  stop_reason: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function fromRaw(raw: RawRow): AgentTaskRow {
  return {
    id: raw.id,
    parentThreadId: raw.parent_thread_id,
    childThreadId: raw.child_thread_id,
    projectId: raw.project_id,
    agentId: raw.agent_id,
    title: raw.title,
    brief: raw.brief,
    requestKey: raw.request_key,
    status: raw.status as AgentTaskStatus,
    outcome: raw.outcome as AgentTaskOutcome | null,
    workspaceMode: raw.workspace_mode as AgentTaskWorkspaceMode,
    workspacePath: raw.workspace_path,
    branch: raw.branch,
    createdWorkspace: raw.created_workspace === 1,
    startSha: raw.start_sha,
    depth: raw.depth,
    turns: raw.turns,
    report: raw.report,
    nextStep: readNextStep(raw.next_step),
    stopReason: raw.stop_reason,
    error: raw.error,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export class AgentTaskStore {
  private readonly db: () => DatabaseSync;

  constructor(db: () => DatabaseSync) {
    this.db = db;
  }

  insert(task: NewAgentTask, now = Date.now()): AgentTaskRow {
    this.db()
      .prepare(
        `INSERT INTO agent_tasks (id, parent_thread_id, child_thread_id, project_id, agent_id,
           title, brief, request_key, status, workspace_mode, workspace_path, branch,
           created_workspace, start_sha, depth, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.parentThreadId,
        task.childThreadId,
        task.projectId,
        task.agentId,
        task.title,
        task.brief,
        task.requestKey,
        task.status,
        task.workspaceMode,
        task.workspacePath,
        task.branch,
        task.createdWorkspace ? 1 : 0,
        task.startSha,
        task.depth,
        now,
        now,
      );
    return this.get(task.id)!;
  }

  update(id: string, patch: AgentTaskPatch, now = Date.now()): AgentTaskRow | null {
    const keys = Object.keys(patch) as Array<keyof AgentTaskPatch>;
    if (keys.length > 0) {
      const sets = keys.map((key) => `${COLUMNS[key]} = ?`).join(", ");
      const values = keys.map((key) => {
        const value = patch[key];
        if (key === "nextStep") return value ? JSON.stringify(value) : null;
        return typeof value === "boolean" ? (value ? 1 : 0) : ((value as string | number) ?? null);
      });
      this.db()
        .prepare(`UPDATE agent_tasks SET ${sets}, updated_at = ? WHERE id = ?`)
        .run(...values, now, id);
    }
    return this.get(id);
  }

  get(id: string): AgentTaskRow | null {
    const raw = this.db().prepare("SELECT * FROM agent_tasks WHERE id = ?").get(id) as
      | RawRow
      | undefined;
    return raw ? fromRaw(raw) : null;
  }

  byChildThread(childThreadId: string): AgentTaskRow | null {
    const raw = this.db()
      .prepare("SELECT * FROM agent_tasks WHERE child_thread_id = ?")
      .get(childThreadId) as RawRow | undefined;
    return raw ? fromRaw(raw) : null;
  }

  byRequestKey(parentThreadId: string, requestKey: string): AgentTaskRow | null {
    const raw = this.db()
      .prepare("SELECT * FROM agent_tasks WHERE parent_thread_id = ? AND request_key = ?")
      .get(parentThreadId, requestKey) as RawRow | undefined;
    return raw ? fromRaw(raw) : null;
  }

  listForParent(parentThreadId: string, limit = 50): AgentTaskRow[] {
    return (
      this.db()
        .prepare(
          "SELECT * FROM agent_tasks WHERE parent_thread_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(parentThreadId, limit) as unknown as RawRow[]
    ).map(fromRaw);
  }

  listActive(): AgentTaskRow[] {
    return (
      this.db()
        .prepare("SELECT * FROM agent_tasks WHERE status IN ('starting', 'running')")
        .all() as unknown as RawRow[]
    ).map(fromRaw);
  }

  /** The most recent tasks, for the renderer's nesting and status chips. */
  listRecent(limit = 200): AgentTaskRow[] {
    return (
      this.db()
        .prepare("SELECT * FROM agent_tasks ORDER BY updated_at DESC LIMIT ?")
        .all(limit) as unknown as RawRow[]
    ).map(fromRaw);
  }

  /** Rows left starting/running by a previous process can't still be running. */
  markInterrupted(now = Date.now()): number {
    const result = this.db()
      .prepare(
        `UPDATE agent_tasks SET status = 'interrupted', updated_at = ?
         WHERE status IN ('starting', 'running')`,
      )
      .run(now);
    return Number(result.changes);
  }

  delete(id: string): void {
    this.db().prepare("DELETE FROM agent_tasks WHERE id = ?").run(id);
  }
}

/** Proposals nobody answered stop offering Start after this long. */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60_000;

interface RawProposal {
  id: string;
  caller_thread_id: string;
  project_id: string;
  agent_id: string;
  title: string;
  task: string;
  model: string | null;
  workspace: string;
  install_dependencies: number;
  state: string;
  thread_id: string | null;
  created_at: number;
}

/**
 * Threads agents proposed for the user to start. The row is the card's
 * state: open until the user starts or dismisses it, or a week passes.
 */
export class ThreadProposalStore {
  private readonly db: () => DatabaseSync;

  constructor(db: () => DatabaseSync) {
    this.db = db;
  }

  insert(
    proposal: Omit<ThreadProposalSnapshot, "state" | "threadId" | "createdAt">,
    now = Date.now(),
  ): ThreadProposalSnapshot {
    this.db()
      .prepare(
        `INSERT INTO thread_proposals (id, caller_thread_id, project_id, agent_id, title, task,
           model, workspace, install_dependencies, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        proposal.proposalId,
        proposal.callerThreadId,
        proposal.projectId,
        proposal.agentId,
        proposal.title,
        proposal.task,
        proposal.model,
        proposal.workspace,
        proposal.installDependencies ? 1 : 0,
        now,
        now,
      );
    return this.get(proposal.proposalId, now)!;
  }

  get(id: string, now = Date.now()): ThreadProposalSnapshot | null {
    const raw = this.db().prepare("SELECT * FROM thread_proposals WHERE id = ?").get(id) as
      | RawProposal
      | undefined;
    return raw ? proposalFromRaw(raw, now) : null;
  }

  /** Move an open proposal on; false when someone answered it first. */
  settle(id: string, state: "started" | "dismissed", threadId: string | null, now = Date.now()) {
    const result = this.db()
      .prepare(
        `UPDATE thread_proposals SET state = ?, thread_id = ?, updated_at = ?
         WHERE id = ? AND state = 'open'`,
      )
      .run(state, threadId, now, id);
    return Number(result.changes) > 0;
  }

  attachThread(id: string, threadId: string, now = Date.now()): void {
    this.db()
      .prepare(`UPDATE thread_proposals SET thread_id = ?, updated_at = ? WHERE id = ?`)
      .run(threadId, now, id);
  }

  /** Hand an open proposal back after a start that failed. */
  reopen(id: string, now = Date.now()): void {
    this.db()
      .prepare(`UPDATE thread_proposals SET state = 'open', updated_at = ? WHERE id = ?`)
      .run(now, id);
  }
}

function proposalFromRaw(raw: RawProposal, now: number): ThreadProposalSnapshot {
  const expired = raw.state === "open" && now - raw.created_at > PROPOSAL_TTL_MS;
  return {
    proposalId: raw.id,
    callerThreadId: raw.caller_thread_id,
    projectId: raw.project_id,
    agentId: raw.agent_id,
    title: raw.title,
    task: raw.task,
    model: raw.model,
    workspace: raw.workspace,
    installDependencies: raw.install_dependencies === 1,
    state: expired ? "expired" : (raw.state as ThreadProposalSnapshot["state"]),
    threadId: raw.thread_id,
    createdAt: raw.created_at,
  };
}

function readNextStep(json: string | null): NextStep | null {
  if (!json) return null;
  try {
    const parsed = parseNextStep(JSON.parse(json));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

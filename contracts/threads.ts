export interface Thread {
  id: string;
  project_id: string;
  /**
   * Which ACP provider instance owns this thread — the spawn routing key.
   * Equals the driver id for a driver's default account, or an instance id
   * (e.g. "codex-acp:work") for an additional account.
   */
  agent_id: string;
  /** ACP session.id from session/new (or session/resume). */
  agent_session_id: string;
  /** Nullable until agent sends session_info_update. */
  title: string | null;
  /**
   * Absolute path to the git worktree this thread's session is bound to, or
   * null to run in the project root. App-only state git can't hold; git remains
   * the source of truth for worktrees themselves, so this is only a hint that
   * is validated on bind (a stale path falls back to the project root).
   */
  worktree_path?: string | null;
  sort_order?: number | null;
  created_at: number;
  last_used_at: number;
}

export type NewThread = Omit<Thread, "id">;

export interface ThreadPage {
  threads: Thread[];
  hasMore: boolean;
  nextOffset: number;
}

/** What moving a thread to another workspace did. */
export interface ThreadMoveResult {
  /** "after_turn": the thread is mid-turn; the move lands when the turn ends. */
  status: "moved" | "after_turn" | "unchanged";
  /** The target workspace's name ("main" for the project root). */
  workspace: string;
  /** The directory the thread runs in from its next turn. */
  cwd: string;
  /** Files with uncommitted changes left in the old workspace. */
  leftBehind: string[];
}

export interface OpenTabsState {
  openThreadIds: string[];
  activeThreadId: string | null;
  threadSwitchHistory: string[];
}

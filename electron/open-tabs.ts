import type { BrowserWindow } from "electron";
import type { OpenTabsState } from "../contracts/threads.ts";
import type { MonitorTabEvent } from "../contracts/monitor.ts";
import { isActivationSuperseded } from "./activation.ts";
import {
  applyNavigationCommit,
  mutateLaunchState,
  readLaunchState,
  type LaunchState,
} from "./launch-state.ts";

const MAX_HISTORY = 100;

let tabEventObserver: ((event: MonitorTabEvent) => void) | null = null;

/**
 * Register a sink for every open-tab-set mutation. The monitor service uses
 * this to durably record open / close / activate transitions so a switch can
 * be correlated with the exact tab-count change that preceded it.
 */
export function setTabEventObserver(observer: ((event: MonitorTabEvent) => void) | null): void {
  tabEventObserver = observer;
}

function notifyTabEvent(
  action: MonitorTabEvent["action"],
  threadId: string,
  state: OpenTabsState,
): void {
  tabEventObserver?.({
    timestamp: Date.now(),
    action,
    threadId,
    openTabCount: state.openThreadIds.length,
    activeThreadId: state.activeThreadId,
  });
}

function compactIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)));
}

/**
 * Ensures `threadId` is present in `ids`. A thread that isn't open yet is
 * inserted at the front (leftmost tab) — that's where a reopened or
 * newly-created thread should land. A thread that's already open keeps its
 * existing position rather than jumping to the front.
 */
function ensureThreadIdAtFront(ids: string[], threadId: string): string[] {
  return ids.includes(threadId) ? ids : [threadId, ...ids];
}

/**
 * Picks the tab that should become active after closing `closedThreadId`,
 * which was the active tab. Preference order: the most-recently-used
 * still-open thread (from `threadSwitchHistory`), then the tab that was to
 * its right, then the tab that was to its left, then whatever remains.
 */
function pickNextActiveThreadId(
  openThreadIdsBeforeClose: string[],
  openThreadIdsAfterClose: string[],
  closedThreadId: string,
  threadSwitchHistory: string[],
): string | null {
  if (openThreadIdsAfterClose.length === 0) return null;

  const remaining = new Set(openThreadIdsAfterClose);
  const mru = threadSwitchHistory.find((id) => id !== closedThreadId && remaining.has(id));
  if (mru) return mru;

  const closedIndex = openThreadIdsBeforeClose.indexOf(closedThreadId);
  const rightNeighbor = openThreadIdsBeforeClose[closedIndex + 1];
  if (rightNeighbor && remaining.has(rightNeighbor)) return rightNeighbor;

  const leftNeighbor = openThreadIdsBeforeClose[closedIndex - 1];
  if (leftNeighbor && remaining.has(leftNeighbor)) return leftNeighbor;

  return openThreadIdsAfterClose[0] ?? null;
}

/** Ids from `ids` that still name a thread, or null to keep every id. */
let liveThreadIds: ((ids: string[]) => Set<string>) | null = null;

/**
 * Register the check for which threads still exist. Tabs and history for a
 * deleted thread are then dropped on every read and write: a thread removed
 * without closing its tab (bulk cleanup, benchmark runs, older builds) would
 * otherwise stay open and become the fallback when a neighbouring tab closes,
 * and switching to it fails with "Thread not found".
 */
export function setLiveThreadIdsCheck(check: ((ids: string[]) => Set<string>) | null): void {
  liveThreadIds = check;
}

function dropDeletedThreads(openThreadIds: string[], history: string[]): [string[], string[]] {
  if (!liveThreadIds) return [openThreadIds, history];
  let live: Set<string>;
  try {
    live = liveThreadIds([...openThreadIds, ...history]);
  } catch (error) {
    // Never close tabs because the lookup failed.
    console.warn("[open-tabs] Could not check which tabs still have threads:", error);
    return [openThreadIds, history];
  }
  return [openThreadIds.filter((id) => live.has(id)), history.filter((id) => live.has(id))];
}

function normalize(state: OpenTabsState): OpenTabsState {
  const [openThreadIds, history] = dropDeletedThreads(
    compactIds(state.openThreadIds),
    compactIds(state.threadSwitchHistory).slice(0, MAX_HISTORY),
  );
  return {
    openThreadIds,
    activeThreadId:
      state.activeThreadId && openThreadIds.includes(state.activeThreadId)
        ? state.activeThreadId
        : (openThreadIds[0] ?? null),
    threadSwitchHistory: history,
  };
}

function tabsOf(state: LaunchState): OpenTabsState {
  return normalize({
    openThreadIds: state.openThreadIds,
    activeThreadId: state.activeThreadId ?? state.threadId,
    threadSwitchHistory: state.threadSwitchHistory,
  });
}

function withTabs(current: LaunchState, next: OpenTabsState): LaunchState {
  const normalized = normalize(next);
  return {
    ...current,
    threadId: normalized.activeThreadId,
    openThreadIds: normalized.openThreadIds,
    activeThreadId: normalized.activeThreadId,
    threadSwitchHistory: normalized.threadSwitchHistory,
  };
}

export async function readOpenTabsState(): Promise<OpenTabsState> {
  return tabsOf(await readLaunchState());
}

/**
 * Every open-tabs read-modify-write goes through the shared launch-state
 * mutation queue (see launch-state.ts): `tabs:open`, `tabs:close`,
 * `tabs:setActive`, `agent:switchThread`, and workspace selection updates are
 * independent IPC handlers that the renderer can fire concurrently, and they
 * all persist into the same launch-state.json. `update` returns the next tab
 * set; the result is the committed tab set after one write at most.
 */
async function mutateOpenTabs(
  update: (current: OpenTabsState) => OpenTabsState,
): Promise<{ previous: OpenTabsState; next: OpenTabsState }> {
  let previous: OpenTabsState | null = null;
  const committed = await mutateLaunchState((current) => {
    previous = tabsOf(current);
    return withTabs(current, update(previous));
  });
  return { previous: previous!, next: tabsOf(committed) };
}

export function broadcastOpenTabsChanged(window: BrowserWindow | null, state: OpenTabsState): void {
  if (window?.isDestroyed() === false) {
    window.webContents.send("tabs:changed", state);
  }
}

export async function openThreadTab(threadId: string): Promise<OpenTabsState> {
  const { next } = await mutateOpenTabs((current) => ({
    ...current,
    openThreadIds: ensureThreadIdAtFront(current.openThreadIds, threadId),
    activeThreadId: threadId,
  }));
  notifyTabEvent("open", threadId, next);
  return next;
}

/**
 * Close a thread tab. When `isPeer` is provided (same project + workspace as
 * the closed thread), the next active tab is chosen among peers first so
 * closing a tab never yanks the user into another workspace; only when the
 * closed tab was the workspace's last one does selection fall back to any
 * remaining tab.
 */
export async function closeThreadTab(
  threadId: string,
  isPeer?: (threadId: string) => boolean,
): Promise<OpenTabsState> {
  const { next } = await mutateOpenTabs((current) => {
    const openThreadIds = current.openThreadIds.filter((id) => id !== threadId);
    let activeThreadId = current.activeThreadId;
    if (current.activeThreadId === threadId) {
      const peerIds = isPeer ? openThreadIds.filter(isPeer) : openThreadIds;
      activeThreadId = pickNextActiveThreadId(
        current.openThreadIds,
        peerIds.length > 0 ? peerIds : openThreadIds,
        threadId,
        current.threadSwitchHistory,
      );
    }
    return { ...current, openThreadIds, activeThreadId };
  });
  notifyTabEvent("close", threadId, next);
  return next;
}

/** The part of the agent manager that activates a tab after a close. */
export interface TabActivator {
  getState(): { threadId: string | null };
  switchThread(threadId: string): Promise<unknown>;
  clearActiveThread(): Promise<void>;
}

/**
 * Activate the tab that took over from a closed or deleted one. The close is
 * already persisted, so a failed activation is logged instead of thrown:
 * throwing would skip the tabs broadcast and leave the closed tab on screen.
 * The renderer selects the new active tab itself and reports any error there.
 */
export async function activateTabAfterClose(
  activator: TabActivator,
  next: OpenTabsState,
): Promise<void> {
  try {
    if (!next.activeThreadId) {
      await activator.clearActiveThread();
    } else if (activator.getState().threadId !== next.activeThreadId) {
      await activator.switchThread(next.activeThreadId);
    }
  } catch (error) {
    if (!isActivationSuperseded(error)) {
      console.warn("[open-tabs] Could not activate the next tab after a close:", error);
    }
  }
}

/**
 * Drop several tabs in one persisted write — used when a workspace is deleted
 * and every thread bound to it goes with it. Atomic on purpose: closing them
 * one by one can leave a stale ID on disk when a middle write fails, and that
 * ID would resurface as a tab bound to a missing worktree after restart.
 * The next active tab is chosen with the same rules as a single close.
 */
export async function removeThreadTabs(threadIds: string[]): Promise<OpenTabsState> {
  const removed = new Set(threadIds);
  const { previous, next } = await mutateOpenTabs((current) => {
    const openThreadIds = current.openThreadIds.filter((id) => !removed.has(id));
    const threadSwitchHistory = current.threadSwitchHistory.filter((id) => !removed.has(id));
    let activeThreadId = current.activeThreadId;
    if (activeThreadId && removed.has(activeThreadId)) {
      activeThreadId = pickNextActiveThreadId(
        current.openThreadIds,
        openThreadIds,
        activeThreadId,
        threadSwitchHistory,
      );
    }
    return { openThreadIds, activeThreadId, threadSwitchHistory };
  });
  for (const id of threadIds) {
    if (previous.openThreadIds.includes(id)) notifyTabEvent("close", id, next);
  }
  return next;
}

export async function setActiveThreadTab(threadId: string | null): Promise<OpenTabsState> {
  const { previous, next } = await mutateOpenTabs((current) =>
    threadId
      ? {
          ...current,
          openThreadIds: ensureThreadIdAtFront(current.openThreadIds, threadId),
          activeThreadId: threadId,
        }
      : { ...current, activeThreadId: null },
  );
  notifyTabEvent("activate", threadId ?? previous.activeThreadId ?? "", next);
  return next;
}

function switchedTabs(current: OpenTabsState, threadId: string): OpenTabsState {
  return {
    openThreadIds: ensureThreadIdAtFront(current.openThreadIds, threadId),
    activeThreadId: threadId,
    threadSwitchHistory: [threadId, ...current.threadSwitchHistory.filter((id) => id !== threadId)],
  };
}

export async function recordThreadSwitch(threadId: string): Promise<OpenTabsState> {
  const { next } = await mutateOpenTabs((current) => switchedTabs(current, threadId));
  notifyTabEvent("activate", threadId, next);
  return next;
}

export interface ThreadNavigation {
  projectId: string;
  threadId: string;
  /** The thread's workspace, persisted as the project's canonical selection. */
  workspacePath: string | null;
}

/**
 * Commit a thread activation — project, active thread, workspace selection,
 * open tab and MRU history — as one atomic launch-state write. Returns the
 * committed tab set and the full authoritative state (with its revision).
 */
export async function commitThreadNavigation(
  navigation: ThreadNavigation,
): Promise<{ tabs: OpenTabsState; state: LaunchState }> {
  const state = await mutateLaunchState((current) =>
    withTabs(
      applyNavigationCommit(current, {
        projectId: navigation.projectId,
        workspace: { projectId: navigation.projectId, path: navigation.workspacePath },
      }),
      switchedTabs(tabsOf(current), navigation.threadId),
    ),
  );
  const tabs = tabsOf(state);
  notifyTabEvent("activate", navigation.threadId, tabs);
  return { tabs, state };
}

import { create } from "zustand";

export interface TerminalSession {
  id: string;
  title: string;
  cwd?: string;
  /** Thread this terminal was created from; its tab renders left of that thread. */
  anchorThreadId?: string | null;
  status: "starting" | "running" | "exited" | "error";
  exitCode?: number;
  exitSignal?: number;
  history: string;
}

const MAX_HISTORY_CHARS = 200_000;

interface PlainHistoryResult {
  text: string;
  remainder: string;
}

/**
 * Scrollback is recovery data, not a serialized VT state. Remove terminal
 * control sequences before retaining it so remounting a terminal view can
 * never start replay in the middle of an ANSI/OSC sequence.
 */
export function toPlainTerminalHistory(value: string): string {
  return stripTerminalControls(value).text;
}

function stripTerminalControls(value: string): PlainHistoryResult {
  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const sequenceStart = index;
      const sequenceType = value[index + 1];
      if (sequenceType === undefined) {
        return { text: result, remainder: value.slice(index) };
      }
      index += 1;

      if (sequenceType === "[") {
        let complete = false;
        while (index + 1 < value.length) {
          const nextCode = value.charCodeAt(index + 1);
          index += 1;
          if (nextCode >= 0x40 && nextCode <= 0x7e) {
            complete = true;
            break;
          }
        }
        if (!complete) return { text: result, remainder: value.slice(sequenceStart) };
      } else if (sequenceType === "]" || sequenceType === "P") {
        let complete = false;
        while (index + 1 < value.length) {
          const nextCode = value.charCodeAt(index + 1);
          index += 1;
          if (nextCode === 0x07) {
            complete = true;
            break;
          }
          if (nextCode === 0x1b && value[index + 1] === "\\") {
            index += 1;
            complete = true;
            break;
          }
        }
        if (!complete) return { text: result, remainder: value.slice(sequenceStart) };
      } else {
        const sequenceTypeCode = sequenceType?.charCodeAt(0) ?? 0;
        if (sequenceTypeCode < 0x30 || sequenceTypeCode > 0x7e) {
          while (index + 1 < value.length) {
            const nextCode = value.charCodeAt(index + 1);
            index += 1;
            if (nextCode >= 0x30 && nextCode <= 0x7e) break;
          }
        }
      }
      continue;
    }

    if (code === 0x0d && value.charCodeAt(index + 1) !== 0x0a) continue;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      continue;
    }
    result += value[index];
  }

  return { text: result, remainder: "" };
}

export function appendBoundedTerminalHistory(history: string, data: string): string {
  const combined = history + toPlainTerminalHistory(data);
  if (combined.length <= MAX_HISTORY_CHARS) return combined;

  const target = combined.length - MAX_HISTORY_CHARS;
  const nextLine = combined.indexOf("\n", target);
  return combined.slice(nextLine >= 0 ? nextLine + 1 : target);
}

/** Bucket identity for terminal sessions: one bucket per (project, workspace). */
export function makeWorkspaceKey(projectId: string, workspacePath: string): string {
  return `${projectId}\u0000${workspacePath}`;
}

interface TerminalState {
  sessions: TerminalSession[];
  historyControlRemainders: Record<string, string>;
  /** Which (project, workspace) bucket the visible sessions belong to. */
  workspaceKey: string | null;
  /** Live sessions of workspaces outside the current view. Their PTYs keep running. */
  stashByWorkspace: Record<string, TerminalSession[]>;
  nextSessionNumber: number;
  /** Changes only when tab metadata changes, never for ordinary PTY output. */
  tabsRevision: number;
  listenerInitialized: boolean;
  createSession: (cwd?: string, anchorThreadId?: string | null) => string;
  closeSession: (id: string) => string | null;
  clearSessions: () => void;
  /** Stop and forget every terminal owned by a deleted workspace. */
  closeWorkspace: (key: string) => string[];
  /**
   * Enter a workspace's terminal bucket without stopping any PTYs. Move the
   * previous workspace's sessions into the background and bring the target's
   * original sessions back into view. Returns its first session id, or null.
   */
  setWorkspace: (key: string, cwd: string) => string | null;
  appendHistory: (id: string, data: string) => void;
  markRunning: (id: string) => void;
  markError: (id: string) => void;
  initializeGlobalListener: () => void;
}

/** Both shells render this list so terminal cores stay mounted while hidden. */
export function getAllTerminalSessions(
  state: Pick<TerminalState, "sessions" | "stashByWorkspace">,
): TerminalSession[] {
  return [...state.sessions, ...Object.values(state.stashByWorkspace).flat()];
}

/** Route process events to their owner even when that workspace is in the background. */
function updateTerminalSession(
  state: TerminalState,
  id: string,
  update: (session: TerminalSession) => TerminalSession,
): Partial<TerminalState> {
  const updateBucket = (sessions: TerminalSession[]): TerminalSession[] | null => {
    const index = sessions.findIndex((session) => session.id === id);
    if (index < 0) return null;
    const nextSession = update(sessions[index]);
    if (nextSession === sessions[index]) return null;
    const next = [...sessions];
    next[index] = nextSession;
    return next;
  };
  const sessions = updateBucket(state.sessions);
  if (sessions) return { sessions };
  for (const [key, bucket] of Object.entries(state.stashByWorkspace)) {
    const updated = updateBucket(bucket);
    if (updated) return { stashByWorkspace: { ...state.stashByWorkspace, [key]: updated } };
  }
  return {};
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],
  workspaceKey: null,
  stashByWorkspace: {},
  historyControlRemainders: {},
  nextSessionNumber: 1,
  tabsRevision: 0,
  listenerInitialized: false,

  createSession: (cwd?: string, anchorThreadId?: string | null) => {
    const { nextSessionNumber, sessions, tabsRevision } = get();
    const id = `terminal:${crypto.randomUUID()}`;
    const title = `Terminal ${nextSessionNumber}`;
    const newSession: TerminalSession = {
      id,
      title,
      cwd,
      anchorThreadId: anchorThreadId ?? null,
      status: "starting",
      history: "",
    };

    set({
      sessions: [newSession, ...sessions],
      nextSessionNumber: nextSessionNumber + 1,
      tabsRevision: tabsRevision + 1,
    });
    return id;
  },

  closeSession: (id: string) => {
    const state = get();
    const { sessions, stashByWorkspace, tabsRevision } = state;
    if (!getAllTerminalSessions(state).some((session) => session.id === id))
      return sessions[0]?.id ?? null;

    // Notify the backend to clean up the process
    if (window.omni?.terminal?.kill) {
      void window.omni.terminal.kill(id);
    }

    const filteredSessions = sessions.filter((s) => s.id !== id);
    const historyControlRemainders = { ...get().historyControlRemainders };
    delete historyControlRemainders[id];

    set({
      sessions: filteredSessions,
      stashByWorkspace: Object.fromEntries(
        Object.entries(stashByWorkspace)
          .map(([key, bucket]) => [key, bucket.filter((session) => session.id !== id)] as const)
          .filter(([, bucket]) => bucket.length > 0),
      ),
      historyControlRemainders,
      tabsRevision: tabsRevision + 1,
    });
    return filteredSessions[0]?.id ?? null;
  },

  clearSessions: () => {
    const sessions = getAllTerminalSessions(get());
    if (window.omni?.terminal?.kill) {
      for (const session of sessions) {
        void window.omni.terminal.kill(session.id);
      }
    }
    set({
      sessions: [],
      stashByWorkspace: {},
      historyControlRemainders: {},
      tabsRevision: get().tabsRevision + 1,
    });
  },

  closeWorkspace: (key) => {
    const state = get();
    const isVisible = state.workspaceKey === key;
    const sessions = isVisible ? state.sessions : (state.stashByWorkspace[key] ?? []);
    const ids = sessions.map((session) => session.id);
    if (ids.length === 0 && !(key in state.stashByWorkspace)) return ids;

    for (const id of ids) {
      void window.omni?.terminal?.kill?.(id);
    }
    const stashByWorkspace = { ...state.stashByWorkspace };
    delete stashByWorkspace[key];
    const historyControlRemainders = { ...state.historyControlRemainders };
    for (const id of ids) delete historyControlRemainders[id];
    set({
      sessions: isVisible ? [] : state.sessions,
      stashByWorkspace,
      historyControlRemainders,
      tabsRevision: state.tabsRevision + 1,
    });
    return ids;
  },

  setWorkspace: (key) => {
    const { sessions, workspaceKey, stashByWorkspace } = get();
    if (workspaceKey === key) return sessions[0]?.id ?? null;

    const nextStash = { ...stashByWorkspace };
    if (workspaceKey !== null && sessions.length > 0) {
      nextStash[workspaceKey] = sessions;
    } else if (workspaceKey !== null) {
      delete nextStash[workspaceKey];
    }

    // Before project hydration, terminals can exist without a bucket. Adopt
    // them on the first workspace binding rather than losing their processes.
    const restored = nextStash[key] ?? (workspaceKey === null ? sessions : []);
    delete nextStash[key];

    const newActiveId = restored[0]?.id ?? null;
    set({
      sessions: restored,
      workspaceKey: key,
      stashByWorkspace: nextStash,
      tabsRevision: get().tabsRevision + 1,
    });
    return newActiveId;
  },

  appendHistory: (id: string, data: string) => {
    set((state) => {
      const { text, remainder } = stripTerminalControls(
        `${state.historyControlRemainders[id] ?? ""}${data}`,
      );
      const patch = updateTerminalSession(state, id, (session) => ({
        ...session,
        history: appendBoundedTerminalHistory(session.history, text),
      }));
      if (Object.keys(patch).length === 0) return {};
      return {
        ...patch,
        historyControlRemainders: {
          ...state.historyControlRemainders,
          [id]: remainder,
        },
      };
    });
  },

  markRunning: (id) => {
    set((state) => {
      const patch = updateTerminalSession(state, id, (session) =>
        session.status === "running"
          ? session
          : { ...session, status: "running", exitCode: undefined, exitSignal: undefined },
      );
      if (Object.keys(patch).length === 0) return {};
      return { ...patch, tabsRevision: state.tabsRevision + 1 };
    });
  },

  markError: (id) => {
    set((state) => {
      const patch = updateTerminalSession(state, id, (session) =>
        session.status === "error" ? session : { ...session, status: "error" },
      );
      if (Object.keys(patch).length === 0) return {};
      return { ...patch, tabsRevision: state.tabsRevision + 1 };
    });
  },

  initializeGlobalListener: () => {
    if (get().listenerInitialized) return;
    if (!window.omni?.terminal?.onData) return;

    window.omni.terminal.onData((payload) => {
      get().appendHistory(payload.sessionId, payload.data);
    });
    window.omni.terminal.onExit?.((payload) => {
      set((state) => {
        const completion = `\r\n[Process completed (exit ${payload.exitCode})]\r\n`;
        const patch = updateTerminalSession(state, payload.sessionId, (session) => ({
          ...session,
          status: "exited",
          exitCode: payload.exitCode,
          exitSignal: payload.signal,
          history: appendBoundedTerminalHistory(session.history, completion),
        }));
        if (Object.keys(patch).length === 0) return {};
        const historyControlRemainders = { ...state.historyControlRemainders };
        delete historyControlRemainders[payload.sessionId];
        return {
          ...patch,
          historyControlRemainders,
          tabsRevision: state.tabsRevision + 1,
        };
      });
    });
    set({ listenerInitialized: true });
  },
}));

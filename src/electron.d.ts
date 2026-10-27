import type { Project, ProjectFileTreeSnapshot } from "../contracts/projects.ts";
import type { FilePreviewInfo, FilePreviewTarget } from "../contracts/file-preview.ts";
import type { DatabaseCompactionResult, WorkspaceDiskUsageReport } from "../contracts/storage.ts";
import type { GitHubApi } from "../contracts/github.ts";
import type {
  RemoteDevicesState,
  RemotePairingOffer,
  RemoteServerInfo,
  RemoteTransport,
} from "../contracts/remote.ts";
import type { GitBranch, Worktree, WorktreeSetupProgress } from "../../contracts/worktrees.ts";
import type {
  ProjectRepoState,
  WorkspaceGitActionResult,
  WorkspaceGitStatus,
} from "../../contracts/git.ts";
import type { OpenTabsState, Thread, ThreadPage } from "../../contracts/threads.ts";
import type {
  AcpAgentDescriptor,
  AcpAgentInstance,
  AcpAgentInstanceInput,
  AgentAccountSchema,
  AcpBridgeEvent,
  AcpPromptInput,
  AcpReplacePromptInput,
  AcpSessionState,
  AcpToolCallState,
  AgentCapabilities,
  AgentProbeResult,
  AvailableCommand,
  McpServerInput,
  McpServerRecord,
  SessionConfigOption,
  BrowserConfig,
  InlineWidgetDocument,
  InlineWidgetRef,
  SubagentConfig,
  SubagentRunSnapshot,
} from "../../contracts/acp.ts";
import type {
  LauncherDownloadProgress,
  LauncherUpdateDiagnostics,
  LauncherUpdateState,
} from "../../contracts/launcher-updates.ts";
import type {
  MonitorConnectionEpisode,
  MonitorAcpUpdate,
  MonitorBridgeEvent,
  MonitorIncident,
  MonitorDiffIngestion,
  MonitorLiveSnapshot,
  MonitorRecordedSession,
  MonitorRendererFreezeReport,
  MonitorRendererTelemetry,
  MonitorDemand,
  MonitorSession,
  MonitorSessionCacheEvent,
  MonitorSwitchRecord,
  MonitorTabClickTiming,
  MonitorTabEvent,
  MonitorTabMismatchReport,
} from "../../contracts/monitor.ts";
import type { SleeplessPreferences, SleeplessStatus } from "../../contracts/sleepless.ts";
import type {
  ThreadBenchmarkIngestedTurn,
  ThreadBenchmarkMode,
  ThreadBenchmarkOpenPath,
  ThreadBenchmarkPrepared,
  ThreadBenchmarkRendererReady,
  ThreadBenchmarkReport,
  ThreadBenchmarkRun,
  ThreadBenchmarkStatus,
} from "../../contracts/benchmark.ts";

export interface CreateProjectInput {
  name: string;
  path: string;
  icon: string;
}

declare global {
  interface Window {
    omni: {
      storage: {
        compactDatabase: () => Promise<DatabaseCompactionResult>;
        workspaceUsage: () => Promise<WorkspaceDiskUsageReport>;
      };
      launch: {
        complete: (projectId: string) => Promise<void>;
        show: (stage?: "list" | "add" | "onboarding") => Promise<void>;
        onAuthComplete: (
          callback: (user: { name: string | null; email: string | null }) => void,
        ) => () => void;
        getUser: () => Promise<{ name: string | null; email: string | null } | null>;
      };
      shell: {
        openExternal: (url: string) => Promise<void>;
        openHttps: (url: string) => Promise<void>;
      };
      github: GitHubApi;
      window: {
        reportVisibility: (visible: boolean) => void;
      };
      sleepless: {
        getStatus: () => Promise<SleeplessStatus | null>;
        setEnabled: (enabled: boolean) => Promise<SleeplessStatus | null>;
        setPreferences: (
          preferences: Partial<
            Pick<SleeplessPreferences, "acOnly" | "batteryFloor" | "maxDurationMinutes">
          >,
        ) => Promise<SleeplessStatus | null>;
        refresh: () => Promise<SleeplessStatus | null>;
        openSystemSettings: () => Promise<void>;
        onStatusChanged: (callback: (status: SleeplessStatus) => void) => () => void;
      };
      remote: {
        getInfo: () => Promise<RemoteServerInfo>;
        setTransport: (transport: RemoteTransport) => Promise<RemoteServerInfo | null>;
        onInfoChanged: (callback: (info: RemoteServerInfo) => void) => () => void;
        getDevices: () => Promise<RemoteDevicesState | null>;
        createPairing: (options: { allowRun: boolean }) => Promise<RemotePairingOffer | null>;
        cancelPairing: () => Promise<void>;
        revokeDevice: (id: string) => Promise<boolean>;
        onDevicesChanged: (callback: (state: RemoteDevicesState) => void) => () => void;
        setStandby: (active: boolean) => Promise<void>;
      };
      launcherUpdate: {
        check: () => Promise<LauncherUpdateState>;
        getState: () => Promise<LauncherUpdateState>;
        isDismissedForSession: () => Promise<boolean>;
        download: () => Promise<LauncherUpdateState>;
        cancelDownload: () => Promise<LauncherUpdateState>;
        dismissForSession: () => Promise<LauncherUpdateState>;
        installAndQuit: () => Promise<{ success: boolean; error?: string }>;
        retryDownload: () => Promise<LauncherUpdateState>;
        openDownloadFolder: () => Promise<void>;
        downloadInBrowser: () => Promise<void>;
        clearDownloadedUpdate: () => Promise<LauncherUpdateState>;
        getDiagnostics: () => Promise<LauncherUpdateDiagnostics>;
        copyDiagnostics: () => Promise<void>;
        onStateChanged: (callback: (state: LauncherUpdateState) => void) => () => void;
        onProgress: (callback: (progress: LauncherDownloadProgress) => void) => () => void;
        onOpenDetails: (callback: () => void) => () => void;
        onDismissedForSession: (callback: () => void) => () => void;
      };
      projects: {
        list: () => Promise<Project[]>;
        create: (input: CreateProjectInput) => Promise<Project>;
        getActive: () => Promise<Project | null>;
        /** `requestId` lets the caller abandon the scan via `cancelListFiles`. */
        listFiles: (
          projectId?: string,
          worktreePath?: string | null,
          requestId?: string | null,
        ) => Promise<string[]>;
        cancelListFiles?: (requestId: string) => void;
        getFileTree: (
          projectId?: string | null,
          worktreePath?: string | null,
        ) => Promise<ProjectFileTreeSnapshot>;
        setActive: (projectId: string) => Promise<void>;
        onActiveChanged: (callback: (projectId: string) => void) => () => void;
        onListChanged: (callback: (project: Project) => void) => () => void;
      };
      files: {
        stat: (target: FilePreviewTarget) => Promise<FilePreviewInfo>;
        reveal: (target: FilePreviewTarget) => Promise<void>;
        openExternal: (target: FilePreviewTarget) => Promise<void>;
      };
      worktrees: {
        getAutoInstall: () => Promise<boolean>;
        setAutoInstall: (enabled: boolean) => Promise<boolean>;
        list: (projectId: string) => Promise<Worktree[]>;
        create: (input: { projectId: string; name: string }) => Promise<Worktree>;
        delete: (input: { projectId: string; path: string }) => Promise<Worktree>;
        onDeleted: (
          callback: (workspace: { projectId: string; path: string }) => void,
        ) => () => void;
        switch: (input: { projectId: string; path: string }) => Promise<Thread>;
        getSelections: () => Promise<Record<string, string>>;
        onSetupProgress: (callback: (progress: WorktreeSetupProgress) => void) => () => void;
        listBranches: (input: { projectId: string }) => Promise<GitBranch[]>;
        switchBranch: (input: {
          projectId: string;
          path: string;
          branch: string;
        }) => Promise<{ thread: Thread; worktree: Worktree }>;
        archive: (input: { projectId: string; path: string }) => Promise<WorkspaceGitActionResult>;
        restore: (input: { projectId: string; path: string }) => Promise<WorkspaceGitActionResult>;
        continue: (input: { projectId: string; path: string }) => Promise<Worktree>;
      };
      git: {
        status: (input: {
          projectId: string;
          path: string;
          force?: boolean;
        }) => Promise<WorkspaceGitStatus>;
        commit: (input: {
          projectId: string;
          path: string;
          message: string;
        }) => Promise<WorkspaceGitActionResult>;
        push: (input: { projectId: string; path: string }) => Promise<WorkspaceGitActionResult>;
        createPr: (input: {
          projectId: string;
          path: string;
          title: string;
          body?: string;
          draft?: boolean;
        }) => Promise<WorkspaceGitActionResult>;
        merge: (input: { projectId: string; path: string }) => Promise<WorkspaceGitActionResult>;
        mergePr: (input: { projectId: string; path: string }) => Promise<WorkspaceGitActionResult>;
        markPrReady: (input: {
          projectId: string;
          path: string;
        }) => Promise<WorkspaceGitActionResult>;
        projectRepoState: (projectId: string) => Promise<ProjectRepoState>;
        init: (input: {
          projectId: string;
          name?: string | null;
          email?: string | null;
        }) => Promise<WorkspaceGitActionResult>;
      };
      onboarding: {
        verifyGit: () => Promise<boolean>;
        startSetup: () => Promise<void>;
        onProgress: (
          callback: (payload: {
            step: string;
            status: "pending" | "running" | "complete" | "failed";
            progress?: number;
            error?: string;
            gitInstalled?: boolean;
            nodeMatch?: boolean;
            bunMatch?: boolean;
          }) => void,
        ) => () => void;
      };
      threads: {
        list: () => Promise<Thread[]>;
        listByIds: (ids: string[]) => Promise<Thread[]>;
        listProject: (input: {
          projectId: string;
          limit?: number;
          offset?: number;
        }) => Promise<ThreadPage>;
        create: (
          projectId: string,
          title: string | null,
          afterThreadId?: string | null,
          agentId?: string | null,
          worktreePath?: string | null,
        ) => Promise<Thread>;
        rename: (id: string, title: string) => Promise<Thread>;
        delete: (id: string) => Promise<void>;
      };
      tabs: {
        isFluidPageSwipeEnabled: () => Promise<boolean>;
        listOpen: () => Promise<OpenTabsState>;
        open: (threadId: string) => Promise<OpenTabsState>;
        close: (threadId: string) => Promise<OpenTabsState>;
        setActive: (threadId: string | null) => Promise<OpenTabsState>;
        getActive: () => Promise<string | null>;
        onChanged: (callback: (state: OpenTabsState) => void) => () => void;
        onSelectByIndex: (callback: (index: number) => void) => () => void;
        onSwipe: (callback: (direction: "left" | "right") => void) => () => void;
        onNewTab: (callback: () => void) => () => void;
        onNewTerminal: (callback: () => void) => () => void;
        onCloseActive: (callback: () => void) => () => void;
      };
      agent: {
        getState: () => Promise<AcpSessionState>;
        getCommands: () => Promise<AvailableCommand[]>;
        getConfigOptions: () => Promise<SessionConfigOption[]>;
        getCapabilities: () => Promise<AgentCapabilities | null>;
        getStats: () => Promise<{
          used: number;
          size: number;
          cost?: { amount: number; currency: string };
        } | null>;
        getRunningThreads: () => Promise<string[]>;
        getToolCalls: (
          threadId: string,
          toolCallIds?: string[],
        ) => Promise<Record<string, AcpToolCallState>>;
        sendPrompt: (input: AcpPromptInput) => Promise<void>;
        replacePrompt: (input: AcpReplacePromptInput) => Promise<void>;
        abort: () => Promise<void>;
        switchThread: (threadId: string) => Promise<void>;
        createThread: (
          projectId: string,
          title: string | null,
          afterThreadId?: string | null,
          agentId?: string | null,
          worktreePath?: string | null,
          initialModelId?: string | null,
        ) => Promise<Thread>;
        getSelectedAgentIds: () => Promise<string[]>;
        setSelectedAgentIds: (agentIds: string[]) => Promise<void>;
        listInstances: () => Promise<AcpAgentInstance[]>;
        getAccountSchemas: () => Promise<AgentAccountSchema[]>;
        createInstance: (input: AcpAgentInstanceInput) => Promise<AcpAgentInstance>;
        updateInstance: (
          id: string,
          input: Partial<AcpAgentInstanceInput>,
        ) => Promise<AcpAgentInstance | null>;
        deleteInstance: (id: string) => Promise<void>;
        launchInstanceLogin: (id: string) => Promise<{ command: string; opened: boolean }>;
        onInstancesChanged: (callback: () => void) => () => void;
        setConfigOption: (
          configId: string,
          value: string | boolean,
        ) => Promise<SessionConfigOption[]>;
        respondToPermission: (response: {
          sessionId: string;
          optionId?: string;
          cancelled?: boolean;
        }) => Promise<void>;
        listAgents: () => Promise<AcpAgentDescriptor[]>;
        getModelCatalogs: (options?: {
          refresh?: string[];
        }) => Promise<Record<string, Array<{ modelId: string; name: string; provider?: string }>>>;
        probeAgent: (agentId: string) => Promise<AgentProbeResult>;
        authenticate: (agentId: string, methodId: string) => Promise<void>;
        switchAgent: (agentId: string) => Promise<void>;
        getPreferredAgentId: () => Promise<string>;
        setPreferredAgentId: (agentId: string) => Promise<void>;
        closeThreadSession: (threadId: string) => Promise<void>;
        setEditorText: (text: string) => Promise<void>;
        getEditorText: () => Promise<string>;
        pasteToEditor: (text: string) => Promise<void>;
        reportEditorText: (text: string) => void;
        onEvent: (callback: (payload: AcpBridgeEvent) => void) => () => void;
      };
      subagents: {
        getConfig: () => Promise<SubagentConfig>;
        setConfig: (partial: Partial<SubagentConfig>) => Promise<SubagentConfig>;
        listRuns: () => Promise<SubagentRunSnapshot[]>;
      };
      widgets: {
        getDocument: (
          ref: InlineWidgetRef,
          theme: "light" | "dark",
        ) => Promise<InlineWidgetDocument | null>;
      };
      browser: {
        getConfig: () => Promise<BrowserConfig>;
        setConfig: (partial: Partial<BrowserConfig>) => Promise<BrowserConfig>;
      };
      mcp: {
        list: () => Promise<McpServerRecord[]>;
        create: (input: McpServerInput) => Promise<McpServerRecord>;
        update: (id: string, input: Partial<McpServerInput>) => Promise<McpServerRecord | null>;
        delete: (id: string) => Promise<void>;
      };
      dialog: {
        pickDirectory: () => Promise<string | null>;
      };
      terminal: {
        create: (sessionId: string, cwd?: string, cols?: number, rows?: number) => Promise<void>;
        write: (sessionId: string, data: string) => Promise<void>;
        resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
        kill: (sessionId: string) => Promise<void>;
        onData: (callback: (payload: { sessionId: string; data: string }) => void) => () => void;
        onExit: (
          callback: (payload: { sessionId: string; exitCode: number; signal?: number }) => void,
        ) => () => void;
      };
      analytics: {
        getConfig: () => Promise<{ key: string; host: string; distinctId: string | null } | null>;
        getDistinctId: () => Promise<string | null>;
        onIdentity: (callback: (distinctId: string) => void) => () => void;
        captureException: (input: {
          name: string;
          message: string;
          stack?: string;
        }) => Promise<void>;
        trackOnboarding: (step: string, status: string, success?: boolean) => Promise<void>;
      };
      startup: {
        reportRendererMilestone: (label: string, rendererElapsedMs: number) => void;
      };
      theme: {
        getCurrent: () => Promise<string>;
        changed: (theme: string) => void;
        onChanged: (callback: (theme: string) => void) => () => void;
      };
      monitor: {
        isEnabled: () => Promise<boolean>;
        getLive: () => Promise<MonitorLiveSnapshot>;
        getIncidents: () => Promise<MonitorIncident[]>;
        getConnectionEpisodes: () => Promise<MonitorConnectionEpisode[]>;
        getSessions: () => Promise<MonitorSession[]>;
        getRecordedSession: (sessionId: string) => Promise<MonitorRecordedSession>;
        startRecording: (label?: string) => Promise<MonitorSession>;
        stopRecording: () => Promise<MonitorSession | null>;
        reportRendererFreeze: (report: MonitorRendererFreezeReport) => Promise<void>;
        reportRendererTelemetry: (telemetry: MonitorRendererTelemetry) => Promise<void>;
        reportDiffIngestion: (ingestion: MonitorDiffIngestion) => void;
        reportTabMismatch: (report: MonitorTabMismatchReport) => Promise<void>;
        reportTabClickTiming: (timing: MonitorTabClickTiming) => Promise<void>;
        getSwitches: () => Promise<MonitorSwitchRecord[]>;
        getSessionCacheEvents: () => Promise<MonitorSessionCacheEvent[]>;
        getTabEvents: () => Promise<MonitorTabEvent[]>;
        getTabClickTimings: () => Promise<MonitorTabClickTiming[]>;
        openWindow: () => Promise<void>;
        onLive: (callback: (snapshot: MonitorLiveSnapshot) => void) => () => void;
        getDemand: () => Promise<MonitorDemand>;
        onDemand: (callback: (demand: MonitorDemand) => void) => () => void;
        onIncident: (callback: (incident: MonitorIncident) => void) => () => void;
      };
      benchmark: {
        enabled: boolean;
        switchTimeoutMs: number;
        status: () => Promise<ThreadBenchmarkStatus>;
        prepare: (openPath?: ThreadBenchmarkOpenPath) => Promise<ThreadBenchmarkPrepared>;
        start: (
          mode: ThreadBenchmarkMode,
          openPath?: ThreadBenchmarkOpenPath,
        ) => Promise<ThreadBenchmarkRun>;
        ingestTurn: () => Promise<ThreadBenchmarkIngestedTurn>;
        streamReset: () => Promise<ThreadBenchmarkPrepared>;
        finish: () => Promise<ThreadBenchmarkReport>;
        cleanup: () => Promise<void>;
        reportRendererReady: (input: ThreadBenchmarkRendererReady) => void;
        reportStreamReady: (input: ThreadBenchmarkRendererReady) => void;
      };
    };
  }
}

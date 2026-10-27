import {
  app,
  BrowserWindow,
  Menu,
  shell,
  ipcMain,
  dialog,
  powerMonitor,
  protocol,
  safeStorage,
} from "electron";
import { join, dirname, relative, resolve, isAbsolute } from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import { spawn, execFile } from "node:child_process";
import { isFluidPageSwipeEnabled } from "./page-swipe-preference";
import { promisify } from "node:util";
import * as pty from "node-pty";
import {
  markLaunchComplete,
  readLaunchState,
  readWorkspaceSelections,
  updateWorkspaceSelection,
} from "./launch-state";
import { pickWorkspaceThread } from "../contracts/workspace-scope.ts";
import { createProject, getProject, listProjects } from "./projects";
import {
  canOpenExternally,
  FILE_PREVIEW_SCHEME,
  FilePreviewService,
  servePreviewFile,
} from "./file-preview.ts";
import type { FilePreviewTarget } from "../contracts/file-preview.ts";
import { logMain } from "./main-log";
import {
  continueWorktreeOnNewBranch,
  foreignGitEnv,
  gitBinary,
  listBranches,
  listWorktrees,
  removeWorktree,
  samePath,
  switchWorktreeBranch,
} from "./worktree-manager";
import { getWorktreeAutoInstall, setWorktreeAutoInstall } from "./worktree-preferences.ts";
import {
  cancelWorkspaceSetup,
  createWorkspace,
  setWorkspaceSetupProgressSink,
} from "./workspace-lifecycle.ts";
import { compactWhenIdle, type DatabaseCompactionResult } from "./database-compaction.ts";
import { applicationStorage } from "./storage-maintenance.ts";
import { scanWorkspaceDiskUsage } from "./workspace-disk-usage.ts";
import {
  commitWorkspace,
  configureGithubPrSnapshotCache,
  createWorkspacePr,
  getProjectRepoState,
  getWorkspaceGitStatus,
  initProjectRepo,
  markWorkspacePrReady,
  mergeWorkspaceBranch,
  mergeWorkspacePr,
  pushWorkspace,
} from "./git-workspace";
import type { ProjectFileGitStatus, ProjectFileTreeSnapshot } from "../contracts/projects.ts";
import { getActiveProjectId, setActiveProjectId } from "./session";
import { ProjectFileLister } from "./project-file-list.ts";
import { AUTH_CALLBACK_SUCCESS_HTML } from "./auth-callback-success";
import {
  isAllowedClerkAuthUrl,
  resolveClerkSignInUrl,
  resolveClerkSignUpUrl,
} from "./clerk-auth-config";
import {
  getDb,
  getGithubPrSnapshot,
  getMostRecentAuthUser,
  upsertAuthUser,
  getSelectedAgentIds,
  setSelectedAgentIds,
  saveGithubPrSnapshot,
} from "./db";
import { getThread, listThreads, listThreadsByIds, listProjectThreads } from "./threads";
import type { OpenTabsState } from "../contracts/threads.ts";
import type { BrowserConfig, InlineWidgetDocument } from "../contracts/acp.ts";
import { listMcpServers, createMcpServer, updateMcpServer, deleteMcpServer } from "./mcp-servers";
import {
  installAgentInstanceProvider,
  listAgentInstancesForRenderer,
  listAgentAccountSchemas,
  getAgentInstance,
  redactInstance,
  ensureInstanceProfileDirs,
  ensureAmbientCodexFileStore,
  buildInstanceLoginCommand,
  createAgentInstance,
  updateAgentInstance,
  deleteAgentInstance,
} from "./agent-instances";
import { AgentManager } from "./agent";
import { BrowserService } from "./browser/browser-service.ts";
import { electronPageHost, isAgentBrowserWindow } from "./browser/electron-page.ts";
import { resolveWidgetDocument } from "./widgets/widget-documents.ts";
import { sqliteWidgetStore } from "./widgets/widget-store.ts";
import { RemoteTaskError, getRemoteRequests } from "./remote-requests.ts";
import { prepareIsolatedAgentTask } from "./isolated-agent-task.ts";
import { createElectronOsNotifier } from "./os-notifications";
import { WindowVisibilityGate } from "./window-visibility";
import { MonitorService } from "./monitor/service.ts";
import { isMonitorEnabled } from "./monitor/enabled.ts";
import { emptyMonitorRecordedSession } from "./monitor/timeline.ts";
import { buildMonitorInventory } from "./monitor/inventory.ts";
import { probeAgentById } from "./agents/handshake-probe.ts";
import {
  broadcastOpenTabsChanged,
  closeThreadTab,
  removeThreadTabs,
  openThreadTab,
  readOpenTabsState,
  activateTabAfterClose,
  setActiveThreadTab,
  setLiveThreadIdsCheck,
  setTabEventObserver,
} from "./open-tabs";
import { isActivationSuperseded } from "./activation.ts";
import { checkGit, installGit, prependStandardPaths } from "./dependency-installer";
import {
  captureAnalytics,
  captureAnalyticsException,
  flushAnalytics,
  getAnalyticsConfig,
  getAnalyticsDistinctId,
  identifyAnalyticsUser,
  setActiveAgentContext,
  shutdownAnalytics,
} from "./analytics";
import {
  flushTelemetry,
  initializeTelemetry,
  logTelemetryError,
  shutdownTelemetry,
} from "./telemetry";
import type { AnalyticsEventName, AnalyticsProperties } from "./analytics-schema";
import { sanitizeErrorType } from "./analytics-sanitize";
import { SleeplessController, resolveSleeplessHelperPath } from "./sleepless-controller.ts";
import { RemoteAccessController } from "./remote-access.ts";
import { DesktopIdentity, withSignInParams } from "./desktop-identity.ts";
import { RemoteDeviceStore } from "./remote-devices.ts";
import type { RemoteScope, RemoteTransport } from "../contracts/remote.ts";
import { ThreadBenchmarkController } from "./thread-benchmark.ts";
import type {
  ThreadBenchmarkMode,
  ThreadBenchmarkOpenPath,
  ThreadBenchmarkRendererReady,
} from "../contracts/benchmark.ts";

// Initialize PATH prepend early for child process resolutions
prependStandardPaths();

import { getPipperLibraryPath } from "./paths";
import { LauncherUpdateManager } from "./launcher-update-manager";
import { launchLauncherInstaller } from "./launcher-update-install.ts";
import { resolveLauncherUpdateManifestUrl } from "./launcher-update-config.ts";
import { runShutdownSteps } from "./bounded-shutdown.ts";
import { waitForPidsToExit } from "./child-process.ts";
import { killAllProviderProcessesSync } from "./provider-processes.ts";
import {
  PIPPER_LAUNCHER_MAC_MANIFEST_URL,
  PIPPER_LAUNCHER_WINDOWS_MANIFEST_URL,
} from "../contracts/launcher-release-urls.ts";

const mainDir = dirname(fileURLToPath(import.meta.url));

const startupStartedAt = performance.now();
const reportedRendererStartupMilestones = new Set<string>();
const rendererStartupMilestoneLabels = new Set([
  "entry",
  "react-committed",
  "first-contentful-paint",
  "project-context-ready",
]);

function logStartupMilestone(label: string, details?: string): void {
  const elapsedMs = (performance.now() - startupStartedAt).toFixed(1);
  console.log(`[Startup] ${label} +${elapsedMs}ms${details ? ` ${details}` : ""}`);
}

interface RendererPtySession {
  process: pty.IPty;
  dataDisposable: pty.IDisposable;
  exitDisposable: pty.IDisposable;
}

const ptyProcesses = new Map<string, RendererPtySession>();
const execFileAsync = promisify(execFile);

const MIN_PTY_COLS = 2;
const MIN_PTY_ROWS = 2;
const MAX_PTY_COLS = 1000;
const MAX_PTY_ROWS = 1000;

function normalizePtySize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  if (typeof cols !== "number" || typeof rows !== "number") return null;
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  const numericCols = Math.floor(cols);
  const numericRows = Math.floor(rows);
  if (numericCols <= 0 || numericRows <= 0) return null;
  return {
    cols: Math.max(MIN_PTY_COLS, Math.min(numericCols, MAX_PTY_COLS)),
    rows: Math.max(MIN_PTY_ROWS, Math.min(numericRows, MAX_PTY_ROWS)),
  };
}

function disposePtySession(session: RendererPtySession): void {
  session.dataDisposable.dispose();
  session.exitDisposable.dispose();
}

/**
 * Shells signalled by killAllPtyProcesses that may not have exited yet. Each
 * entry removes itself once its shells are gone (SIGKILL after 1 s), so quit
 * can wait for them without holding pids that could be reused later.
 */
const stoppingPtyShells = new Set<Promise<void>>();

/** Stops every renderer terminal. */
function killAllPtyProcesses(reason: string): void {
  const pids: number[] = [];
  for (const [id, session] of ptyProcesses) {
    pids.push(session.process.pid);
    try {
      session.process.kill();
    } catch (error) {
      console.warn(`[${reason}] Failed to stop terminal ${id}:`, error);
    }
    disposePtySession(session);
  }
  ptyProcesses.clear();
  if (pids.length === 0) return;
  const stopped: Promise<void> = waitForPidsToExit(pids, 1_000).finally(() =>
    stoppingPtyShells.delete(stopped),
  );
  stoppingPtyShells.add(stopped);
}

function resolveWindowsShell(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const candidates = [
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    join(systemRoot, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "powershell.exe";
}

const projectFileLister = new ProjectFileLister();

function parseProjectGitStatus(output: string): ProjectFileTreeSnapshot["gitStatus"] {
  const entries: ProjectFileTreeSnapshot["gitStatus"] = [];
  const records = output.split("\0");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;

    const code = record.slice(0, 2);
    const path = record.slice(3);
    let status: ProjectFileGitStatus | null = null;

    if (code === "??") status = "untracked";
    else if (code === "!!") status = "ignored";
    else if (code.includes("R") || code.includes("C")) status = "renamed";
    else if (code.includes("D")) status = "deleted";
    else if (code.includes("A")) status = "added";
    else if (code.includes("M") || code.includes("T") || code.includes("U")) {
      status = "modified";
    }

    if (status) entries.push({ path, status });

    // Porcelain v1 emits a second NUL-delimited source path for renames and
    // copies. The first path is the destination, which is the one in ls-files.
    if (code.includes("R") || code.includes("C")) index += 1;
  }

  return entries;
}

async function listProjectFileTree(projectPath: string): Promise<ProjectFileTreeSnapshot> {
  const [paths, gitStatus] = await Promise.all([
    projectFileLister.list(projectPath),
    // Resolved binary + sanitized env: a bare "git" silently fails (empty
    // status decorations) when a GUI launch strips PATH.
    execFileAsync(gitBinary(), ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: projectPath,
      env: foreignGitEnv(),
      maxBuffer: 1024 * 1024 * 4,
    })
      .then(({ stdout }) => parseProjectGitStatus(String(stdout)))
      .catch(() => []),
  ]);

  return { paths, gitStatus };
}
let currentTheme: "light" | "dark" | "system" = "system";

// Read-only project file previews. Must be registered before the app is
// ready; `standard` + `secure` give it normal URL parsing and a secure
// origin, and `stream` lets video and audio seek with range requests.
protocol.registerSchemesAsPrivileged([
  {
    scheme: FILE_PREVIEW_SCHEME,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
]);
const filePreview = new FilePreviewService({
  getProjectPath: (projectId) => getProject(projectId)?.path ?? null,
  listWorktreePaths: async (projectPath) =>
    (await listWorktrees(projectPath)).map((worktree) => worktree.path),
});

/** Serve `pipper-file://` requests issued by `files:stat`, never anything else. */
function registerFilePreviewProtocol(): void {
  protocol.handle(FILE_PREVIEW_SCHEME, async (request) => {
    const realPath = await filePreview.resolveRequest(request.url);
    if (!realPath) return new Response("Not found", { status: 404 });
    return servePreviewFile(realPath, request.headers.get("range"));
  });
}

function filePreviewTarget(value: unknown): FilePreviewTarget {
  const target = value as Partial<FilePreviewTarget> | null;
  if (
    !target ||
    typeof target.projectId !== "string" ||
    typeof target.path !== "string" ||
    (target.worktreePath !== null && typeof target.worktreePath !== "string")
  ) {
    throw new Error("Invalid file target.");
  }
  return { projectId: target.projectId, worktreePath: target.worktreePath, path: target.path };
}

const benchmarkEnabled = process.env.PIPPER_BENCHMARK_MODE === "1";
const isDev = !app.isPackaged && !benchmarkEnabled;

initializeTelemetry();

if (benchmarkEnabled && process.env.PIPPER_DEV_USER_DATA_PATH) {
  app.setPath("userData", process.env.PIPPER_DEV_USER_DATA_PATH);
} else if (isDev && !process.env.PIPPER_LIBRARY_PATH) {
  const devUserDataPath =
    process.env.PIPPER_DEV_USER_DATA_PATH ?? join(app.getPath("appData"), "pipper-dev");
  app.setPath("userData", devUserDataPath);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

if (!benchmarkEnabled && !app.isDefaultProtocolClient("pipper")) {
  app.setAsDefaultProtocolClient("pipper");
}

app.on("second-instance", (_event, argv) => {
  const url = argv.find((arg) => arg.startsWith("pipper://"));
  if (url) {
    void handlePipperDeepLink(url).catch((err) => {
      console.error("[Main] Failed to handle deep link:", err);
    });
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  void handlePipperDeepLink(url).catch((err) => {
    console.error("[Main] Failed to handle deep link:", err);
  });
});

// Without these, an uncaught error anywhere in the main process (e.g. handling
// an ACP session/update from an agent) crashes the whole process and takes
// every window down with it. Log and keep running instead.
process.on("uncaughtException", (err) => {
  console.error("[main] Uncaught exception:", err);
  captureAnalyticsException(err, { source: "agent_runtime", error_type: sanitizeErrorType(err) });
  logTelemetryError("Uncaught exception in Electron main process", {
    error_type: sanitizeErrorType(err) ?? "Error",
  });
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] Unhandled rejection:", reason);
  captureAnalyticsException(reason, {
    source: "agent_runtime",
    error_type: sanitizeErrorType(reason),
  });
  logTelemetryError("Unhandled rejection in Electron main process", {
    error_type: sanitizeErrorType(reason) ?? "Error",
  });
});

function generateRandomId(): string {
  const hex = randomBytes(4).toString("hex");
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

function normalizeTheme(theme: string): "light" | "dark" | "system" {
  return theme === "light" || theme === "dark" || theme === "system" ? theme : "system";
}

let mainWindow: BrowserWindow | null = null;
let launchWindow: BrowserWindow | null = null;
let monitorWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let agentManager: AgentManager | null = null;
let browserService: BrowserService | null = null;
/**
 * Single source of truth for "can the user currently see the main window".
 * Consumed by the agent bridge (hidden-window delta coalescing) and the OS
 * notification policy (only notify when the in-app UI cannot show it).
 */
const windowVisibilityGate = new WindowVisibilityGate();
// Windows renders OS notifications only when the App User Model ID matches
// the packaged identity (electron-builder.yml appId); other platforms ignore.
app.setAppUserModelId("com.maker-or.omni");
/**
 * Whether the main window holds keyboard focus. Notifications key off
 * attention (focused AND visible = user is here), which is broader than the
 * visibility gate: Cmd+Tab away leaves the window "visible" on macOS while
 * the user is clearly elsewhere.
 */
let mainWindowFocused = true;
const osNotifier = createElectronOsNotifier(() => {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
let threadBenchmarkController: ThreadBenchmarkController | null = null;
let pendingStartupAgentProjectId: string | null = null;
let startupAgentActivationStarted = false;
let startupAgentActivationFallback: ReturnType<typeof setTimeout> | null = null;
let deferredStartupWorkStarted = false;

function startStartupAgentActivation(reason: "first-paint" | "fallback"): void {
  if (startupAgentActivationStarted || !pendingStartupAgentProjectId || !agentManager) return;
  startDeferredStartupWork();
  startupAgentActivationStarted = true;
  if (startupAgentActivationFallback) {
    clearTimeout(startupAgentActivationFallback);
    startupAgentActivationFallback = null;
  }
  logStartupMilestone(
    "agent-activation:start",
    `project=${pendingStartupAgentProjectId} reason=${reason}`,
  );
  void agentManager
    .activateFromLaunchState()
    .then(() => {
      logStartupMilestone("agent-activation:complete");
    })
    .catch((error) => {
      console.error("[Startup] Agent activation failed:", error);
    });
}
let monitorService: MonitorService | null = null;
/** webContents ids whose navigation/destroy listeners end their live-feed subscription. */
const liveFeedSenders = new Set<number>();
let launcherUpdateManager: LauncherUpdateManager | null = null;
let sleeplessController: SleeplessController | null = null;
let remoteAccess: RemoteAccessController | null = null;
let desktopIdentityInstance: DesktopIdentity | null = null;

/** Laptop id, sign-in state, and the pipper.dev laptop credential (encrypted at rest). */
function desktopIdentity(): DesktopIdentity {
  desktopIdentityInstance ??= new DesktopIdentity({
    dir: app.getPath("userData"),
    secretBox: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (cipher) => safeStorage.decryptString(cipher),
    },
  });
  return desktopIdentityInstance;
}
let authCallbackServer: http.Server | null = null;
let authCallbackPort: number | null = null;
let pendingAuthCallback: Promise<void> | null = null;

/**
 * Services that do not contribute to the initial UI state start only after
 * the first frame (or its fallback). Agent activation starts this first, so
 * diagnostics still observe the full ACP connection lifecycle.
 */
function startDeferredStartupWork(): void {
  if (deferredStartupWorkStarted) return;
  deferredStartupWorkStarted = true;

  initializeMonitorService();
  void sleeplessController?.initialize().catch((error) => {
    console.error("[Sleepless] Initialization failed:", error);
  });

  const updates = launcherUpdateManager;
  if (!updates) return;
  logStartupMilestone("launcher-recovery:start");
  void updates
    .recover()
    .then(() => {
      logStartupMilestone("launcher-recovery:complete");
      updates.startPeriodicChecks();
      return updates.check();
    })
    .catch((error) => {
      console.error("[Startup] Launcher recovery failed:", error);
    });
}

function scheduleDeferredStartupWork(): void {
  const fallback = setTimeout(startDeferredStartupWork, 2000);
  fallback.unref?.();
}

function requireAgentManager(): AgentManager {
  if (!agentManager) {
    throw new Error("Agent manager is not initialized.");
  }
  return agentManager;
}

/**
 * Deep links that arrived before the agent manager was ready (cold launch).
 * Drained once initialization completes in `app.whenReady()`.
 */
const pendingDeepLinks: string[] = [];

/**
 * Single-flight guard: concurrent deliveries of the same staged request
 * (startup scan, activation, deep link, renderer, IPC) share one promise.
 */
const inFlightSiriRequests = new Map<string, Promise<unknown>>();

/** Staged requests are durably claimed before creating a session. Retried
 * activations reopen the same thread; uncertain prompt delivery is never replayed. */
async function consumeSiriRequest(requestId: string, preferredDir?: string): Promise<unknown> {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9-]{1,123}$/.test(requestId)) {
    return null;
  }
  const existing = inFlightSiriRequests.get(requestId);
  if (existing) return existing;
  const task = consumeSiriRequestInner(requestId, preferredDir).finally(() => {
    if (inFlightSiriRequests.get(requestId) === task) inFlightSiriRequests.delete(requestId);
  });
  inFlightSiriRequests.set(requestId, task);
  return task;
}

async function consumeSiriRequestInner(requestId: string, preferredDir?: string): Promise<unknown> {
  const { getSiriRequestsDir, getSiriRequestsDirs } = await import("./siri/siri-catalog.ts");
  // Resolve the request from every supported directory so legacy-only
  // staged requests are delivered, not orphaned. The caller's `preferredDir`
  // (which replica was newest) wins so the scan consumes the same file it
  // ranked, not whichever dir happens to be listed first.
  let dir = resolve(getSiriRequestsDir());
  let file: string | null = null;
  const dirs = getSiriRequestsDirs().map((rawDir) => resolve(rawDir));
  const preferred = preferredDir ? resolve(preferredDir) : null;
  const orderedDirs =
    preferred && dirs.includes(preferred)
      ? [preferred, ...dirs.filter((d) => d !== preferred)]
      : dirs;
  for (const candidateDir of orderedDirs) {
    const candidate = resolve(join(candidateDir, `${requestId}.json`));
    const rel = relative(candidateDir, candidate);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    if (fs.existsSync(candidate)) {
      dir = candidateDir;
      file = candidate;
      break;
    }
  }
  const requests = getRemoteRequests(join(app.getPath("userData"), "remote-requests"));
  const id = `siri-${requestId}`;
  if (!file) {
    const previous = requests.get(id);
    return previous?.threadId ? getThread(previous.threadId) : null;
  }
  const raw = fs.readFileSync(file, "utf8");
  let parsed: { projectId: string; agentId?: string; prompt?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    fs.rmSync(file, { force: true });
    return null;
  }
  if (!parsed || typeof parsed.projectId !== "string" || !parsed.projectId) {
    fs.rmSync(file, { force: true });
    return null;
  }
  if (
    (parsed.agentId != null && typeof parsed.agentId !== "string") ||
    (parsed.prompt != null && typeof parsed.prompt !== "string")
  )
    return null;
  const markerFile =
    orderedDirs
      .map((candidate) => resolve(join(candidate, `.done-${requestId}.json`)))
      .find((candidate) => fs.existsSync(candidate)) ??
    resolve(join(dir, `.done-${requestId}.json`));
  const receipt = await requests.submit(
    id,
    {
      kind: "siri",
      projectId: parsed.projectId,
      agentId: parsed.agentId ?? null,
      prompt: parsed.prompt ?? "",
    },
    async () => {
      // Old builds could have sent the prompt without confirming delivery.
      // Preserve their thread, but never replay that ambiguous request.
      if (fs.existsSync(markerFile)) {
        const marker = JSON.parse(fs.readFileSync(markerFile, "utf8")) as {
          threadId?: string;
          delivered?: boolean;
        };
        if (!marker.threadId || !getThread(marker.threadId))
          throw new RemoteTaskError(
            "An older Siri request could not be recovered. Check Pipper before starting another task.",
          );
        return {
          threadId: marker.threadId,
          result: { ok: true },
          execute: async () => {
            if (!marker.delivered)
              throw new RemoteTaskError(
                "This Siri request was handled by an older Pipper version. Check its thread before resending the task; delivery could not be confirmed.",
              );
          },
        };
      }
      return prepareIsolatedAgentTask(
        requireAgentManager(),
        parsed.projectId,
        parsed.agentId,
        parsed.prompt ?? "",
      );
    },
  );
  if (receipt.threadId) {
    // The receipt now owns recovery, so staged prompt replicas can be removed.
    finalizeSiriRequest(file, markerFile, dir, requestId);
    return getThread(receipt.threadId);
  }
  throw new Error(receipt.error ?? "Siri request is still being prepared.");
}

/**
 * Remove a consumed request and its marker, then clean up replicas in the
 * other candidate directories. Safe to call more than once.
 */
function finalizeSiriRequest(
  file: string,
  markerFile: string,
  dir: string,
  requestId: string,
): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best-effort.
  }
  try {
    fs.rmSync(markerFile, { force: true });
  } catch {
    // Best-effort.
  }
  void cleanupSiriRequestReplicas(dir, requestId);
}

async function cleanupSiriRequestReplicas(dir: string, requestId: string): Promise<void> {
  const { getSiriRequestsDirs } = await import("./siri/siri-catalog.ts");
  for (const rawDir of getSiriRequestsDirs()) {
    const otherDir = resolve(rawDir);
    if (otherDir === dir) continue;
    try {
      fs.rmSync(resolve(join(otherDir, `${requestId}.json`)), { force: true });
      fs.rmSync(resolve(join(otherDir, `.done-${requestId}.json`)), { force: true });
    } catch {
      // Best-effort replica cleanup.
    }
  }
}

async function openSiriThread(thread: unknown): Promise<void> {
  const threadId = (thread as { id?: string })?.id;
  if (!threadId) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  const next = await openThreadTab(threadId);
  broadcastOpenTabsChanged(mainWindow, next);
  await requireAgentManager().switchThread(threadId);
}

/**
 * App Intents extensions cannot launch Electron directly. They leave a
 * request in the shared directory and open `pipper://siri/<id>`. Consume the
 * pending files (oldest first) whenever Pipper starts or is activated from
 * Shortcuts. Callers must not block window creation on this.
 */
async function consumePendingSiriRequests(): Promise<void> {
  if (!agentManager) return;
  const { getSiriRequestsDirs } = await import("./siri/siri-catalog.ts");
  // Key by request id, but keep the winning replica's dir so the consume
  // step reads the newest copy rather than whichever dir is listed first.
  const seen = new Map<string, { mtimeMs: number; dir: string }>();
  for (const rawDir of getSiriRequestsDirs()) {
    const dir = resolve(rawDir);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[A-Za-z0-9-]{1,128}\.json$/.test(entry.name)) continue;
      const requestId = entry.name.slice(0, -5);
      const mtimeMs = fs.statSync(join(dir, entry.name)).mtimeMs;
      const previous = seen.get(requestId);
      if (!previous || mtimeMs > previous.mtimeMs) seen.set(requestId, { mtimeMs, dir });
    }
  }
  const requests = [...seen.entries()]
    .map(([requestId, info]) => ({ requestId, mtimeMs: info.mtimeMs, dir: info.dir }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const { requestId, dir } of requests) {
    try {
      const thread = await consumeSiriRequest(requestId, dir);
      if (thread) await openSiriThread(thread);
    } catch (error) {
      // Leave failed requests on disk so a later app activation can retry.
      console.error(`[Main] Failed to consume pending Siri request ${requestId}:`, error);
    }
  }
}

/**
 * Route a `pipper://siri/<requestId>` deep link (opened by the Swift
 * StartThreadIntent): focus the main window, consume the staged request, and
 * land the user on the new thread. Returns true when the URL was handled.
 */
async function handlePipperDeepLink(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "pipper:") return false;
  const match = /^siri\/([A-Za-z0-9-]{1,128})\/?$/.exec(`${parsed.host}${parsed.pathname}`);
  if (!match?.[1]) return false;
  if (!agentManager) {
    // Cold launch: the open-url/second-instance event can arrive before
    // initialization. Queue it; it drains once the manager is ready.
    if (!pendingDeepLinks.includes(url)) pendingDeepLinks.push(url);
    return true;
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const thread = await consumeSiriRequest(match[1]);
  if (thread) await openSiriThread(thread);
  return true;
}

async function drainStartupSiriRequests(): Promise<void> {
  try {
    await consumePendingSiriRequests();
  } catch (err) {
    console.error("[Main] Failed to consume pending Siri requests at startup:", err);
  }
  for (const queued of pendingDeepLinks.splice(0)) {
    await handlePipperDeepLink(queued).catch((err) => {
      console.error("[Main] Failed to handle queued deep link:", err);
    });
  }
}

function requireLauncherUpdateManager(): LauncherUpdateManager {
  if (!launcherUpdateManager) throw new Error("Launcher update manager is not initialized.");
  return launcherUpdateManager;
}

/**
 * Launch a provider account's interactive sign-in inside the user's terminal,
 * with its isolated credential root exported. Pipper never handles the
 * credentials — the CLI runs its own OAuth flow and owns its storage. Returns
 * the command so the UI can offer a manual fallback if no terminal opened.
 */
async function launchInstanceLogin(
  instanceId: string,
): Promise<{ command: string; opened: boolean }> {
  const instance = getAgentInstance(instanceId);
  if (!instance) throw new Error(`Unknown account: ${instanceId}`);
  // The CLI (e.g. Codex) errors if its credential root doesn't exist, so make
  // sure the profile directory is present before launching sign-in.
  ensureInstanceProfileDirs(instance);
  // The default Codex account uses the ambient ~/.codex; pin file-based
  // credential storage there so login writes auth.json the adapter can read.
  if (instance.driverId === "codex-acp" && instance.id === instance.driverId) {
    ensureAmbientCodexFileStore();
  }
  const command = buildInstanceLoginCommand(instance);
  if (!command) {
    throw new Error("This provider signs in with an API key, not a browser login.");
  }
  try {
    if (process.platform === "darwin") {
      await execFileAsync("osascript", [
        "-e",
        `tell application "Terminal" to do script ${JSON.stringify(command)}`,
        "-e",
        `tell application "Terminal" to activate`,
      ]);
      return { command, opened: true };
    }
    if (process.platform === "win32") {
      await execFileAsync("cmd", ["/c", "start", "", "cmd", "/k", command]);
      return { command, opened: true };
    }
    // Linux: `spawn` reports a missing terminal via an async 'error' event, not
    // a throw, so wait for spawn/error before claiming the terminal opened.
    return await new Promise<{ command: string; opened: boolean }>((resolve) => {
      const child = spawn("x-terminal-emulator", ["-e", "sh", "-c", command], {
        detached: true,
        stdio: "ignore",
      });
      child.once("spawn", () => {
        child.unref();
        resolve({ command, opened: true });
      });
      child.once("error", () => resolve({ command, opened: false }));
    });
  } catch {
    return { command, opened: false };
  }
}

/**
 * Enter a workspace (the project root or a linked worktree): persist it as
 * the project's canonical workspace, then restore that workspace's own last
 * active thread — its most-recently-used open tab, else its most recent
 * thread from history, else a fresh thread. A workspace switch is a context
 * change, not a collapse to one canonical thread per worktree.
 */
async function activateProjectWorktree(projectId: string, targetPath: string) {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const target = (await listWorktrees(project.path)).find((worktree) =>
    samePath(worktree.path, targetPath),
  );
  if (!target) throw new Error("Worktree is no longer available");

  const worktreePath = target.isProjectRoot ? null : target.path;
  await updateWorkspaceSelection(project.id, target.path);

  const tabsState = await readOpenTabsState();
  let thread = pickWorkspaceThread({
    projectId: project.id,
    workspacePath: worktreePath,
    openThreadIds: tabsState.openThreadIds,
    threadSwitchHistory: tabsState.threadSwitchHistory,
    threads: listThreads(),
  });
  if (thread) {
    await requireAgentManager().switchThread(thread.id);
  } else {
    thread = await requireAgentManager().createThread(project.id, null, null, null, worktreePath);
  }

  captureAnalytics("workspace_switched", {
    windowType: "main",
    properties: { project_id: project.id, is_main: worktreePath === null },
  });

  const next = await openThreadTab(thread.id);
  broadcastOpenTabsChanged(mainWindow, next);
  return { thread, worktree: target };
}

let databaseCompaction: Promise<DatabaseCompactionResult> | null = null;

/**
 * Predicate for "tab in the same (project, workspace) as this thread", used
 * to keep next-active selection inside the current workspace when a tab
 * closes. Must be built before the thread row is deleted.
 */
function makeWorkspacePeerPredicate(threadId: string): ((id: string) => boolean) | undefined {
  const closed = getThread(threadId);
  if (!closed) return undefined;
  const workspacePath = closed.worktree_path ?? null;
  return (id) => {
    const candidate = getThread(id);
    return (
      candidate !== null &&
      candidate.project_id === closed.project_id &&
      (candidate.worktree_path ?? null) === workspacePath
    );
  };
}

function resolveRendererUrl(
  page: "main" | "launch" | "monitor" | "settings",
  stage?: string,
): string {
  const base = process.env["ELECTRON_RENDERER_URL"];
  if (!base) return "";
  let url =
    page === "launch"
      ? `${base}/launch.html`
      : page === "monitor"
        ? `${base}/monitor.html`
        : page === "settings"
          ? `${base}/settings.html`
          : base;
  if (stage) {
    url += `?stage=${stage}`;
  }
  return url;
}

function resolveRendererFile(page: "main" | "launch" | "monitor" | "settings"): string {
  const fileName =
    page === "launch"
      ? "launch.html"
      : page === "monitor"
        ? "monitor.html"
        : page === "settings"
          ? "settings.html"
          : "index.html";
  return join(mainDir, "../renderer", fileName);
}

function getIconPath(): string | undefined {
  const path = isDev
    ? join(app.getAppPath(), "public/devIcon.png")
    : join(mainDir, "../renderer/icon.png");
  return fs.existsSync(path) ? path : undefined;
}

function sendToMainWindow(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function setMainWindowTitle(title: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(title);
  }
}

function resolveExternalUrl(kind: "clerkSignUp" | "clerkSignIn"): string {
  return kind === "clerkSignUp" ? resolveClerkSignUpUrl() : resolveClerkSignInUrl();
}

const PIPPER_DOCS_URL_PREFIXES = ["https://www.pipper.dev/docs/", "https://pipper.dev/docs/"];
// Workspace panel links to the branch's pull request. Only PR pages — not
// arbitrary GitHub URLs — so a crafted `gh` response can't open anything else.
const GITHUB_PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/;

function isAllowedExternalUrl(inputUrl: string): boolean {
  if (inputUrl === "https://cli.github.com/") return true;
  if (isAllowedClerkAuthUrl(inputUrl)) return true;
  if (GITHUB_PR_URL.test(inputUrl)) return true;
  // Onboarding verification cards link failing agents to their setup guide.
  return PIPPER_DOCS_URL_PREFIXES.some((prefix) => inputUrl.startsWith(prefix));
}

function assertAllowedExternalUrl(inputUrl: string): string {
  const trimmed = inputUrl.trim();
  if (!trimmed || !isAllowedExternalUrl(trimmed)) {
    throw new Error("External URL is not allowed.");
  }
  return trimmed;
}

function parseAuthCallback(url: string): {
  providerUserId: string | null;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  state: string | null;
  credential: string | null;
} {
  try {
    const parsed = new URL(url);
    return {
      providerUserId: parsed.searchParams.get("userId"),
      email: parsed.searchParams.get("email"),
      name: parsed.searchParams.get("name"),
      avatarUrl: parsed.searchParams.get("avatarUrl"),
      state: parsed.searchParams.get("state"),
      credential: parsed.searchParams.get("credential"),
    };
  } catch {
    return {
      providerUserId: null,
      email: null,
      name: null,
      avatarUrl: null,
      state: null,
      credential: null,
    };
  }
}

async function handleAuthCallback(url: string): Promise<void> {
  const payload = parseAuthCallback(url);
  if (!payload.providerUserId) {
    throw new Error("Auth callback missing provider user id.");
  }
  if (!payload.email) {
    throw new Error("Auth callback missing email.");
  }
  // The callback must answer a sign-in this app started: anything that can
  // reach the loopback listener could otherwise inject an identity without
  // completing Clerk sign-in. Requires the pipper.dev /auth/complete that
  // echoes `state`.
  if (!desktopIdentity().consumeState(payload.state)) {
    throw new Error("Auth callback does not match a sign-in started by this app.");
  }
  // Whatever the callback carries replaces the previous sign-in: with no
  // credential (pipper.dev not configured), drop the old one rather than keep
  // using a possibly different account's.
  if (payload.credential) desktopIdentity().saveCredential(payload.credential);
  else desktopIdentity().clearCredential();
  void remoteAccess?.onCredentialChanged();

  const record = upsertAuthUser({
    provider: "clerk",
    providerUserId: payload.providerUserId,
    email: payload.email,
    name: payload.name,
    avatarUrl: payload.avatarUrl,
  });

  console.log("[Main] Authenticated user stored:", record.provider_user_id);
  identifyAnalyticsUser({
    providerUserId: record.provider_user_id,
    email: record.email,
    name: record.name,
    avatarUrl: record.avatar_url,
  });
  notifyAnalyticsIdentity();
  captureAnalytics("onboarding_step", {
    windowType: "launch",
    properties: { step: "auth_callback_succeeded", status: "complete", success: true },
  });

  if (launchWindow && !launchWindow.isDestroyed()) {
    launchWindow.webContents.send("launch:authComplete", record);
    launchWindow.show();
    launchWindow.focus();
  }
}

function getAuthenticatedUserForLaunch() {
  const user = getMostRecentAuthUser();
  if (!user?.provider_user_id || !user.email) return null;
  return user;
}

function requireAuthenticatedUserForLaunch() {
  const user = getAuthenticatedUserForLaunch();
  if (!user) throw new Error("Sign in is required before opening a project.");
  return user;
}

async function prepareBenchmarkLaunchState(): Promise<string | null> {
  if (!benchmarkEnabled) return null;
  const projectPath = process.env.PIPPER_BENCHMARK_PROJECT_PATH ?? process.cwd();
  upsertAuthUser({
    provider: "benchmark",
    providerUserId: "benchmark-local-user",
    email: "benchmark@localhost",
    name: "Thread Benchmark",
    avatarUrl: null,
  });
  const project =
    listProjects().find((candidate) => candidate.path === projectPath) ??
    createProject({ name: "Thread Benchmark", path: projectPath, icon: "gauge" });
  setSelectedAgentIds(["pipper-mock"]);
  await markLaunchComplete(project.id);
  setActiveProjectId(project.id);
  return project.id;
}

async function ensureAuthCallbackServer(): Promise<number> {
  if (authCallbackPort) return authCallbackPort;
  if (pendingAuthCallback) {
    await pendingAuthCallback;
    if (!authCallbackPort) throw new Error("Auth callback server failed to start.");
    return authCallbackPort;
  }

  pendingAuthCallback = new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end("Missing callback URL");
        return;
      }

      const requestUrl = new URL(req.url, `http://127.0.0.1:${authCallbackPort ?? 0}`);
      if (requestUrl.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const fullUrl = requestUrl.toString();
      void handleAuthCallback(fullUrl)
        .then(() => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(AUTH_CALLBACK_SUCCESS_HTML);
        })
        .catch((error) => {
          console.error("[Main] Auth callback handling failed:", error);
          captureAnalytics("onboarding_step", {
            windowType: "launch",
            properties: { step: "auth_callback_failed", status: "failed", success: false },
          });
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Auth callback failed");
        });
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to start auth callback server."));
        return;
      }
      authCallbackServer = server;
      authCallbackPort = address.port;
      resolve();
    });
  });

  try {
    await pendingAuthCallback;
  } finally {
    pendingAuthCallback = null;
  }

  if (!authCallbackPort) throw new Error("Auth callback server failed to start.");
  return authCallbackPort;
}

function getAuthCallbackUrl(): string {
  if (!authCallbackPort) {
    throw new Error("Auth callback server is not ready.");
  }
  return `http://127.0.0.1:${authCallbackPort}/auth/callback`;
}

function loadInto(
  win: BrowserWindow,
  page: "main" | "launch" | "monitor" | "settings",
  stage?: string,
): Promise<void> {
  logStartupMilestone("loadInto:start", `page=${page}${stage ? ` stage=${stage}` : ""}`);
  console.log(`[Main] loadInto - page: ${page}, stage: ${stage}, isDev: ${isDev}`);
  if (isDev) {
    const url = resolveRendererUrl(page, stage);
    console.log(`[Main] loadInto (dev) - loading url: ${url}`);
    return win.loadURL(url).then(() => {
      logStartupMilestone("loadInto:complete", `page=${page}`);
    });
  }
  const file = resolveRendererFile(page);
  const urlObj = pathToFileURL(file);
  if (stage) {
    urlObj.searchParams.set("stage", stage);
  }
  const fileUrl = urlObj.toString();
  console.log(`[Main] loadInto (prod) - loading file url: ${fileUrl}`);
  return win.loadURL(fileUrl).then(() => {
    logStartupMilestone("loadInto:complete", `page=${page}`);
  });
}

async function createMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    logStartupMilestone("main-window:reuse");
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  logStartupMilestone("main-window:create");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: generateRandomId(),
    show: false,
    icon: getIconPath(),
    backgroundColor: "#171717",
    titleBarStyle: "hidden",
    webPreferences: {
      preload: join(mainDir, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    logStartupMilestone("main-window:ready-to-show");
    mainWindow?.show();
    scheduleDeferredStartupWork();
  });

  // macOS delivers discrete page swipes separately from fluid scroll gestures.
  mainWindow.on("swipe", (_event, direction) => {
    if (direction === "left" || direction === "right") {
      sendMainWindowTabEvent("tabs:swipe", direction);
    }
  });

  mainWindow.webContents.once("dom-ready", () => {
    logStartupMilestone("main-renderer:dom-ready");
  });
  mainWindow.webContents.once("did-finish-load", () => {
    logStartupMilestone("main-renderer:did-finish-load");
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] [Level ${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.on("closed", () => {
    killAllPtyProcesses("WindowClosed");
    mainWindow = null;
    mainWindowFocused = false;
    windowVisibilityGate.setWindowVisible(false);
  });

  // Feed the visibility gate from window-level events; the renderer reports
  // document.visibilityState separately (covers full occlusion).
  mainWindow.on("minimize", () => windowVisibilityGate.setWindowVisible(false));
  mainWindow.on("restore", () => windowVisibilityGate.setWindowVisible(true));
  mainWindow.on("hide", () => windowVisibilityGate.setWindowVisible(false));
  mainWindow.on("show", () => windowVisibilityGate.setWindowVisible(true));
  mainWindow.on("focus", () => {
    mainWindowFocused = true;
  });
  mainWindow.on("blur", () => {
    mainWindowFocused = false;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    } else {
      console.warn(`[Main] Blocked external URL request: ${url}`);
    }
    return { action: "deny" };
  });

  void loadInto(mainWindow, "main");
}

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  const macWindowChrome =
    process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 18 },
        }
      : {};

  settingsWindow = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 860,
    minHeight: 600,
    title: "Settings",
    show: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    icon: getIconPath(),
    backgroundColor: "#fafafa",
    ...macWindowChrome,
    webPreferences: {
      preload: join(mainDir, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.on("ready-to-show", () => {
    settingsWindow?.show();
    settingsWindow?.focus();
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    } else {
      console.warn(`[Settings] Blocked external URL request: ${url}`);
    }
    return { action: "deny" };
  });

  void loadInto(settingsWindow, "settings");
}

function createMonitorWindow(): void {
  if (monitorWindow && !monitorWindow.isDestroyed()) {
    monitorWindow.show();
    monitorWindow.focus();
    return;
  }

  monitorWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: "Runtime Monitor",
    show: false,
    icon: getIconPath(),
    backgroundColor: "#171717",
    webPreferences: {
      preload: join(mainDir, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  monitorWindow.on("ready-to-show", () => {
    monitorWindow?.show();
  });

  monitorWindow.on("closed", () => {
    monitorWindow = null;
  });

  void loadInto(monitorWindow, "monitor");
}

function broadcastToMonitor(channel: string, payload: unknown): void {
  if (monitorWindow && !monitorWindow.isDestroyed()) {
    monitorWindow.webContents.send(channel, payload);
  }
}

function initializeMonitorService(): void {
  if (monitorService) return;
  if (!isMonitorEnabled()) {
    console.log("[Monitor] Disabled (PIPPER_MONITOR=0).");
    return;
  }

  monitorService = new MonitorService({
    getInventory: () =>
      buildMonitorInventory({
        mainPid: process.pid,
        rendererPid: mainWindow?.webContents.getOSProcessId() ?? null,
        agentManager,
        ptySessions: ptyProcesses,
      }),
    getRunningThreadIds: () => agentManager?.getRunningThreadIds() ?? [],
    onBroadcast: (channel, payload) => broadcastToMonitor(channel, payload),
    // Renderer observers switch DOM census/mutation tracking on demand.
    onDemandChange: (demand) => broadcastToWindows("monitor:demand", demand),
  });
  monitorService.start();

  agentManager?.setMonitorObserver({
    onConnectionSpawned: (event) => {
      monitorService?.noteConnectionStarted(event);
    },
    onConnectionReady: (event) => {
      monitorService?.noteConnectionReady(event);
    },
    onConnectionClosed: (event) => {
      monitorService?.noteConnectionLost({
        connectionId: event.connectionId,
        agentId: event.agentId,
        pid: event.pid,
        cause: "transport_closed",
        exitCode: null,
        signal: null,
        activeThreadId: event.activeThreadId,
        runningThreadIds: event.runningThreadIds,
        uptimeMs: Date.now() - event.spawnedAt,
        intentional: event.intentional,
        stderrTail: event.stderrTail,
      });
    },
    onConnectionExit: (event) => {
      monitorService?.noteConnectionLost({
        connectionId: event.connectionId,
        agentId: event.agentId,
        pid: event.pid,
        cause: "process_exit",
        exitCode: event.exitCode,
        signal: event.signal,
        activeThreadId: event.activeThreadId,
        runningThreadIds: event.runningThreadIds,
        uptimeMs: Date.now() - event.spawnedAt,
        intentional: event.intentional,
        stderrTail: event.stderrTail,
      });
    },
    onSwitchRecord: (record) => {
      monitorService?.reportSwitch(record);
    },
    onSessionCacheEvent: (event) => {
      monitorService?.reportSessionCacheEvent(event);
    },
    onAcpUpdate: (update) => {
      monitorService?.reportAcpUpdate(update);
    },
    onBridgeEvent: (event) => {
      monitorService?.reportBridgeEvent(event);
    },
  });

  setTabEventObserver((event) => {
    monitorService?.reportTabEvent(event);
  });
}

function createLaunchWindow(stage: "list" | "add" | "onboarding" = "list"): void {
  console.log(`[Main] createLaunchWindow - stage: ${stage}`);
  if (launchWindow && !launchWindow.isDestroyed()) {
    console.log("[Main] launchWindow already exists, reusing and loading stage:", stage);
    void loadInto(launchWindow, "launch", stage);
    launchWindow.show();
    launchWindow.focus();
    return;
  }

  console.log("[Main] Creating new launchWindow");
  launchWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    resizable: true,
    title: "Welcome to Pipper Code (Alpha)",
    show: false,
    icon: getIconPath(),
    backgroundColor: "#171717",
    webPreferences: {
      preload: join(mainDir, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  launchWindow.on("ready-to-show", () => {
    console.log("[Main] launchWindow ready-to-show");
    launchWindow?.show();
    scheduleDeferredStartupWork();
  });

  launchWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[Launch Renderer Console] [Level ${level}] ${message} (${sourceId}:${line})`);
  });

  launchWindow.on("closed", () => {
    console.log("[Main] launchWindow closed");
    launchWindow = null;
  });

  void loadInto(launchWindow, "launch", stage);
}

function broadcastToWindows(channel: string, ...args: any[]) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
  if (launchWindow && !launchWindow.isDestroyed()) {
    launchWindow.webContents.send(channel, ...args);
  }
  if (monitorWindow && !monitorWindow.isDestroyed()) {
    monitorWindow.webContents.send(channel, ...args);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, ...args);
  }
}

/** Keep renderer posthog-js identity stitched to main's alias chain. */
function notifyAnalyticsIdentity(): void {
  const distinctId = getAnalyticsDistinctId();
  if (distinctId) broadcastToWindows("analytics:identity", distinctId);
}

function sendMainWindowTabEvent(
  channel:
    | "tabs:selectByIndex"
    | "tabs:newTab"
    | "tabs:newTerminal"
    | "tabs:closeActive"
    | "tabs:swipe",
  ...args: unknown[]
) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, ...args);
  if (!mainWindow.isFocused()) mainWindow.focus();
}

function buildAppMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "Settings…",
                accelerator: "Command+,",
                click: () => createSettingsWindow(),
              },
              {
                label: "Send Test Notification",
                click: () => {
                  osNotifier({
                    kind: "turn-completed",
                    threadTitle: "Pipper",
                    detail: "If you can read this, OS notifications work.",
                  });
                },
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: "File",
      submenu: isMac
        ? [
            {
              label: "New Tab",
              accelerator: "CommandOrControl+T",
              click: () => sendMainWindowTabEvent("tabs:newTab"),
            },
            {
              label: "New Terminal",
              accelerator: "CommandOrControl+Shift+T",
              click: () => sendMainWindowTabEvent("tabs:newTerminal"),
            },
            {
              label: "Close Tab",
              accelerator: "CommandOrControl+W",
              click: () => sendMainWindowTabEvent("tabs:closeActive"),
            },
            {
              label: "Close Window",
              accelerator: "CommandOrControl+Shift+W",
              role: "close",
            },
          ]
        : [
            {
              label: "New Tab",
              accelerator: "CommandOrControl+T",
              click: () => sendMainWindowTabEvent("tabs:newTab"),
            },
            {
              label: "New Terminal",
              accelerator: "CommandOrControl+Shift+T",
              click: () => sendMainWindowTabEvent("tabs:newTerminal"),
            },
            {
              label: "Close Tab",
              accelerator: "CommandOrControl+W",
              click: () => sendMainWindowTabEvent("tabs:closeActive"),
            },
            {
              label: "Close Window",
              accelerator: "CommandOrControl+Shift+W",
              role: "close",
            },
            { type: "separator" },
            {
              label: "Settings…",
              accelerator: "CommandOrControl+,",
              click: () => createSettingsWindow(),
            },
            { type: "separator" },
            { role: "quit" },
          ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" as const },
        {
          label: "Runtime Monitor",
          accelerator: "CommandOrControl+Shift+M",
          click: () => createMonitorWindow(),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "Show Launch Window",
          click: () => createLaunchWindow(),
        },
      ],
    },
    {
      role: "window",
      submenu: [
        { role: "minimize" },
        ...(isMac
          ? ([{ type: "separator" }, { role: "front" }] as Electron.MenuItemConstructorOptions[])
          : ([{ role: "close" }] as Electron.MenuItemConstructorOptions[])),
        { type: "separator" },
        ...Array.from({ length: 9 }, (_, index) => {
          const tabNumber = index + 1;
          return {
            label: `Tab ${tabNumber}`,
            accelerator: `CommandOrControl+${tabNumber}`,
            click: () => sendMainWindowTabEvent("tabs:selectByIndex", index),
          } satisfies Electron.MenuItemConstructorOptions;
        }),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Check for Updates…",
          click: () => {
            void launcherUpdateManager?.check();
          },
        },
        {
          label: "Application Update Details…",
          click: () => {
            const noWindow =
              (!mainWindow || mainWindow.isDestroyed()) &&
              (!launchWindow || launchWindow.isDestroyed());
            if (noWindow) {
              createLaunchWindow();
              launchWindow?.webContents.once("did-finish-load", () =>
                launchWindow?.webContents.send("launcher-update:openDetails", {}),
              );
            }
            launcherUpdateManager?.showForSession();
            if (!noWindow) broadcastToWindows("launcher-update:openDetails", {});
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc(): void {
  ipcMain.on(
    "startup:renderer-milestone",
    (event, payload: { label?: unknown; rendererElapsedMs?: unknown }) => {
      if (event.sender !== mainWindow?.webContents) return;
      if (
        typeof payload?.label !== "string" ||
        !rendererStartupMilestoneLabels.has(payload.label)
      ) {
        return;
      }
      if (
        typeof payload.rendererElapsedMs !== "number" ||
        !Number.isFinite(payload.rendererElapsedMs)
      ) {
        return;
      }
      const key = `${event.sender.id}:${payload.label}`;
      if (reportedRendererStartupMilestones.has(key)) return;
      reportedRendererStartupMilestones.add(key);
      logStartupMilestone(
        `renderer:${payload.label}`,
        `renderer=${Math.round(payload.rendererElapsedMs)}ms`,
      );
      if (payload.label === "first-contentful-paint") {
        startDeferredStartupWork();
        startStartupAgentActivation("first-paint");
      }
    },
  );

  ipcMain.handle("launcher-update:check", () => requireLauncherUpdateManager().check());
  ipcMain.handle("launcher-update:getState", () => requireLauncherUpdateManager().getState());
  ipcMain.handle("launcher-update:isDismissedForSession", () =>
    requireLauncherUpdateManager().isDismissedForSession(),
  );
  ipcMain.handle("launcher-update:download", () => requireLauncherUpdateManager().download());
  ipcMain.handle("launcher-update:cancelDownload", () =>
    requireLauncherUpdateManager().cancelDownload(),
  );
  ipcMain.handle("launcher-update:dismissForSession", () => {
    const state = requireLauncherUpdateManager().dismissForSession();
    broadcastToWindows("launcher-update:dismissedForSession", {});
    return state;
  });
  ipcMain.handle("launcher-update:retryDownload", () =>
    requireLauncherUpdateManager().retryDownload(),
  );
  ipcMain.handle("launcher-update:openDownloadFolder", () =>
    requireLauncherUpdateManager().openDownloadFolder(),
  );
  ipcMain.handle("launcher-update:downloadInBrowser", () =>
    requireLauncherUpdateManager().downloadInBrowser(),
  );
  ipcMain.handle("launcher-update:clearDownloadedUpdate", () =>
    requireLauncherUpdateManager().clearDownloadedUpdate(),
  );
  ipcMain.handle("launcher-update:getDiagnostics", () =>
    requireLauncherUpdateManager().getDiagnostics(),
  );
  ipcMain.handle("launcher-update:copyDiagnostics", () =>
    requireLauncherUpdateManager().copyDiagnostics(),
  );
  ipcMain.handle("launcher-update:installAndQuit", async () => {
    const manager = requireLauncherUpdateManager();
    try {
      const path = await manager.verifyDownloadedInstaller();
      await launchLauncherInstaller(path);
      app.quit();
      return { success: true };
    } catch (error) {
      const state = manager.recordFailure(error);
      return { success: false, error: state.error ?? "Unable to open the installer." };
    }
  });

  ipcMain.handle("projects:list", () => listProjects());

  ipcMain.handle("github:getStatus", async () => {
    requireAuthenticatedUserForLaunch();
    const { getGitHubCliStatus } = await import("./github-onboarding.ts");
    return getGitHubCliStatus();
  });
  ipcMain.handle("github:listRepositories", async (_event, page?: number) => {
    requireAuthenticatedUserForLaunch();
    const { listGitHubRepositories } = await import("./github-onboarding.ts");
    return listGitHubRepositories(page);
  });
  ipcMain.handle("github:cloneRepository", async (_event, fullName: string) => {
    requireAuthenticatedUserForLaunch();
    const { cloneGitHubRepository } = await import("./github-onboarding.ts");
    return cloneGitHubRepository(fullName);
  });

  ipcMain.handle("siri:getCatalog", async () => {
    const { refreshSiriCatalog } = await import("./siri/siri-catalog.ts");
    return refreshSiriCatalog();
  });

  ipcMain.handle("siri:consumeRequest", async (_event, requestId: string) => {
    const thread = await consumeSiriRequest(requestId);
    if (thread) {
      const threadId = (thread as { id?: string })?.id;
      if (threadId) {
        const next = await openThreadTab(threadId);
        broadcastOpenTabsChanged(mainWindow, next);
        await requireAgentManager().switchThread(threadId);
      }
    }
    return thread;
  });

  ipcMain.handle("projects:getActive", () => {
    const id = getActiveProjectId();
    return id ? getProject(id) : null;
  });

  ipcMain.handle(
    "projects:listFiles",
    async (event, projectId?: string, worktreePath?: string | null, requestId?: string | null) => {
      // Request ids are scoped per renderer so one window cannot cancel
      // another window's scan.
      const scopedRequestId = requestId ? `${event.sender.id}:${requestId}` : null;
      const list = (path: string) => projectFileLister.listForRequest(path, scopedRequestId);
      if (projectId) {
        const project = getProject(projectId);
        const cwd = worktreePath && fs.existsSync(worktreePath) ? worktreePath : project?.path;
        return cwd && fs.existsSync(cwd) ? list(cwd) : [];
      }
      if (worktreePath && fs.existsSync(worktreePath)) return list(worktreePath);
      // Follow the active worktree's cwd, not the project root, so file paths
      // reflect the selected workspace. Falls back to the project root.
      const cwd = await requireAgentManager().getActiveCwd();
      if (cwd && fs.existsSync(cwd)) return list(cwd);
      const id = getActiveProjectId();
      const project = id ? getProject(id) : null;
      if (!project || !fs.existsSync(project.path)) return [];
      return list(project.path);
    },
  );

  ipcMain.on("projects:cancelListFiles", (event, requestId: unknown) => {
    if (typeof requestId !== "string" || !requestId) return;
    projectFileLister.cancel(`${event.sender.id}:${requestId}`);
  });

  ipcMain.handle(
    "projects:getFileTree",
    async (_event, projectId?: string | null, worktreePath?: string | null) => {
      // A caller that names its workspace (the Files panel, the basic tree)
      // gets that workspace's files, after checking it belongs to the project.
      if (projectId) {
        return listProjectFileTree(
          await filePreview.workspaceRoot(projectId, worktreePath ?? null),
        );
      }
      return listActiveFileTree();
    },
  );

  ipcMain.handle("files:stat", (_event, target: unknown) =>
    filePreview.stat(filePreviewTarget(target)),
  );
  ipcMain.handle("files:reveal", async (_event, target: unknown) => {
    const { real } = await filePreview.resolve(filePreviewTarget(target));
    shell.showItemInFolder(real);
  });
  ipcMain.handle("files:openExternal", async (_event, target: unknown) => {
    const { real, kind } = await filePreview.resolve(filePreviewTarget(target));
    // Only media and document formats: opening a script or executable with
    // its default app would run it.
    if (!canOpenExternally(real, kind)) {
      throw new Error("This file type can only be revealed, not opened.");
    }
    const error = await shell.openPath(real);
    if (error) throw new Error(error);
  });

  async function listActiveFileTree(): Promise<ProjectFileTreeSnapshot> {
    // Keep the flyout aligned with the currently selected worktree.
    const cwd = await requireAgentManager().getActiveCwd();
    if (cwd && fs.existsSync(cwd)) return listProjectFileTree(cwd);
    const id = getActiveProjectId();
    const project = id ? getProject(id) : null;
    if (!project || !fs.existsSync(project.path)) return { paths: [], gitStatus: [] };
    return listProjectFileTree(project.path);
  }

  ipcMain.handle(
    "projects:create",
    async (_event, input: { name: string; path: string; icon: string }) => {
      requireAuthenticatedUserForLaunch();
      const project = createProject(input);
      try {
        const { refreshSiriCatalog } = await import("./siri/siri-catalog.ts");
        refreshSiriCatalog();
      } catch (err) {
        console.warn("[Main] Siri catalog refresh failed after project create:", err);
      }
      captureAnalytics("project_created", {
        windowType: "launch",
        properties: {
          project_id: project.id,
          icon: project.icon ?? undefined,
        },
      });
      return project;
    },
  );

  ipcMain.handle("dialog:pickDirectory", async () => {
    const win = launchWindow ?? mainWindow ?? BrowserWindow.getFocusedWindow();
    const options: import("electron").OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose project folder",
      buttonLabel: "Select folder",
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle("worktrees:list", (_event, projectId: string) => {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    // Include the project root so the title bar can show its real branch
    // alongside the linked worktrees.
    return listWorktrees(project.path);
  });
  ipcMain.handle("worktrees:getAutoInstall", () => getWorktreeAutoInstall());
  ipcMain.handle("worktrees:setAutoInstall", (_event, enabled: boolean) =>
    setWorktreeAutoInstall(enabled),
  );
  // Read-only: reports per-workspace source vs. dependency/build bytes.
  ipcMain.handle("storage:workspaceUsage", () => scanWorkspaceDiskUsage());
  ipcMain.handle("storage:compactDatabase", () => {
    databaseCompaction ??= compactWhenIdle(join(app.getPath("userData"), "omni.sqlite")).finally(
      () => {
        databaseCompaction = null;
      },
    );
    return databaseCompaction;
  });

  ipcMain.handle("worktrees:switch", async (_event, input: { projectId: string; path: string }) => {
    const { thread } = await activateProjectWorktree(input.projectId, input.path);
    return thread;
  });

  // The persisted canonical workspace per project — the renderer hydrates its
  // selection map from this so header, tab scoping, and new-thread/terminal
  // targets agree after a relaunch.
  ipcMain.handle("worktrees:getSelections", () => readWorkspaceSelections());

  ipcMain.handle("worktrees:listBranches", (_event, input: { projectId: string }) => {
    const project = getProject(input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    return listBranches(project.path);
  });

  ipcMain.handle(
    "worktrees:switchBranch",
    async (_event, input: { projectId: string; path: string; branch: string }) => {
      const project = getProject(input.projectId);
      if (!project) throw new Error(`Project not found: ${input.projectId}`);

      const worktree = await switchWorktreeBranch(project.path, input.path, input.branch);
      try {
        const { thread } = await activateProjectWorktree(input.projectId, worktree.path);
        return { thread, worktree };
      } catch (err) {
        // Activation failed: restore the worktree state to match the mutated Git branch
        const restoredWorktree = (await listWorktrees(project.path)).find((w) =>
          samePath(w.path, input.path),
        );
        if (restoredWorktree) {
          return { thread: null, worktree: restoredWorktree };
        }
        throw err;
      }
    },
  );

  setWorkspaceSetupProgressSink((progress) =>
    broadcastToWindows("worktrees:setupProgress", progress),
  );
  ipcMain.handle("worktrees:create", async (_event, input: { projectId: string; name: string }) => {
    // Shared with remote/phone creation: the user's setup policy installs
    // dependencies in the background (installs can take minutes; the create
    // itself stays snappy) and streams progress to the renderer for toasts.
    const { project, worktree } = await createWorkspace({
      projectId: input.projectId,
      name: input.name,
      activation: "foreground",
    });
    captureAnalytics("worktree_created", {
      windowType: "main",
      properties: { project_id: project.id },
    });
    // Return the same annotated Git view used by the title bar, rather than
    // a locally invented display label for the newly-created checkout.
    return (
      (await listWorktrees(project.path)).find((item) => samePath(item.path, worktree.path)) ??
      worktree
    );
  });

  // First-party git for the advanced workspace UI. Every handler re-resolves
  // the worktree from the project's live worktree list so a stale renderer
  // path can never operate on an unrelated checkout.
  async function resolveWorkspaceTarget(projectId: string, path: string) {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const target = (await listWorktrees(project.path)).find((worktree) =>
      samePath(worktree.path, path),
    );
    if (!target) throw new Error("Workspace is no longer available");
    return target;
  }

  ipcMain.handle(
    "git:status",
    async (_event, input: { projectId: string; path: string; force?: boolean }) => {
      try {
        const target = await resolveWorkspaceTarget(input.projectId, input.path);
        return await getWorkspaceGitStatus(target.path, { force: input.force === true });
      } catch (err) {
        logMain(
          `[Main] git:status failed project=${input.projectId} path=${input.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    },
  );

  ipcMain.handle(
    "git:commit",
    async (_event, input: { projectId: string; path: string; message: string }) => {
      logMain(
        `[Main] git:commit project=${input.projectId} path=${input.path} msgLen=${input.message?.length ?? 0}`,
      );
      try {
        const target = await resolveWorkspaceTarget(input.projectId, input.path);
        const hash = await commitWorkspace(target.path, input.message);
        logMain(`[Main] git:commit ok ${hash}`);
        captureAnalytics("workspace_committed", {
          windowType: "main",
          properties: { project_id: input.projectId },
        });
        return { ok: true as const, message: `Committed ${hash}.` };
      } catch (err) {
        logMain(`[Main] git:commit failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  );

  ipcMain.handle("git:push", async (_event, input: { projectId: string; path: string }) => {
    logMain(`[Main] git:push project=${input.projectId} path=${input.path}`);
    try {
      const target = await resolveWorkspaceTarget(input.projectId, input.path);
      await pushWorkspace(target.path);
      logMain(`[Main] git:push ok`);
      captureAnalytics("workspace_pushed", {
        windowType: "main",
        properties: { project_id: input.projectId },
      });
      return { ok: true as const, message: "Pushed." };
    } catch (err) {
      logMain(`[Main] git:push failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  });

  ipcMain.handle(
    "git:createPr",
    async (
      _event,
      input: { projectId: string; path: string; title: string; body?: string; draft?: boolean },
    ) => {
      const target = await resolveWorkspaceTarget(input.projectId, input.path);
      const url = await createWorkspacePr(
        target.path,
        input.title,
        input.body,
        input.draft ?? false,
      );
      captureAnalytics("workspace_pr_created", {
        windowType: "main",
        properties: { project_id: input.projectId, draft: input.draft ?? false },
      });
      return { ok: true as const, message: "Pull request created.", url };
    },
  );

  ipcMain.handle("git:merge", async (_event, input: { projectId: string; path: string }) => {
    const project = getProject(input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    const target = await resolveWorkspaceTarget(input.projectId, input.path);
    if (!target.branch) throw new Error("Workspace has no branch to merge.");
    const base = await mergeWorkspaceBranch(project.path, target.branch);
    captureAnalytics("workspace_merged", {
      windowType: "main",
      properties: { project_id: input.projectId },
    });
    return { ok: true as const, message: `Merged into ${base}.` };
  });

  // Merge the open GitHub PR for the workspace branch (checks-gated in the UI).
  ipcMain.handle("git:mergePr", async (_event, input: { projectId: string; path: string }) => {
    const target = await resolveWorkspaceTarget(input.projectId, input.path);
    const status = await getWorkspaceGitStatus(target.path, { force: true });
    if (status.prDataState !== "fresh") {
      throw new Error("GitHub could not be refreshed. Reconnect before merging.");
    }
    if (!status.openPrNumber) throw new Error("No open pull request for this workspace.");
    const message = await mergeWorkspacePr(target.path, status.openPrNumber);
    captureAnalytics("workspace_pr_merged", {
      windowType: "main",
      properties: { project_id: input.projectId },
    });
    return { ok: true as const, message };
  });

  // Draft PR → ready for review. Checks-agnostic: it only flips the GitHub flag.
  ipcMain.handle("git:markPrReady", async (_event, input: { projectId: string; path: string }) => {
    const target = await resolveWorkspaceTarget(input.projectId, input.path);
    const status = await getWorkspaceGitStatus(target.path, { force: true });
    if (status.prDataState !== "fresh") {
      throw new Error("GitHub could not be refreshed. Reconnect before updating the pull request.");
    }
    if (!status.openPrNumber) throw new Error("No open pull request for this workspace.");
    if (!status.isDraftPr) throw new Error("Pull request is already ready for review.");
    const message = await markWorkspacePrReady(target.path, status.openPrNumber);
    return { ok: true as const, message };
  });

  // Whether a project root can host a workspace worktree. Read by the
  // create-workspace dialog before it offers a name, so a project with no
  // repo (or no commits) gets its fix instead of a raw git error.
  ipcMain.handle("git:projectRepoState", async (_event, projectId: string) => {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return getProjectRepoState(project.path);
  });

  ipcMain.handle(
    "git:init",
    async (_event, input: { projectId: string; name?: string | null; email?: string | null }) => {
      const project = getProject(input.projectId);
      if (!project) throw new Error(`Project not found: ${input.projectId}`);
      const state = await getProjectRepoState(project.path);
      // `ready` and `broken` are refused before the action runs: one is already
      // usable and the other must never have a repository created inside it
      // (see WorkspaceRepoState). Only `absent` and `unborn` have a fix here.
      if (state === "ready") throw new Error("This project is already a git repository.");
      if (state === "broken") {
        throw new Error(
          "This project's git state could not be read. The folder may have been moved or removed outside Pipper.",
        );
      }
      await initProjectRepo(project.path, { name: input.name, email: input.email });
      captureAnalytics("project_git_initialized", {
        windowType: "main",
        properties: { project_id: project.id },
      });
      return {
        ok: true as const,
        message:
          state === "unborn"
            ? "Initial commit created."
            : "Git repository initialized with an initial commit.",
      };
    },
  );

  // Continue after merge: new branch off the fresh base, same worktree.
  ipcMain.handle(
    "worktrees:continue",
    async (_event, input: { projectId: string; path: string }) => {
      const project = getProject(input.projectId);
      if (!project) throw new Error(`Project not found: ${input.projectId}`);
      const target = await resolveWorkspaceTarget(input.projectId, input.path);
      if (target.isProjectRoot) throw new Error("The project root cannot be continued.");
      const worktree = await continueWorktreeOnNewBranch(project.path, target.path);
      logMain(`[Main] worktrees:continue path=${target.path} branch=${worktree.branch}`);
      captureAnalytics("workspace_continued", {
        windowType: "main",
        properties: { project_id: input.projectId },
      });
      return worktree;
    },
  );

  ipcMain.handle("worktrees:delete", async (_event, input: { projectId: string; path: string }) => {
    const project = getProject(input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    const target = (await listWorktrees(project.path)).find(
      (worktree) => !worktree.isProjectRoot && samePath(worktree.path, input.path),
    );
    if (!target) throw new Error("Workspace is no longer available");
    const threads = listThreads().filter(
      (thread) =>
        thread.project_id === input.projectId &&
        thread.worktree_path != null &&
        samePath(thread.worktree_path, target.path),
    );
    const manager = requireAgentManager();
    const deletedThreadIds = new Set(threads.map((thread) => thread.id));
    const cleanupErrors: unknown[] = [];

    // Stop a queued or running dependency install so it cannot keep writing
    // into (or later recreate files in) the workspace being removed.
    await cancelWorkspaceSetup(target.path);
    // Remove the Git worktree first. If Git refuses because of a lock,
    // permissions, or a concurrent change, no chats have been deleted yet.
    const removed = await removeWorktree(project.path, target.path, project.id);
    // Terminals are owned by renderer workspace buckets. Notify it as soon
    // as Git removes the worktree, even if later chat cleanup fails.
    broadcastToWindows("worktrees:deleted", { projectId: project.id, path: target.path });

    // Run every cleanup operation even if one fails. Git has already removed
    // the workspace, so leaving the remaining tabs or threads untouched would
    // strand them against a path that no longer exists.
    //
    // One persisted write drops every deleted tab: a per-thread close could
    // fail midway and leave a stale ID in launch state that resurfaces after
    // restart, bound to a worktree that no longer exists.
    let tabs: OpenTabsState | null = null;
    try {
      tabs = await removeThreadTabs([...deletedThreadIds]);
    } catch (error) {
      console.error("[IPC] Failed to persist tab cleanup after worktree removal:", error);
      cleanupErrors.push(error);
    }

    const threadResults = await Promise.allSettled(
      threads.map((thread) => manager.deleteThread(thread.id)),
    );
    threadResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const threadId = threads[index]?.id ?? "unknown";
        console.error(
          `[IPC] Failed to delete thread ${threadId} after worktree removal:`,
          result.reason,
        );
        cleanupErrors.push(result.reason);
      }
    });

    try {
      // Fall back to the project's root checkout. Its path comes from the
      // live worktree list (the same value a root switch persists), not
      // `project.path`: for a project registered at a repository subdirectory
      // the two can differ, and the selection must name a real workspace.
      const rootWorktree = (await listWorktrees(project.path)).find(
        (worktree) => worktree.isProjectRoot,
      );
      await updateWorkspaceSelection(project.id, rootWorktree?.path ?? project.path);
    } catch (error) {
      console.error(
        `[IPC] Failed to reconcile workspace selection after deleting ${target.path}:`,
        error,
      );
      cleanupErrors.push(error);
    }

    // When the persisted tab write failed, stale IDs may remain on disk. Still
    // never broadcast them back to the renderer or reactivate a thread whose
    // workspace has just been removed — reconcile the in-memory view instead.
    let reconciledTabs: OpenTabsState | null = tabs;
    if (!reconciledTabs) {
      try {
        const persisted = await readOpenTabsState();
        const openThreadIds = persisted.openThreadIds.filter((id) => !deletedThreadIds.has(id));
        reconciledTabs = {
          openThreadIds,
          activeThreadId:
            persisted.activeThreadId && !deletedThreadIds.has(persisted.activeThreadId)
              ? persisted.activeThreadId
              : (openThreadIds[0] ?? null),
          threadSwitchHistory: persisted.threadSwitchHistory.filter(
            (id) => !deletedThreadIds.has(id),
          ),
        };
      } catch (error) {
        console.error("[IPC] Failed to read tabs after worktree cleanup:", error);
        cleanupErrors.push(error);
      }
    }

    try {
      const activeThreadId = reconciledTabs?.activeThreadId ?? manager.getState().threadId ?? null;
      if (activeThreadId && !deletedThreadIds.has(activeThreadId)) {
        if (manager.getState().threadId !== activeThreadId) {
          await manager.switchThread(activeThreadId);
        }
      } else {
        await manager.clearActiveThread();
      }
    } catch (error) {
      console.error("[IPC] Failed to reconcile active thread after worktree cleanup:", error);
      cleanupErrors.push(error);
    }

    if (reconciledTabs) broadcastOpenTabsChanged(mainWindow, reconciledTabs);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Workspace removed, but some chat cleanup failed");
    }
    return removed;
  });

  // Links surfaced from the workspace's own PR (CI runs, preview deploys,
  // review comments) live on arbitrary hosts. Scheme-gated only: never file:,
  // javascript:, or app-internal URLs.
  ipcMain.handle("shell:openHttps", async (_event, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid URL.");
    }
    if (parsed.protocol !== "https:") throw new Error("Only https links can be opened.");
    await shell.openExternal(parsed.toString());
  });

  ipcMain.handle("shell:openExternal", async (_event, url: string) => {
    await ensureAuthCallbackServer();
    const resolvedCallbackUrl = getAuthCallbackUrl();
    const appendReturnTo = (inputUrl: string): string =>
      withSignInParams(inputUrl, {
        returnTo: resolvedCallbackUrl,
        state: desktopIdentity().beginSignIn(),
        laptopId: desktopIdentity().laptopId(),
      });
    const resolvedUrl =
      url === "clerk:sign-up"
        ? appendReturnTo(resolveExternalUrl("clerkSignUp"))
        : url === "clerk:sign-in"
          ? appendReturnTo(resolveExternalUrl("clerkSignIn"))
          : url;

    // Only the Clerk entry points are funnel steps. Every other URL (setup
    // guides, docs) is a plain external link and must not show up as a sign-in.
    const authStep =
      url === "clerk:sign-up"
        ? "sign_up_initiated"
        : url === "clerk:sign-in"
          ? "sign_in_initiated"
          : null;
    try {
      await shell.openExternal(assertAllowedExternalUrl(resolvedUrl));
    } catch (error) {
      if (authStep) {
        captureAnalytics("onboarding_step", {
          windowType: "launch",
          properties: { step: authStep, status: "failed", success: false },
        });
      }
      throw error;
    }
    if (authStep) {
      captureAnalytics("onboarding_step", {
        windowType: "launch",
        properties: { step: authStep, status: "running", success: true },
      });
    }
  });

  // Allowlist: renderer can only emit these funnel steps. Anything else is
  // dropped so a compromised/buggy renderer can't explode PostHog cardinality.
  const ONBOARDING_STEPS = new Set([
    "sign_in_clicked",
    "sign_up_clicked",
    "auth_completed",
    "stage_agent_viewed",
    "stage_sleepless_viewed",
    "stage_shortcuts_viewed",
    "stage_list_viewed",
    "stage_add_viewed",
    "agent_pick_completed",
    "agent_repick_started",
    "sleepless_enabled",
    "sleepless_skipped",
    "sleepless_completed",
    "shortcuts_completed",
    "add_project_started",
    "add_project_completed",
    "add_project_abandoned",
    "github_project_opened",
    "project_opened",
    "project_open_failed",
  ]);
  const ONBOARDING_STATUSES = new Set(["viewed", "running", "complete", "skipped", "failed"]);
  ipcMain.handle(
    "analytics:trackOnboarding",
    (event, step: string, status: string, success?: boolean) => {
      // Only the launch window may emit launch-funnel events.
      if (event.sender !== launchWindow?.webContents) return;
      const cleanStep = String(step ?? "").slice(0, 80);
      const cleanStatus = String(status ?? "").slice(0, 24);
      if (!ONBOARDING_STEPS.has(cleanStep) || !ONBOARDING_STATUSES.has(cleanStatus)) return;
      captureAnalytics("onboarding_step", {
        windowType: "launch",
        properties: {
          step: cleanStep,
          status: cleanStatus,
          success: success ?? (cleanStatus !== "skipped" && cleanStatus !== "failed"),
        },
      });
    },
  );

  ipcMain.handle("launch:complete", async (_event, projectId: string) => {
    requireAuthenticatedUserForLaunch();

    const project = getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Background add: the user already has a live main window (e.g. they hit
    // "Add Project" from the header switcher). Registering the project must
    // not disturb their current threads/terminals — just close the launch
    // window and let the main window pick up the new entry in its list.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (launchWindow && !launchWindow.isDestroyed()) {
        launchWindow.close();
      }
      mainWindow.show();
      mainWindow.focus();
      broadcastToWindows("projects:listChanged", project);
      captureAnalytics("onboarding_step", {
        windowType: "launch",
        properties: {
          step: "launch_completed",
          status: "complete",
          success: true,
          project_id: projectId,
        },
      });
      return;
    }

    try {
      setActiveProjectId(projectId);
      await markLaunchComplete(projectId);
      await requireAgentManager().activateProject(projectId);
    } catch (error) {
      captureAnalytics("onboarding_step", {
        windowType: "launch",
        properties: {
          step: "launch_failed",
          status: "failed",
          success: false,
          project_id: projectId,
        },
      });
      throw error;
    }
    captureAnalytics("onboarding_step", {
      windowType: "launch",
      properties: {
        step: "launch_completed",
        status: "complete",
        success: true,
        project_id: projectId,
      },
    });

    if (launchWindow && !launchWindow.isDestroyed()) {
      launchWindow.close();
    }

    createMainWindow();
  });

  ipcMain.handle("launch:show", (_event, stage?: "list" | "add" | "onboarding") => {
    console.log("[Main] IPC launch:show - received stage:", stage);
    createLaunchWindow(stage);
  });

  ipcMain.handle("launch:getUser", () => {
    return getAuthenticatedUserForLaunch();
  });

  ipcMain.handle("projects:setActive", async (_event, projectId: string) => {
    requireAuthenticatedUserForLaunch();
    const project = getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const previousProjectId = getActiveProjectId();
    setActiveProjectId(projectId);
    try {
      await requireAgentManager().activateProject(projectId);
    } catch (err) {
      if (previousProjectId) setActiveProjectId(previousProjectId);
      console.error(`[Main] Failed to activate project ${projectId} in agent manager:`, err);
      throw err;
    }
    broadcastToWindows("projects:activeChanged", projectId);
  });

  ipcMain.handle("threads:list", () => {
    return listThreads();
  });

  ipcMain.handle("threads:listByIds", (_event, ids: string[]) => {
    return listThreadsByIds(ids);
  });

  ipcMain.handle(
    "threads:listProject",
    (_event, input: { projectId: string; limit?: number; offset?: number }) => {
      return listProjectThreads(input.projectId, input.limit, input.offset);
    },
  );

  ipcMain.handle(
    "threads:create",
    (
      _event,
      projectId: string,
      title: string | null,
      afterThreadId?: string | null,
      agentId?: string | null,
      worktreePath?: string | null,
    ) => {
      return requireAgentManager().createThread(
        projectId,
        title,
        afterThreadId ?? null,
        agentId ?? null,
        worktreePath ?? null,
      );
    },
  );

  ipcMain.handle("threads:rename", (_event, id: string, title: string) => {
    return requireAgentManager().renameThread(id, title);
  });

  ipcMain.handle("threads:delete", async (_event, id: string) => {
    const isPeer = makeWorkspacePeerPredicate(id);
    const manager = requireAgentManager();
    await manager.deleteThread(id);
    const next = await closeThreadTab(id, isPeer);
    await activateTabAfterClose(manager, next);
    broadcastOpenTabsChanged(mainWindow, next);
  });

  ipcMain.handle("tabs:listOpen", () => readOpenTabsState());
  ipcMain.handle("tabs:isFluidPageSwipeEnabled", () => isFluidPageSwipeEnabled());

  ipcMain.handle("tabs:open", async (_event, threadId: string) => {
    const next = await openThreadTab(threadId);
    broadcastOpenTabsChanged(mainWindow, next);
    return next;
  });

  ipcMain.handle("tabs:close", async (_event, threadId: string) => {
    const isPeer = makeWorkspacePeerPredicate(threadId);
    const manager = requireAgentManager();
    try {
      await manager.closeThreadSession(threadId);
    } catch (err) {
      console.warn("[IPC] closeThreadSession failed:", err);
    }
    const next = await closeThreadTab(threadId, isPeer);
    await activateTabAfterClose(manager, next);
    broadcastOpenTabsChanged(mainWindow, next);
    return next;
  });

  ipcMain.handle("tabs:setActive", async (_event, threadId: string | null) => {
    const next = await setActiveThreadTab(threadId);
    broadcastOpenTabsChanged(mainWindow, next);
    return next;
  });

  ipcMain.handle("tabs:getActive", async () => {
    return (await readOpenTabsState()).activeThreadId;
  });

  ipcMain.handle("agent:getState", () => {
    try {
      const state = requireAgentManager().getState();
      console.log(
        `[IPC] agent:getState returned state for project: ${state.projectId}, thread: ${state.threadId}`,
      );
      return state;
    } catch (e: any) {
      console.error("[IPC] agent:getState error:", e);
      throw e;
    }
  });
  ipcMain.handle("agent:getCommands", () => requireAgentManager().getCommands());
  ipcMain.handle("agent:getConfigOptions", () => requireAgentManager().getConfigOptions());
  ipcMain.handle("agent:getCapabilities", () => requireAgentManager().getCapabilities());
  ipcMain.handle("agent:getStats", () => requireAgentManager().getStats());
  ipcMain.handle("agent:getRunningThreads", () => requireAgentManager().getRunningThreadIds());
  ipcMain.handle("agent:getToolCalls", (_event, threadId: string, toolCallIds?: string[]) =>
    requireAgentManager().getToolCalls(threadId, toolCallIds),
  );
  ipcMain.handle("agent:sendPrompt", (_event, input) => {
    try {
      return requireAgentManager().sendPrompt(input);
    } catch (e: any) {
      console.error("[IPC] agent:sendPrompt error:", e);
      throw e;
    }
  });
  ipcMain.handle("agent:replacePrompt", (_event, input) =>
    requireAgentManager().replacePrompt(input),
  );
  ipcMain.handle("agent:abort", () => requireAgentManager().abort());
  ipcMain.handle("agent:switchThread", async (_event, threadId: string) => {
    const started = Date.now();
    try {
      // AgentConnectionManager records the switch for all activation paths and
      // returns the committed state. Reusing it avoids a duplicate launch
      // state read-modify-write here.
      const next = await requireAgentManager().switchThread(threadId);
      broadcastOpenTabsChanged(mainWindow, next);
      monitorService?.noteSwitchCompleted({
        threadId,
        durationMs: Date.now() - started,
        success: true,
      });
    } catch (e: any) {
      // A newer click took over this activation. That is the expected outcome
      // of clicking quickly through tabs, not a failed switch.
      if (isActivationSuperseded(e)) return;
      monitorService?.noteSwitchCompleted({
        threadId,
        durationMs: Date.now() - started,
        success: false,
        error: e?.message ?? String(e),
      });
      console.error("[IPC] agent:switchThread error:", e);
      throw e;
    }
  });
  ipcMain.handle(
    "agent:createThread",
    (
      _event,
      projectId: string,
      title: string | null,
      afterThreadId?: string | null,
      agentId?: string | null,
      worktreePath?: string | null,
      initialModelId?: string | null,
    ) => {
      try {
        return requireAgentManager().createThread(
          projectId,
          title,
          afterThreadId ?? null,
          agentId ?? null,
          worktreePath ?? null,
          initialModelId ?? null,
        );
      } catch (e: any) {
        console.error("[IPC] agent:createThread error:", e);
        throw e;
      }
    },
  );
  ipcMain.handle("agent:setConfigOption", (_event, configId: string, value: string | boolean) =>
    requireAgentManager().setConfigOption(configId, value),
  );
  ipcMain.handle("agent:respondToPermission", (_event, response) =>
    requireAgentManager().respondToPermission(response),
  );
  ipcMain.handle("agent:listAgents", () => requireAgentManager().listAgents());
  ipcMain.handle("agent:getModelCatalogs", (_event, options?: { refresh?: unknown }) =>
    requireAgentManager().getModelCatalogs({
      refresh: Array.isArray(options?.refresh)
        ? options.refresh.filter((id): id is string => typeof id === "string").slice(0, 8)
        : undefined,
    }),
  );
  ipcMain.handle("agent:probeAgent", async (_event, agentId: string) => {
    const result = await probeAgentById(agentId, { clientVersion: app.getVersion() });
    if (result.status !== "ready") {
      console.warn(
        `[probe] ${agentId}: ${result.status}${result.message ? ` — ${result.message}` : ""}`,
      );
    }
    return result;
  });
  ipcMain.handle("agent:authenticate", (_event, agentId: string, methodId: string) =>
    requireAgentManager().authenticateAgent(agentId, methodId),
  );
  ipcMain.handle("agent:switchAgent", (_event, agentId: string) =>
    requireAgentManager().switchAgent(agentId),
  );
  ipcMain.handle("agent:getPreferredAgentId", () => requireAgentManager().getPreferredAgentId());
  ipcMain.handle("agent:setPreferredAgentId", (_event, agentId: string) => {
    requireAgentManager().setPreferredAgentId(agentId);
  });
  ipcMain.handle("agent:getSelectedAgentIds", () => getSelectedAgentIds());
  ipcMain.handle("agent:setSelectedAgentIds", async (_event, agentIds: string[]) => {
    setSelectedAgentIds(agentIds);
    try {
      const { refreshSiriCatalog } = await import("./siri/siri-catalog.ts");
      refreshSiriCatalog();
    } catch (err) {
      console.warn("[Main] Siri catalog refresh failed after agent selection change:", err);
    }
  });
  ipcMain.handle("agent:listInstances", () => listAgentInstancesForRenderer());
  ipcMain.handle("agent:getAccountSchemas", () => listAgentAccountSchemas());
  ipcMain.handle("agent:createInstance", (_event, input) => {
    const created = createAgentInstance(input);
    broadcastToWindows("agent:instancesChanged", {});
    // Never ship decrypted secrets back to the renderer.
    return redactInstance(created);
  });
  ipcMain.handle("agent:updateInstance", (_event, id: string, input) => {
    const updated = updateAgentInstance(id, input);
    broadcastToWindows("agent:instancesChanged", {});
    return updated ? redactInstance(updated) : null;
  });
  ipcMain.handle("agent:deleteInstance", async (_event, id: string) => {
    // Reconcile live sessions/connection and the preferred pointer, then
    // delete (which re-points any threads at the driver's default instance).
    await agentManager?.removeAgentInstance(id);
    deleteAgentInstance(id);
    broadcastToWindows("agent:instancesChanged", {});
  });
  ipcMain.handle("agent:launchInstanceLogin", (_event, id: string) => launchInstanceLogin(id));
  ipcMain.handle("agent:closeThreadSession", (_event, threadId: string) =>
    requireAgentManager().closeThreadSession(threadId),
  );
  ipcMain.handle("agent:setEditorText", (_event, text: string) =>
    requireAgentManager().setEditorText(text),
  );
  ipcMain.handle("agent:getEditorText", () => requireAgentManager().getEditorText());
  ipcMain.handle("sleepless:getStatus", () => sleeplessController?.getStatus() ?? null);
  ipcMain.handle("sleepless:setEnabled", (_event, enabled: boolean) =>
    sleeplessController?.setEnabled(Boolean(enabled)),
  );
  ipcMain.handle("sleepless:setPreferences", (_event, preferences) =>
    sleeplessController?.setPreferences(preferences ?? {}),
  );
  ipcMain.handle("sleepless:refresh", () => sleeplessController?.refreshServiceStatus());
  ipcMain.handle("sleepless:openSystemSettings", () => sleeplessController?.openSystemSettings());
  ipcMain.handle(
    "remote:getInfo",
    () =>
      remoteAccess?.getInfo() ?? {
        enabled: false,
        serving: false,
        transport: "tailscale",
        publicUrl: null,
        tunnel: { state: "stopped" },
        host: null,
        port: null,
        error: null,
      },
  );
  ipcMain.handle("remote:setTransport", async (_event, transport: RemoteTransport) => {
    await remoteAccess?.setTransport(transport);
    return remoteAccess?.getInfo() ?? null;
  });
  ipcMain.handle("remote:getDevices", () => remoteAccess?.server.getDevicesState() ?? null);
  ipcMain.handle("remote:createPairing", (_event, options: { allowRun?: boolean } | undefined) => {
    const scopes: RemoteScope[] = options?.allowRun === false ? ["read"] : ["read", "run"];
    return remoteAccess?.server.createPairingOffer(scopes) ?? null;
  });
  ipcMain.handle("remote:cancelPairing", () => remoteAccess?.server.cancelPairingOffer());
  ipcMain.handle("remote:revokeDevice", (_event, id: string) =>
    typeof id === "string" ? (remoteAccess?.server.revokeDevice(id) ?? false) : false,
  );
  ipcMain.handle("remote:setStandby", (_event, active: boolean) =>
    sleeplessController?.setRemoteActive(Boolean(active)),
  );
  ipcMain.handle("agent:pasteToEditor", (_event, text: string) =>
    requireAgentManager().pasteToEditor(text),
  );
  ipcMain.on("agent:reportEditorText", (_event, text: string) => {
    requireAgentManager().reportEditorText(text);
  });
  ipcMain.on("window:reportVisibility", (_event, visible: unknown) => {
    windowVisibilityGate.setRendererVisible(visible === true);
  });

  ipcMain.handle("subagents:getConfig", () => requireAgentManager().getSubagentConfig());
  ipcMain.handle("subagents:setConfig", (_event, partial) =>
    requireAgentManager().setSubagentConfig(partial),
  );
  ipcMain.handle("subagents:listRuns", () => requireAgentManager().getSubagentRuns());

  ipcMain.handle(
    "widgets:getDocument",
    (_event, ref: unknown, theme: unknown): InlineWidgetDocument | null =>
      resolveWidgetDocument(sqliteWidgetStore, ref, theme),
  );

  ipcMain.handle("browser:getConfig", () => {
    if (!browserService) throw new Error("Browser service is not ready");
    return browserService.getConfig();
  });
  ipcMain.handle("browser:setConfig", (_event, partial: Partial<BrowserConfig>) => {
    if (!browserService) throw new Error("Browser service is not ready");
    return browserService.setConfig(partial);
  });

  ipcMain.handle("mcp:list", () => listMcpServers());
  ipcMain.handle("mcp:create", (_event, input) => createMcpServer(input));
  ipcMain.handle("mcp:update", (_event, id: string, input) => updateMcpServer(id, input));
  ipcMain.handle("mcp:delete", (_event, id: string) => {
    deleteMcpServer(id);
  });

  ipcMain.handle(
    "terminal:create",
    (_event, sessionId: string, cwd?: string, requestedCols?: number, requestedRows?: number) => {
      if (ptyProcesses.has(sessionId)) {
        logMain(`[Main] PTY session ${sessionId} is already active. Reusing it.`);
        return;
      }

      const defaultShell =
        process.env["SHELL"] || (process.platform === "win32" ? resolveWindowsShell() : "bash");
      const shellArgs: string[] = [];
      if (
        process.platform !== "win32" &&
        (defaultShell.endsWith("zsh") ||
          defaultShell.endsWith("bash") ||
          defaultShell.endsWith("sh"))
      ) {
        shellArgs.push("-l");
      }

      let spawnCwd = cwd || os.homedir();
      if (spawnCwd && !fs.existsSync(spawnCwd)) {
        logMain(
          `[Main] CWD directory does not exist: ${spawnCwd}. Falling back to home directory.`,
        );
        spawnCwd = os.homedir();
      }

      const { cols, rows } = normalizePtySize(requestedCols, requestedRows) ?? {
        cols: 80,
        rows: 24,
      };

      let ptyProcess: pty.IPty;
      try {
        logMain(
          `[Main] Spawning PTY session ${sessionId} - Shell: ${defaultShell}, Args: ${JSON.stringify(shellArgs)}, CWD: ${spawnCwd}, Size: ${cols}x${rows}`,
        );
        prependStandardPaths();
        ptyProcess = pty.spawn(defaultShell, shellArgs, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: spawnCwd,
          env: {
            ...process.env,
            TERM: "xterm-256color",
          } as Record<string, string>,
        });
      } catch (err) {
        logMain(
          `[Main] Error spawning PTY process for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }

      const dataDisposable = ptyProcess.onData((data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("terminal:data", { sessionId, data });
        }
      });
      let session!: RendererPtySession;
      const exitDisposable = ptyProcess.onExit(({ exitCode, signal }) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("terminal:exit", {
            sessionId,
            exitCode,
            signal,
          });
        }
        if (ptyProcesses.get(sessionId) === session) ptyProcesses.delete(sessionId);
        disposePtySession(session);
      });
      session = { process: ptyProcess, dataDisposable, exitDisposable };
      ptyProcesses.set(sessionId, session);
    },
  );

  ipcMain.handle(
    "terminal:write",
    (_event, { sessionId, data }: { sessionId: string; data: string }) => {
      const session = ptyProcesses.get(sessionId);
      if (!session) throw new Error(`Terminal session ${sessionId} is not running.`);
      try {
        session.process.write(data);
      } catch (error) {
        console.error(`Error writing to PTY ${sessionId}:`, error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    "terminal:resize",
    (_event, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) => {
      const session = ptyProcesses.get(sessionId);
      if (!session) throw new Error(`Terminal session ${sessionId} is not running.`);
      const safeSize = normalizePtySize(cols, rows);
      if (!safeSize) return;
      const { cols: safeCols, rows: safeRows } = safeSize;
      try {
        session.process.resize(safeCols, safeRows);
      } catch (error) {
        console.error(`Error resizing PTY ${sessionId}:`, error);
        throw error;
      }
    },
  );

  ipcMain.handle("terminal:kill", (_event, sessionId: string) => {
    const session = ptyProcesses.get(sessionId);
    if (session) {
      ptyProcesses.delete(sessionId);
      try {
        session.process.kill();
      } catch (error) {
        console.error(`Error killing PTY ${sessionId}:`, error);
      }
      disposePtySession(session);
    }
  });

  ipcMain.handle("theme:getCurrent", () => currentTheme);

  ipcMain.on("theme:changed", (_event, theme: string) => {
    currentTheme = normalizeTheme(theme);
    broadcastToWindows("theme:changed", currentTheme);
  });

  ipcMain.handle("analytics:getConfig", () => getAnalyticsConfig());
  ipcMain.handle("analytics:getDistinctId", () => getAnalyticsDistinctId());
  ipcMain.handle(
    "analytics:captureException",
    (_event, input: { name?: string; message?: string; stack?: string }) => {
      const error = new Error(input.message?.slice(0, 1000) || "Unknown renderer exception");
      error.name = input.name?.slice(0, 128) || "Error";
      if (input.stack) error.stack = input.stack.slice(0, 10_000);
      captureAnalyticsException(error, {
        source: "agent_panel",
        error_type: sanitizeErrorType(error),
      });
      logTelemetryError("Uncaught renderer exception", {
        error_type: sanitizeErrorType(error) ?? "Error",
      });
    },
  );

  ipcMain.handle("monitor:isEnabled", () => isMonitorEnabled());
  ipcMain.handle("monitor:getLive", () => monitorService?.getLiveSnapshot() ?? null);
  ipcMain.handle("monitor:getDemand", () => monitorService?.getDemand() ?? { detailed: false });
  // Live feed: full snapshot on subscribe, then deltas; acks bound in-flight messages.
  ipcMain.on("monitor:subscribe", (event) => {
    const sender = event.sender;
    if (!monitorService || sender.isDestroyed()) return;
    const id = sender.id;
    monitorService.subscribeLive(id, (message) => {
      if (sender.isDestroyed()) {
        monitorService?.unsubscribeLive(id);
        return;
      }
      sender.send("monitor:live", message);
    });
    if (liveFeedSenders.has(id)) return;
    // A reload or close ends the subscription; the new page subscribes again.
    liveFeedSenders.add(id);
    const end = () => monitorService?.unsubscribeLive(id);
    sender.on("did-navigate", end);
    sender.once("destroyed", () => {
      liveFeedSenders.delete(id);
      end();
    });
  });
  ipcMain.on("monitor:unsubscribe", (event) => monitorService?.unsubscribeLive(event.sender.id));
  ipcMain.on("monitor:ack", (event, revision: number) =>
    monitorService?.acknowledgeLive(event.sender.id, revision),
  );
  ipcMain.on("monitor:resync", (event) => monitorService?.resyncLive(event.sender.id));
  ipcMain.handle("monitor:getIncidents", () => monitorService?.getIncidents() ?? []);
  ipcMain.handle(
    "monitor:getConnectionEpisodes",
    () => monitorService?.getConnectionEpisodes() ?? [],
  );
  ipcMain.handle("monitor:getSessions", () => monitorService?.getSessions() ?? []);
  ipcMain.handle(
    "monitor:getRecordedSession",
    (_event, sessionId: string) =>
      monitorService?.getRecordedSession(sessionId) ?? emptyMonitorRecordedSession(),
  );
  ipcMain.handle("monitor:startRecording", (_event, label?: string) => {
    if (!monitorService) throw new Error("Monitor service is not initialized.");
    return monitorService.startRecording(label);
  });
  ipcMain.handle("monitor:stopRecording", () => monitorService?.stopRecording() ?? null);
  ipcMain.handle("monitor:reportRendererFreeze", (_event, report) => {
    monitorService?.reportRendererFreeze(report);
  });
  ipcMain.handle("monitor:reportRendererTelemetry", (_event, telemetry) => {
    monitorService?.reportRendererTelemetry(telemetry);
  });
  ipcMain.on("monitor:reportDiffIngestion", (_event, ingestion) => {
    monitorService?.reportDiffIngestion(ingestion);
  });
  ipcMain.handle("monitor:reportTabMismatch", (_event, report) => {
    monitorService?.reportTabMismatch(report);
  });
  ipcMain.handle("monitor:reportTabClickTiming", (_event, timing) => {
    monitorService?.reportTabClickTiming(timing);
  });
  ipcMain.handle("monitor:getSwitches", () => monitorService?.getSwitchRecords() ?? []);
  ipcMain.handle(
    "monitor:getSessionCacheEvents",
    () => monitorService?.getSessionCacheEvents() ?? [],
  );
  ipcMain.handle("monitor:getTabEvents", () => monitorService?.getTabEvents() ?? []);
  ipcMain.handle("monitor:getTabClickTimings", () => monitorService?.getTabClickTimings() ?? []);

  ipcMain.handle(
    "benchmark:status",
    () =>
      threadBenchmarkController?.status() ?? {
        enabled: false,
        prepared: null,
        run: null,
        rendererReady: null,
      },
  );
  ipcMain.handle("benchmark:prepare", (_event, openPath: ThreadBenchmarkOpenPath | undefined) => {
    if (!threadBenchmarkController) throw new Error("Benchmark controller is not initialized.");
    return threadBenchmarkController.prepare(openPath);
  });
  ipcMain.handle(
    "benchmark:start",
    (_event, mode: ThreadBenchmarkMode, openPath: ThreadBenchmarkOpenPath | undefined) => {
      if (!threadBenchmarkController) throw new Error("Benchmark controller is not initialized.");
      return threadBenchmarkController.start(mode, openPath);
    },
  );
  ipcMain.handle("benchmark:ingestTurn", () => {
    if (!threadBenchmarkController) throw new Error("Benchmark controller is not initialized.");
    return threadBenchmarkController.ingestTurn();
  });
  ipcMain.handle("benchmark:streamReset", () => {
    if (!threadBenchmarkController) throw new Error("Benchmark controller is not initialized.");
    return threadBenchmarkController.streamReset();
  });
  ipcMain.handle("benchmark:finish", () => {
    if (!threadBenchmarkController) throw new Error("Benchmark controller is not initialized.");
    return threadBenchmarkController.finish();
  });
  ipcMain.handle("benchmark:cleanup", () => threadBenchmarkController?.cleanup());
  ipcMain.on("benchmark:rendererReady", (_event, input: ThreadBenchmarkRendererReady) =>
    threadBenchmarkController?.reportRendererReady(input),
  );
  ipcMain.on("benchmark:streamReady", (_event, input: ThreadBenchmarkRendererReady) =>
    threadBenchmarkController?.reportStreamReady(input),
  );
  ipcMain.handle("monitor:getSwitchTimeline", () => monitorService?.getSwitchTimeline() ?? null);
  ipcMain.handle("monitor:openWindow", () => {
    createMonitorWindow();
  });

  // ─── Onboarding IPC ─────────────────────────────────────────────────────────────
  ipcMain.handle("onboarding:verifyGit", async () => {
    return await checkGit();
  });

  ipcMain.handle("onboarding:startSetup", async (event) => {
    const sendProgress = (step: string, status: string, error?: string, gitInstalled?: boolean) => {
      event.sender.send("onboarding:progress", {
        step,
        status,
        error,
        gitInstalled,
      });
      // Track the first-run setup funnel. The human step string is slugified to a
      // stable identifier; raw error text is never sent (it can contain paths).
      captureAnalytics("onboarding_step", {
        windowType: "launch",
        properties: {
          step: step
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 64),
          status,
          success: status !== "failed",
        },
      });
    };

    try {
      sendProgress("Checking Git installation...", "running");
      if (!(await checkGit())) {
        sendProgress("Installing Git...", "running", undefined, false);
        await installGit();
      }

      sendProgress("Pipper is ready!", "complete", undefined, true);
    } catch (err: any) {
      console.error("[Onboarding] Setup failed:", err);
      sendProgress("Setup failed.", "failed", err.message || String(err), true);
    }
  });
}

/**
// ─── Usage & duration tracking ──────────────────────────────────────────────
/** Wall-clock start of this app session; diffed on quit for session_duration_ms. */
const sessionStartedAt = Date.now();
const USAGE_HEARTBEAT_INTERVAL_MS = 60_000;
let usageHeartbeatTimer: NodeJS.Timeout | null = null;
const TELEMETRY_FLUSH_INTERVAL_MS = 15_000;
let telemetryFlushTimer: NodeJS.Timeout | null = null;

/**
 * Emit `app_heartbeat` every interval, but only while a window is focused, so the
 * sum of heartbeats measures *active* (attention) time rather than idle-open time.
 * Base properties already carry the active agent, so this is attributable per agent.
 */
function startUsageHeartbeat(): void {
  if (usageHeartbeatTimer) return;
  usageHeartbeatTimer = setInterval(() => {
    const focused = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
    if (!focused) return;
    captureAnalytics("app_heartbeat", {
      windowType: "background",
      properties: { heartbeat_seconds: USAGE_HEARTBEAT_INTERVAL_MS / 1000 },
    });
  }, USAGE_HEARTBEAT_INTERVAL_MS);
  usageHeartbeatTimer.unref?.();
}

/**
 * macOS commonly keeps Electron apps resident after their windows close. Flush
 * independently of quitting so exceptions are visible within seconds, not only
 * after the user explicitly exits the app.
 */
function startTelemetryFlush(): void {
  if (telemetryFlushTimer) return;
  telemetryFlushTimer = setInterval(() => {
    void Promise.all([flushAnalytics(), flushTelemetry()]).catch((error) => {
      console.error("[Telemetry] Periodic flush failed:", error);
    });
  }, TELEMETRY_FLUSH_INTERVAL_MS);
  telemetryFlushTimer.unref?.();
}

app.whenReady().then(async () => {
  logStartupMilestone("app:when-ready");
  startUsageHeartbeat();
  startTelemetryFlush();
  if (process.platform === "darwin") {
    const iconPath = getIconPath();
    if (iconPath) {
      try {
        app.dock?.setIcon(iconPath);
      } catch (err) {
        console.error("[Main] Failed to set macOS dock icon:", err);
      }
    }
  }
  buildAppMenu();
  logStartupMilestone("database:init:start");
  getDb();
  setLiveThreadIdsCheck((ids) => new Set(listThreadsByIds(ids).map((thread) => thread.id)));
  configureGithubPrSnapshotCache({
    read: getGithubPrSnapshot,
    write: saveGithubPrSnapshot,
  });
  logStartupMilestone("database:init:complete");
  // Seed per-driver default instances and wire instance→descriptor resolution
  // into the agent registry before anything spawns an agent.
  installAgentInstanceProvider();
  try {
    const { refreshSiriCatalog } = await import("./siri/siri-catalog.ts");
    refreshSiriCatalog();
  } catch (err) {
    console.warn("[Main] Siri catalog refresh failed at startup:", err);
  }
  await prepareBenchmarkLaunchState();
  const authUser = getAuthenticatedUserForLaunch();
  if (authUser) {
    identifyAnalyticsUser({
      providerUserId: authUser.provider_user_id,
      email: authUser.email,
      name: authUser.name,
      avatarUrl: authUser.avatar_url,
    });
    notifyAnalyticsIdentity();
  }
  browserService = new BrowserService({
    host: electronPageHost,
    widgetStore: sqliteWidgetStore,
    // Agents may browse localhost dev servers, but not Pipper's own renderer.
    appOrigins: () => {
      const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
      return rendererUrl ? [rendererUrl] : [];
    },
  });
  void browserService.init();
  agentManager = new AgentManager({
    // Electron resolves this from package.json's `version` field.
    clientVersion: app.getVersion(),
    sendToRenderer: sendToMainWindow,
    setWindowTitle: setMainWindowTitle,
    broadcastActiveProject: (projectId: string) => {
      broadcastToWindows("projects:activeChanged", projectId);
    },
    captureAnalytics: (name: AnalyticsEventName, properties: AnalyticsProperties) => {
      captureAnalytics(name, {
        windowType: "main",
        properties,
      });
    },
    onRunningThreadsChanged: (threadIds) => sleeplessController?.setRunningThreadIds(threadIds),
    setAgentContext: setActiveAgentContext,
    visibility: windowVisibilityGate,
    attention: { isFocused: () => mainWindowFocused },
    notify: osNotifier,
    browser: browserService,
  });
  // Database maintenance waits for agent turns to finish (see R15).
  applicationStorage.setBusyProbe(() => (agentManager?.getRunningThreadIds().length ?? 0) > 0);
  sleeplessController = new SleeplessController({
    platform: process.platform,
    settingsPath: join(app.getPath("userData"), "sleepless.json"),
    helperPath: resolveSleeplessHelperPath(process.execPath),
    unavailableReason: isDev
      ? "Lid-closed execution requires a packaged macOS app. Run bun run dist and open the generated app to configure it."
      : undefined,
    socketPath: process.env.PIPPER_SLEEPLESS_SOCKET_PATH,
    broadcast: (status) => broadcastToWindows("sleepless:statusChanged", status),
  });
  sleeplessController.setRunningThreadIds(agentManager.getRunningThreadIds());
  if (process.env.PIPPER_REMOTE_ENABLED !== "0") {
    const cloudflaredExe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    remoteAccess = new RemoteAccessController({
      userDataPath: app.getPath("userData"),
      // Dev builds default to their own port so they can run next to an
      // installed Pipper (which holds 4173) without failing to bind.
      port: process.env.PIPPER_REMOTE_PORT ? undefined : app.isPackaged ? undefined : 4183,
      serverDeps: {
        agentManager: () => agentManager,
        getUserDataPath: () => app.getPath("userData"),
        getRendererDir: () => join(mainDir, "../renderer"),
        devices: new RemoteDeviceStore(getDb()),
        onRemoteActiveChanged: (active) => sleeplessController?.setRemoteActive(active),
        onDevicesChanged: (state) => broadcastToWindows("remote:devicesChanged", state),
      },
      cloudflared: {
        overridePath: process.env.PIPPER_CLOUDFLARED_PATH?.trim() || null,
        bundledPath: app.isPackaged
          ? join(process.resourcesPath, "cloudflared", cloudflaredExe)
          : null,
      },
      getLaptopCredential: () => desktopIdentity().credential(),
      // Dev builds only: a tunnel you created yourself (token + its public
      // hostname). Packaged apps always get their own tunnel from pipper.dev.
      devTunnel:
        !app.isPackaged &&
        process.env.PIPPER_DEV_TUNNEL_TOKEN?.trim() &&
        process.env.PIPPER_DEV_TUNNEL_HOSTNAME?.trim()
          ? {
              token: process.env.PIPPER_DEV_TUNNEL_TOKEN.trim(),
              hostname: process.env.PIPPER_DEV_TUNNEL_HOSTNAME.trim().toLowerCase(),
            }
          : null,
      pipperApiBase: process.env.PIPPER_API_BASE?.trim() || undefined,
      remoteAppUrl: process.env.PIPPER_REMOTE_APP_URL?.trim() || undefined,
      onInfoChanged: (info) => broadcastToWindows("remote:infoChanged", info),
    });
    await remoteAccess.start();
    powerMonitor.on("resume", () => remoteAccess?.onResume());
    // Standby lease: an idle paired phone (authed request within the window)
    // keeps Sleepless armed even with zero running threads, so the laptop is
    // awake when the next phone task arrives.
    const leaseTimer = setInterval(() => {
      const running = agentManager?.getRunningThreadIds() ?? [];
      sleeplessController?.setRemoteActive(
        running.length > 0 || (remoteAccess?.server.hasLiveLease() ?? false),
      );
    }, 60_000);
    leaseTimer.unref?.();
    {
      // No credential is printed here: phones pair with a one-time code from
      // Settings → Remote, so nothing reusable ever lands in the log.
      const info = remoteAccess.getInfo();
      if (!info.serving) {
        console.warn("[Remote] Server failed to bind — remote access unavailable.");
      } else if (info.transport !== "tailscale") {
        console.log("[Remote] Serving on loopback; starting Cloudflare tunnel.");
      } else if (!info.publicUrl) {
        console.warn("[Remote] No Tailscale address — phones can't reach this laptop yet.");
      } else {
        console.log(
          `[Remote] Serving ${info.publicUrl}/remote — pair a phone from Settings → Remote.`,
        );
      }
      console.log(`[Remote] PATH=${process.env.PATH}`);
    }
  }
  threadBenchmarkController = new ThreadBenchmarkController({
    enabled: benchmarkEnabled,
    fixturePath: process.env.PIPPER_BENCHMARK_FIXTURE ?? null,
    outputDir: process.env.PIPPER_BENCHMARK_OUTPUT_DIR ?? null,
    projectId: () => getActiveProjectId(),
    agentManager: () => requireAgentManager(),
    monitorService: () => monitorService,
    broadcastTabs: (tabs) => broadcastOpenTabsChanged(mainWindow, tabs),
  });
  const launcherManifestUrl = resolveLauncherUpdateManifestUrl({
    platform: process.platform,
    macManifestUrl:
      process.env.PIPPER_LAUNCHER_UPDATE_MANIFEST_URL ??
      import.meta.env.VITE_PIPPER_LAUNCHER_UPDATE_MANIFEST_URL ??
      PIPPER_LAUNCHER_MAC_MANIFEST_URL,
    windowsManifestUrl:
      process.env.PIPPER_LAUNCHER_WINDOWS_UPDATE_MANIFEST_URL ??
      import.meta.env.VITE_PIPPER_LAUNCHER_WINDOWS_UPDATE_MANIFEST_URL ??
      PIPPER_LAUNCHER_WINDOWS_MANIFEST_URL,
  });
  const launcherUpdatesEnabled =
    app.isPackaged ||
    (process.env.PIPPER_ENABLE_LAUNCHER_UPDATES_IN_DEV === "1" && launcherManifestUrl != null);
  if (!launcherManifestUrl)
    console.info("[LauncherUpdate] Disabled: manifest URL is not configured.");
  // One-time migration: previous releases stored launcher-update state
  // under ~/Library/pipper; the App Group relocation must reuse it instead
  // of stranding completed downloads.
  let launcherRoot = join(getPipperLibraryPath(), "launcher-updates");
  if (process.platform === "darwin" && !process.env.PIPPER_LIBRARY_PATH) {
    try {
      const legacyRoot = join(os.homedir(), "Library", "pipper", "launcher-updates");
      if (
        legacyRoot !== launcherRoot &&
        fs.existsSync(legacyRoot) &&
        !fs.existsSync(join(launcherRoot, "state.json"))
      ) {
        fs.mkdirSync(launcherRoot, { recursive: true });
        fs.cpSync(legacyRoot, launcherRoot, { recursive: true, force: false });
      }
    } catch (err) {
      console.warn("[LauncherUpdate] Legacy migration failed:", err);
    }
  }
  launcherUpdateManager = new LauncherUpdateManager({
    currentVersion: app.getVersion(),
    manifestUrl: launcherManifestUrl,
    rootPath: launcherRoot,
    enabled: launcherUpdatesEnabled,
    broadcastState: (state) => broadcastToWindows("launcher-update:stateChanged", state),
    broadcastProgress: (progress) => broadcastToWindows("launcher-update:progress", progress),
  });
  registerIpc();
  registerFilePreviewProtocol();

  logStartupMilestone("launch-state:read:start");
  const state = await readLaunchState();
  logStartupMilestone("launch-state:read:complete", `completed=${state.completed}`);
  const currentAuthUser = getAuthenticatedUserForLaunch();
  if (state.completed && currentAuthUser) {
    if (state.projectId) {
      setActiveProjectId(state.projectId);
    }
    logStartupMilestone("main-window:starting-before-agent-activation");
    void createMainWindow();
    // Siri/Shortcuts requests staged before launch (and deep links that
    // arrived before the agent manager existed) are consumed only once the
    // window is on its way up, and never awaited: consumption creates threads
    // and talks to agents, which must not gate first paint.
    void drainStartupSiriRequests();
    if (state.projectId) {
      // ACP activation spawns and handshakes with child processes. It must not
      // overlap Chromium's renderer bootstrap or first paint. The renderer's
      // initial getState call remains the authoritative catch-up path.
      pendingStartupAgentProjectId = state.projectId;
      startupAgentActivationStarted = false;
      mainWindow?.once("ready-to-show", () => {
        startupAgentActivationFallback = setTimeout(
          () => startStartupAgentActivation("fallback"),
          2000,
        );
        startupAgentActivationFallback.unref?.();
      });
    }
  } else {
    logStartupMilestone("launch-window:starting");
    createLaunchWindow("list");
  }

  app.on("activate", async () => {
    await consumePendingSiriRequests().catch((err) => {
      console.error("[Main] Failed to consume pending Siri requests on activation:", err);
    });
    const hasMain = mainWindow && !mainWindow.isDestroyed();
    const hasLaunch = launchWindow && !launchWindow.isDestroyed();
    if (!hasMain && !hasLaunch) {
      void readLaunchState().then((s) => {
        const authUser = getAuthenticatedUserForLaunch();
        if (s.completed && authUser) {
          if (s.projectId) {
            setActiveProjectId(s.projectId);
            // Restoring a closed main window follows the same first-paint
            // boundary as cold startup: do not compete with Chromium while
            // this renderer is rebuilding.
            pendingStartupAgentProjectId = s.projectId;
            startupAgentActivationStarted = false;
          }
          void createMainWindow();
          if (s.projectId) {
            mainWindow?.once("ready-to-show", () => {
              startupAgentActivationFallback = setTimeout(
                () => startStartupAgentActivation("fallback"),
                2000,
              );
              startupAgentActivationFallback.unref?.();
            });
          }
        } else {
          createLaunchWindow("list");
        }
      });
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Hidden agent browser pages are windows too, so window-all-closed never fires
// while an agent has a page open. Quit when the last *app* window closes.
app.on("browser-window-created", (_event, window) => {
  window.once("closed", () => {
    if (process.platform === "darwin" || isAgentBrowserWindow(window)) return;
    const appWindows = BrowserWindow.getAllWindows().filter(
      (candidate) => !candidate.isDestroyed() && !isAgentBrowserWindow(candidate),
    );
    if (appWindows.length === 0) app.quit();
  });
});

/**
 * Overall budget for the will-quit cleanup chain. Each step has its own bound
 * inside it; whatever is still pending at the deadline is abandoned.
 */
const QUIT_CLEANUP_DEADLINE_MS = 10_000;
/** Hard backstop past the deadline, should `app.quit()` itself not exit. */
const QUIT_FORCE_EXIT_GRACE_MS = 3_000;
/** Prevents re-entrant will-quit after cleanup finished and we call app.quit(). */
let quitCleanupFinished = false;
/** True once the bounded dispose/flush chain from will-quit has started. */
let quitCleanupStarted = false;

// Anything that ends the process without the will-quit chain (app.exit, a
// fatal path) still must not leave provider processes behind.
process.on("exit", () => {
  killAllProviderProcessesSync();
});

app.on("will-quit", (event) => {
  // Ensure PostHog identify / $set person-profile batches flush before the
  // process exits. Without this, short sessions can drop email/avatar entirely.
  if (quitCleanupFinished) return;
  event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;

  authCallbackServer?.close();
  launcherUpdateManager?.stopPeriodicChecks();
  if (usageHeartbeatTimer) {
    clearInterval(usageHeartbeatTimer);
    usageHeartbeatTimer = null;
  }
  if (telemetryFlushTimer) {
    clearInterval(telemetryFlushTimer);
    telemetryFlushTimer = null;
  }
  captureAnalytics("app_closed", {
    windowType: "background",
    properties: { session_duration_ms: Date.now() - sessionStartedAt },
  });
  killAllPtyProcesses("Quit");
  monitorService?.stop();

  // Quit must always complete. runShutdownSteps already resolves by the
  // deadline; this covers a quit that still does not exit after it.
  setTimeout(() => {
    console.error("[Main] Quit did not complete; terminating providers and exiting");
    killAllProviderProcessesSync();
    app.exit(0);
  }, QUIT_CLEANUP_DEADLINE_MS + QUIT_FORCE_EXIT_GRACE_MS);

  void runShutdownSteps(
    [
      // Shells exit on SIGHUP within milliseconds; never leave one running.
      // Includes shells stopped when the windows closed just before quit.
      { name: "terminal shells", timeoutMs: 1_500, run: () => Promise.all(stoppingPtyShells) },
      // Snapshot flush (bounded inside dispose) plus provider SIGTERM → SIGKILL.
      { name: "agent manager", timeoutMs: 8_000, run: () => agentManager?.dispose() },
      {
        // Reap whatever dispose could not reach in time before slower,
        // network-bound steps run.
        name: "provider processes",
        timeoutMs: 1_000,
        run: () => killAllProviderProcessesSync(),
      },
      { name: "remote server", timeoutMs: 2_000, run: () => remoteAccess?.dispose() },
      { name: "Sleepless", timeoutMs: 2_000, run: () => sleeplessController?.dispose() },
      { name: "analytics flush", timeoutMs: 2_000, run: () => shutdownAnalytics() },
      { name: "telemetry flush", timeoutMs: 2_000, run: () => shutdownTelemetry() },
    ],
    { deadlineMs: QUIT_CLEANUP_DEADLINE_MS },
  ).finally(() => {
    killAllProviderProcessesSync();
    quitCleanupFinished = true;
    // Cleanup is complete, so exit directly. A second app.quit() issued while
    // Electron is still unwinding the quit this handler prevented is ignored
    // (the steps can all settle within a millisecond), which left the app
    // running until the backstop below.
    app.exit(0);
  });
});

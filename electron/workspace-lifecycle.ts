import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { Project } from "../contracts/projects.ts";
import type {
  WorkspaceActivation,
  WorkspaceSetupPolicy,
  Worktree,
  WorktreeSetupProgress,
} from "../contracts/worktrees.ts";
import { getProject } from "./projects.ts";
import { getProjectSetupScript } from "./project-setup-script.ts";
import {
  createWorktree,
  foreignGitEnv,
  removeWorktreeBestEffort,
  resolveInstallCommand,
} from "./worktree-manager.ts";
import { WorktreeInstallQueue } from "./worktree-install-queue.ts";
import { getWorktreeAutoInstall } from "./worktree-preferences.ts";

/**
 * One lifecycle for every entry point that creates a workspace (desktop IPC,
 * phone/remote tasks, Siri). Creation, the dependency-setup policy, setup job
 * ownership and rollback live here so a workspace is prepared the same way no
 * matter who asked for it.
 *
 * Setup, in the background after creation (one job at a time, cancellable
 * when the workspace is removed):
 * - A project with a setup script (see project-setup-script.ts) runs that
 *   script under either policy; it replaces the automatic install.
 * - Otherwise `prepared` installs JavaScript dependencies with the detected
 *   package manager, and `source-only` creates only the Git checkout.
 * When a caller does not choose a policy, the user's automatic-install
 * preference decides. Activation is separate: `background` setup never raises desktop
 * notifications for progress, so remote work does not pull UI focus.
 */

const WORKTREE_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** Setup scripts may build as well as install, so they get longer. */
const WORKTREE_SETUP_SCRIPT_TIMEOUT_MS = 20 * 60 * 1000;
/** After asking an installer to stop, force-kill it, then stop waiting. */
const WORKTREE_INSTALL_KILL_GRACE_MS = 5_000;

export type WorkspaceSetupOutcome = Pick<
  WorktreeSetupProgress,
  "status" | "source" | "manager" | "message"
>;

export interface WorkspaceSetupJob {
  projectId: string;
  worktreePath: string;
  workspaceName: string;
  policy: WorkspaceSetupPolicy;
  activation: WorkspaceActivation;
}

type ProgressSink = (progress: WorktreeSetupProgress) => void;
type InstallRunner = (
  job: WorkspaceSetupJob,
  signal: AbortSignal,
) => Promise<WorkspaceSetupOutcome>;
type ScriptRunner = (
  job: WorkspaceSetupJob,
  script: string,
  signal: AbortSignal,
) => Promise<WorkspaceSetupOutcome>;

let progressSink: ProgressSink = () => {};
let installRunner: InstallRunner = runDependencyInstall;
let scriptRunner: ScriptRunner = runProjectSetupScript;
const installQueue = new WorktreeInstallQueue();

/** Wire setup progress to the renderer (main process) or a test recorder. */
export function setWorkspaceSetupProgressSink(sink: ProgressSink | null): void {
  progressSink = sink ?? (() => {});
}

/** Test hook: replace the package-manager run with a fake. */
export function setWorkspaceInstallRunnerForTests(runner: InstallRunner | null): void {
  installRunner = runner ?? runDependencyInstall;
}

/** Test hook: replace the setup-script run with a fake. */
export function setWorkspaceScriptRunnerForTests(runner: ScriptRunner | null): void {
  scriptRunner = runner ?? runProjectSetupScript;
}

export function resolveWorkspaceSetupPolicy(
  requested?: WorkspaceSetupPolicy,
): WorkspaceSetupPolicy {
  if (requested) return requested;
  return getWorktreeAutoInstall() ? "prepared" : "source-only";
}

function report(job: WorkspaceSetupJob, outcome: WorkspaceSetupOutcome): WorkspaceSetupOutcome {
  progressSink({
    projectId: job.projectId,
    worktreePath: job.worktreePath,
    workspaceName: job.workspaceName,
    policy: job.policy,
    activation: job.activation,
    ...outcome,
  });
  return outcome;
}

/**
 * Apply the setup policy to an existing workspace. Never throws — a failed
 * install must not undo the created worktree, it just reports; the outcome is
 * also returned so callers that must wait (restore) can act on it.
 */
export function setUpWorkspace(job: WorkspaceSetupJob): Promise<WorkspaceSetupOutcome> {
  return installQueue.enqueue(job.worktreePath, async (signal) => {
    // The workspace may have been deleted while this job waited in the queue.
    if (signal.aborted || !existsSync(job.worktreePath)) {
      return report(job, { status: "skipped", message: "Workspace was removed before install." });
    }
    const script = getProjectSetupScript(job.projectId);
    if (script) {
      report(job, { status: "installing", source: "script" });
      return report(job, { source: "script", ...(await scriptRunner(job, script, signal)) });
    }
    const install = resolveInstallCommand(job.worktreePath);
    if (!install) return report(job, { status: "skipped" });
    if (job.policy === "source-only") {
      return report(job, {
        status: "skipped",
        manager: install.manager,
        message: `Run ${install.manager} install in this workspace when you need its dependencies.`,
      });
    }
    report(job, { status: "installing", manager: install.manager });
    return report(job, await installRunner(job, signal));
  });
}

/** Stop (or drop the queued) setup for a workspace that is going away. */
export function cancelWorkspaceSetup(worktreePath: string): Promise<void> {
  return installQueue.cancel(worktreePath);
}

export interface CreateWorkspaceRequest {
  projectId: string;
  name: string;
  /** Omitted: follow the automatic-install preference. */
  setup?: WorkspaceSetupPolicy;
  /** `background` keeps setup progress out of desktop notifications. */
  activation: WorkspaceActivation;
}

export interface CreatedWorkspace {
  project: Project;
  worktree: Worktree;
  policy: WorkspaceSetupPolicy;
  /** Settles with the setup outcome; never rejects. */
  setup: Promise<WorkspaceSetupOutcome>;
  /**
   * Undo this creation: stop its setup job and remove the worktree and
   * branch this call created. Callers use it only while nothing else (a
   * thread) has bound to the workspace.
   */
  rollback: () => Promise<void>;
}

export class WorkspaceProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project not found: ${projectId}`);
    this.name = "WorkspaceProjectNotFoundError";
  }
}

/**
 * Create a workspace and start its setup. A failed `createWorktree` already
 * rolls back only what it created; a failure after that is the caller's to
 * undo through `rollback`.
 */
export async function createWorkspace(request: CreateWorkspaceRequest): Promise<CreatedWorkspace> {
  const project = getProject(request.projectId);
  if (!project) throw new WorkspaceProjectNotFoundError(request.projectId);
  const policy = resolveWorkspaceSetupPolicy(request.setup);
  const worktree = await createWorktree({
    projectPath: project.path,
    projectId: project.id,
    name: request.name,
  });
  const setup = setUpWorkspace({
    projectId: project.id,
    worktreePath: worktree.path,
    workspaceName: request.name,
    policy,
    activation: request.activation,
  });
  return {
    project,
    worktree,
    policy,
    setup,
    rollback: async () => {
      await cancelWorkspaceSetup(worktree.path);
      await removeWorktreeBestEffort(project.path, worktree.path, worktree.branch);
    },
  };
}

/**
 * Signal an installer and every process it started. Package managers spawn
 * their own children, and on Windows the direct child is the shell, so
 * killing only `child` can leave the real installer writing files.
 */
function signalProcessTree(child: ChildProcess, force: boolean): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on(
      "error",
      () => child.kill(),
    );
    return;
  }
  try {
    // The installer runs as its own process group leader (detached spawn).
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

interface SetupProcess {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell?: boolean;
  /** Names the job in timeout/exit errors, e.g. "bun install". */
  label: string;
  timeoutMs: number;
}

/**
 * Run one setup process in its own process group. Resolves on exit code 0;
 * rejects with the last lines of output otherwise. A timeout or abort stops
 * the whole tree and settles only once it has exited, so a cancelled setup
 * cannot keep writing into a workspace being removed.
 */
function runSetupProcess(spec: SetupProcess, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: spec.shell ?? false,
      // Own process group on POSIX so cancellation can stop the whole tree.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputTail = "";
    const collect = (chunk: Buffer) => {
      outputTail = (outputTail + chunk.toString()).slice(-4000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let stopError: unknown = null;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    const stop = (error: unknown) => {
      if (stopError) return;
      stopError = error;
      clearTimeout(timeout);
      signalProcessTree(child, false);
      forceTimer = setTimeout(() => {
        signalProcessTree(child, true);
        // A process that survives SIGKILL must not hang workspace deletion.
        forceTimer = setTimeout(() => rejectPromise(stopError), WORKTREE_INSTALL_KILL_GRACE_MS);
      }, WORKTREE_INSTALL_KILL_GRACE_MS);
    };
    const minutes = Math.round(spec.timeoutMs / 60_000);
    const timeout = setTimeout(
      () => stop(new Error(`${spec.label} timed out after ${minutes} minutes.`)),
      spec.timeoutMs,
    );
    const onAbort = () => stop(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      signal.removeEventListener("abort", onAbort);
      rejectPromise(new Error(`Could not run ${spec.label}: ${err.message}. Is it installed?`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      signal.removeEventListener("abort", onAbort);
      if (stopError) rejectPromise(stopError);
      else if (code === 0) resolvePromise();
      else {
        const tail = outputTail.trim().split("\n").slice(-8).join("\n");
        rejectPromise(new Error(`${spec.label} exited with code ${code}.\n${tail}`));
      }
    });
  });
}

async function runDependencyInstall(
  job: WorkspaceSetupJob,
  signal: AbortSignal,
): Promise<WorkspaceSetupOutcome> {
  const install = resolveInstallCommand(job.worktreePath);
  if (!install) return { status: "skipped" };
  try {
    await runSetupProcess(
      {
        command: install.command,
        args: install.args,
        cwd: job.worktreePath,
        env: process.env,
        shell: process.platform === "win32",
        label: `${install.manager} install`,
        timeoutMs: WORKTREE_INSTALL_TIMEOUT_MS,
      },
      signal,
    );
    return { status: "installed", manager: install.manager };
  } catch (err) {
    if (signal.aborted) {
      return {
        status: "skipped",
        manager: install.manager,
        message: "Install stopped because the workspace was removed.",
      };
    }
    console.error(`[Worktree] Dependency install failed for ${job.worktreePath}:`, err);
    return {
      status: "failed",
      manager: install.manager,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Shells whose syntax accepts `set -e` and `-l -c <script>`. */
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * How to run a setup script. POSIX: the user's login shell (so tools on
 * their own PATH, e.g. cargo, uv or nvm, are found), stopping at the first
 * failing line. Windows: `cmd` with the lines joined by `&&`.
 */
export function setupScriptInvocation(
  script: string,
  platform: NodeJS.Platform = process.platform,
  userShell: string | undefined = process.env.SHELL,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const lines = script
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !/^rem(\s|$)/i.test(line));
    return { command: "cmd.exe", args: ["/d", "/s", "/c", lines.join(" && ")] };
  }
  const name = userShell?.split("/").pop() ?? "";
  const shell = userShell && POSIX_SHELLS.has(name) ? userShell : "/bin/sh";
  return { command: shell, args: ["-l", "-c", `set -e\n${script}`] };
}

async function runProjectSetupScript(
  job: WorkspaceSetupJob,
  script: string,
  signal: AbortSignal,
): Promise<WorkspaceSetupOutcome> {
  const project = getProject(job.projectId);
  const invocation = setupScriptInvocation(script);
  try {
    await runSetupProcess(
      {
        ...invocation,
        cwd: job.worktreePath,
        env: {
          ...foreignGitEnv(),
          WORKSPACE_PATH: job.worktreePath,
          WORKSPACE_NAME: job.workspaceName,
          ROOT_PATH: project?.path ?? job.worktreePath,
        },
        label: "Setup script",
        timeoutMs: WORKTREE_SETUP_SCRIPT_TIMEOUT_MS,
      },
      signal,
    );
    return { status: "installed" };
  } catch (err) {
    if (signal.aborted) {
      return {
        status: "skipped",
        message: "Setup script stopped because the workspace was removed.",
      };
    }
    console.error(`[Worktree] Setup script failed for ${job.worktreePath}:`, err);
    return { status: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

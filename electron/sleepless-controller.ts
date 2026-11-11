import { execFile as execFileCallback } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, posix } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_SLEEPLESS_PREFERENCES,
  type SleeplessPreferences,
  type SleeplessServiceStatus,
  type SleeplessStatus,
} from "../contracts/sleepless.ts";

const execFile = promisify(execFileCallback);
const DEFAULT_SOCKET_PATH = "/var/run/com.maker-or.omni.sleeplessd.sock";
const HEARTBEAT_INTERVAL_MS = 3_000;
const CONNECT_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 4_000;

interface NativeState {
  armed?: boolean;
  lidClosed?: boolean;
  onBattery?: boolean;
  batteryPercent?: number;
  armedAt?: number;
}

interface NativeResponse extends NativeState {
  id?: string;
  ok: boolean;
  error?: string;
}

interface PendingRequest {
  resolve: (value: NativeResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class SleeplessSocket extends EventEmitter {
  private readonly socketPath: string;
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private buffer = "";
  private sequence = 0;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
  }

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      const timer = setTimeout(() => {
        socket.destroy(new Error("Sleepless daemon connection timed out."));
      }, CONNECT_TIMEOUT_MS);
      socket.setEncoding("utf8");
      socket.setNoDelay(true);
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this.installSocketListeners(socket);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        if (this.socket !== socket) socket.destroy();
        reject(error);
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async request(command: string, payload: Record<string, unknown> = {}): Promise<NativeResponse> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Sleepless daemon is not connected.");
    const id = `req_${Date.now()}_${++this.sequence}`;
    return new Promise<NativeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Sleepless daemon ${command} request timed out.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ version: 1, id, command, payload })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.end();
    this.rejectPending(new Error("Sleepless daemon connection closed."));
  }

  private installSocketListeners(socket: net.Socket): void {
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.handleLine(line);
        newline = this.buffer.indexOf("\n");
      }
    });
    const closed = (error?: Error) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.buffer = "";
      this.rejectPending(error ?? new Error("Sleepless daemon disconnected."));
      this.emit("close", error);
    };
    socket.on("close", () => closed());
    socket.on("error", (error) => closed(error));
  }

  private handleLine(line: string): void {
    let response: NativeResponse;
    try {
      response = JSON.parse(line) as NativeResponse;
    } catch {
      return;
    }
    if (!response.id) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error || "Sleepless daemon rejected the request."));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export interface SleeplessControllerOptions {
  platform: NodeJS.Platform;
  settingsPath: string;
  helperPath: string;
  unavailableReason?: string;
  socketPath?: string;
  broadcast: (status: SleeplessStatus) => void;
  runHelper?: (helperPath: string, command: string) => Promise<string>;
}

export function helperFailureOutput(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === "string" && stdout.trim() ? stdout : null;
}

export class SleeplessController {
  private readonly options: SleeplessControllerOptions;
  private preferences: SleeplessPreferences = { ...DEFAULT_SLEEPLESS_PREFERENCES };
  private serviceStatus: SleeplessServiceStatus;
  private phase: SleeplessStatus["phase"] = "disabled";
  private runningTaskCount = 0;
  private remoteActive = false;
  private armedAt: number | null = null;
  private lidClosed: boolean | null = null;
  private onBattery: boolean | null = null;
  private batteryPercent: number | null = null;
  private error: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private reconciliation: Promise<void> = Promise.resolve();
  private readonly socket: SleeplessSocket;
  private readonly runHelper: (helperPath: string, command: string) => Promise<string>;

  constructor(options: SleeplessControllerOptions) {
    this.options = options;
    this.serviceStatus = options.platform === "darwin" ? "not-registered" : "unsupported";
    this.socket = new SleeplessSocket(options.socketPath ?? DEFAULT_SOCKET_PATH);
    this.runHelper =
      options.runHelper ??
      (async (helperPath, command) => {
        const timeout = command === "register" ? 120_000 : 10_000;
        try {
          const { stdout } = await execFile(helperPath, [command], { timeout });
          return stdout;
        } catch (error) {
          const output = helperFailureOutput(error);
          if (output) return output;
          throw error;
        }
      });
    this.socket.on("close", (socketError?: Error) => {
      if (this.disposed) return;
      this.stopHeartbeat();
      this.armedAt = null;
      // Same demand as reconcile(): remote standby keeps it armed with no tasks.
      if (this.preferences.enabled && this.hasDemand()) {
        this.phase = "connecting";
        this.error = socketError?.message ?? "Sleepless daemon disconnected.";
        this.scheduleReconnect();
      } else {
        this.phase = this.preferences.enabled ? "disarmed" : "disabled";
      }
      this.publish();
    });
  }

  async initialize(): Promise<SleeplessStatus> {
    await this.loadPreferences();
    await this.refreshServiceStatus();
    if (
      this.preferences.enabled &&
      (this.serviceStatus === "not-registered" || this.serviceStatus === "not-found")
    ) {
      await this.registerService();
    }
    await this.queueReconcile();
    return this.getStatus();
  }

  getStatus(): SleeplessStatus {
    return {
      supported: this.options.platform === "darwin" && !this.options.unavailableReason,
      serviceStatus: this.serviceStatus,
      phase: this.phase,
      preferences: { ...this.preferences },
      runningTaskCount: this.runningTaskCount,
      lidClosed: this.lidClosed,
      onBattery: this.onBattery,
      batteryPercent: this.batteryPercent,
      armedAt: this.armedAt,
      error: this.error,
    };
  }

  async setEnabled(enabled: boolean): Promise<SleeplessStatus> {
    if (!enabled) {
      this.preferences.enabled = false;
      await this.savePreferences();
      this.error = null;
      await this.disarm(false);
      this.phase = "disabled";
      this.publish();
      return this.getStatus();
    }
    this.preferences.enabled = true;
    this.error = null;
    if (this.options.unavailableReason) {
      this.serviceStatus = "unsupported";
      this.preferences.enabled = false;
      await this.savePreferences();
      this.phase = "error";
      this.error = this.options.unavailableReason;
      this.publish();
      return this.getStatus();
    }
    if (this.options.platform !== "darwin") {
      this.serviceStatus = "unsupported";
      this.preferences.enabled = false;
      await this.savePreferences();
      this.phase = "error";
      this.error = "Lid-closed execution is only available on macOS.";
      this.publish();
      return this.getStatus();
    }
    const registered = await this.registerService();
    if (!registered && this.serviceStatus !== "requires-approval") {
      this.preferences.enabled = false;
      await this.savePreferences();
      this.phase = "error";
      this.publish();
      return this.getStatus();
    }
    await this.savePreferences();
    await this.queueReconcile();
    return this.getStatus();
  }

  async setPreferences(
    partial: Partial<Pick<SleeplessPreferences, "acOnly" | "batteryFloor" | "maxDurationMinutes">>,
  ): Promise<SleeplessStatus> {
    this.preferences = sanitizePreferences({ ...this.preferences, ...partial });
    await this.savePreferences();
    if (this.armedAt) {
      await this.disarm(false);
      await this.queueReconcile();
    }
    this.publish();
    return this.getStatus();
  }

  setRunningThreadIds(threadIds: readonly string[]): void {
    const count = new Set(threadIds).size;
    if (count === this.runningTaskCount && !this.remoteActive) return;
    this.runningTaskCount = count;
    void this.queueReconcile();
    this.publish();
  }

  /** Phone paired / remote standby: stay armed on AC even with no tasks. */
  setRemoteActive(active: boolean): void {
    if (active === this.remoteActive) return;
    this.remoteActive = active;
    void this.queueReconcile();
    this.publish();
  }

  async refreshServiceStatus(): Promise<SleeplessStatus> {
    if (this.options.unavailableReason) {
      this.serviceStatus = "unsupported";
      this.phase = "error";
      this.error = this.options.unavailableReason;
      this.publish();
      return this.getStatus();
    }
    if (this.options.platform !== "darwin") {
      this.serviceStatus = "unsupported";
      this.publish();
      return this.getStatus();
    }
    if (!existsSync(this.options.helperPath)) {
      this.serviceStatus = "not-found";
      this.phase = this.preferences.enabled ? "error" : "disabled";
      this.error = this.preferences.enabled
        ? "The Sleepless helper is missing from this app build."
        : null;
      this.publish();
      return this.getStatus();
    }
    try {
      const output = await this.runHelper(this.options.helperPath, "status");
      const result = JSON.parse(output.trim()) as {
        status?: SleeplessServiceStatus;
        error?: string;
      };
      this.serviceStatus = result.status ?? "error";
      this.error = result.error ?? this.serviceErrorMessage();
    } catch (error) {
      this.serviceStatus = "error";
      this.error = errorMessage(error);
    }
    this.phase = this.idlePhase();
    this.publish();
    return this.getStatus();
  }

  async openSystemSettings(): Promise<void> {
    if (!existsSync(this.options.helperPath)) return;
    await this.runHelper(this.options.helperPath, "open-settings");
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
    this.stopHeartbeat();
    await this.disarm(true);
    this.socket.close();
  }

  private async registerService(): Promise<boolean> {
    if (!existsSync(this.options.helperPath)) {
      this.serviceStatus = "not-found";
      this.phase = "error";
      this.error = "The Sleepless helper is missing from this app build.";
      this.publish();
      return false;
    }
    try {
      const output = await this.runHelper(this.options.helperPath, "register");
      const result = JSON.parse(output.trim()) as {
        status?: SleeplessServiceStatus;
        error?: string;
      };
      this.serviceStatus = result.status ?? "error";
      this.phase = this.idlePhase();
      this.error = result.error ?? this.serviceErrorMessage();
    } catch (error) {
      await this.refreshServiceStatus();
      if (this.serviceStatus !== "requires-approval") {
        this.phase = "error";
        this.error = errorMessage(error);
      }
    }
    this.publish();
    return this.serviceStatus === "enabled" || this.serviceStatus === "requires-approval";
  }

  private queueReconcile(): Promise<void> {
    this.reconciliation = this.reconciliation.then(
      () => this.reconcile(),
      () => this.reconcile(),
    );
    return this.reconciliation;
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return;
    if (!this.preferences.enabled || this.serviceStatus !== "enabled" || !this.hasDemand()) {
      await this.disarm(!this.hasDemand());
      this.phase = this.idlePhase();
      this.publish();
      return;
    }
    if (this.armedAt && this.socket.connected) return;
    this.phase = "connecting";
    this.error = null;
    this.publish();
    try {
      const response = await this.socket.request("ARM", {
        activeTasks: this.runningTaskCount,
        batteryFloor: this.preferences.batteryFloor,
        maxDurationSec: this.preferences.maxDurationMinutes * 60,
        acOnly: this.preferences.acOnly,
      });
      this.applyNativeState(response);
      this.armedAt = response.armedAt ?? Date.now();
      this.phase = "armed";
      this.error = null;
      this.startHeartbeat();
    } catch (error) {
      this.phase = "error";
      this.error = errorMessage(error);
      this.armedAt = null;
      this.scheduleReconnect();
    }
    this.publish();
  }

  private async disarm(triggerSleepIfLidClosed: boolean): Promise<void> {
    this.stopHeartbeat();
    if (this.socket.connected && this.armedAt) {
      try {
        const response = await this.socket.request("DISARM", { triggerSleepIfLidClosed });
        this.applyNativeState(response);
      } catch (error) {
        this.error = errorMessage(error);
      }
    }
    this.armedAt = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      void this.socket
        .request("HEARTBEAT", { activeTasks: this.runningTaskCount })
        .then((response) => {
          this.applyNativeState(response);
          this.publish();
        })
        .catch((error) => {
          this.error = errorMessage(error);
          this.socket.close();
        });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnect || this.disposed || !this.preferences.enabled) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      void this.refreshServiceStatus().then(() => this.queueReconcile());
    }, 2_000);
    this.reconnect.unref?.();
  }

  private applyNativeState(state: NativeState): void {
    if (typeof state.lidClosed === "boolean") this.lidClosed = state.lidClosed;
    if (typeof state.onBattery === "boolean") this.onBattery = state.onBattery;
    if (typeof state.batteryPercent === "number") this.batteryPercent = state.batteryPercent;
  }

  private async loadPreferences(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.settingsPath, "utf8"));
      this.preferences = sanitizePreferences({ ...DEFAULT_SLEEPLESS_PREFERENCES, ...parsed });
    } catch {
      this.preferences = { ...DEFAULT_SLEEPLESS_PREFERENCES };
    }
    this.phase = this.preferences.enabled ? "disarmed" : "disabled";
  }

  private async savePreferences(): Promise<void> {
    await mkdir(dirname(this.options.settingsPath), { recursive: true });
    await writeFile(this.options.settingsPath, `${JSON.stringify(this.preferences, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  private publish(): void {
    this.options.broadcast(this.getStatus());
  }

  /** Something wants the Mac awake: a running task, or a paired phone on standby. */
  private hasDemand(): boolean {
    return this.runningTaskCount > 0 || this.remoteActive;
  }

  private idlePhase(): SleeplessStatus["phase"] {
    if (!this.preferences.enabled) return "disabled";
    return this.serviceStatus === "not-found" ||
      this.serviceStatus === "error" ||
      this.serviceStatus === "unsupported"
      ? "error"
      : "disarmed";
  }

  private serviceErrorMessage(): string | null {
    if (!this.preferences.enabled) return null;
    if (this.serviceStatus === "not-found") {
      return "The Sleepless service is not available in this app build.";
    }
    if (this.serviceStatus === "error") return "Unable to inspect the Sleepless service.";
    return null;
  }
}

function sanitizePreferences(input: SleeplessPreferences): SleeplessPreferences {
  return {
    enabled: Boolean(input.enabled),
    acOnly: input.acOnly !== false,
    batteryFloor: clampNumber(input.batteryFloor, 10, 80, 20),
    maxDurationMinutes: clampNumber(input.maxDurationMinutes, 15, 12 * 60, 240),
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, number));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveSleeplessHelperPath(execPath: string): string {
  // This helper only exists in a macOS app bundle. Using posix explicitly also
  // keeps Windows CI from interpreting the fixture path with backslashes.
  return posix.join(posix.dirname(execPath), "omni-sleeplessctl");
}

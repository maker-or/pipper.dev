import type {
  MonitorFreezeSource,
  MonitorDomAttribution,
  MonitorRendererFreezeReport,
  MonitorRendererTelemetry,
} from "../../contracts/monitor.ts";

const RUNTIME_SAMPLE_INTERVAL_MS = 5000;
/**
 * Without a monitor window or recording, the DOM census (attribution walk)
 * runs on every Nth telemetry sample only, at idle; mutation tracking is off.
 */
const BACKGROUND_CENSUS_EVERY_SAMPLES = 12;
const FREEZE_EPISODE_QUIET_MS = 1500;
/** How long the RAF gap sampler keeps running after the last activity. */
const FREEZE_RAF_ARM_MS = 3000;
const DOM_ATTRIBUTION_SELECTOR = "[data-pipper-id]";
const MAX_DOM_ATTRIBUTIONS = 24;

// Keep this list intentionally small. The observer runs in the renderer and
// should identify the important ownership boundaries without turning every
// decorative element into telemetry.
const DOM_ATTRIBUTION_IDS = new Set([
  "agent-panel",
  "reading-column",
  "messages-list",
  "assistant-message",
  "user-message",
  "assistant-trace-deck",
  "assistant-thinking-step",
  "assistant-tool-step",
  "assistant-markdown",
  "shiki-code-block",
  "code-block",
  "diff-summary-card",
  "diff-view",
  "project-file-tree",
  "global-tab-bar",
  "agent-selector",
  "agent-terminal-output",
]);

export interface RendererMonitorContext {
  observerId: string;
  getActiveThreadId: () => string | null;
  getRunningThreadIds: () => string[];
  /** True while a monitor window or recording wants detailed DOM attribution. */
  isDetailed?: () => boolean;
}

interface DiffCounters {
  diffIngestionCount: number;
  diffIngestionMs: number;
  diffSerializedUtf16Bytes: number;
  diffExtractedFileCount: number;
  diffChangedFileCount: number;
}

interface RuntimePauseCounters {
  longTaskCount: number;
  longTaskMs: number;
  gcPauseCount: number;
  gcPauseMs: number;
}

export interface RendererEventRecord {
  eventType: string;
  bytes: number;
  isActive: boolean;
  applyMs: number;
  ignored?: boolean;
  buffered?: boolean;
  coalesced?: boolean;
  dropped?: boolean;
}

function emptyRendererEventStats(): MonitorRendererTelemetry["rendererEvents"] {
  return {
    receivedCount: 0,
    receivedBytes: 0,
    activeCount: 0,
    backgroundCount: 0,
    applyMs: 0,
    maxApplyMs: 0,
    ignoredCount: 0,
    bufferedCount: 0,
    coalescedCount: 0,
    droppedCount: 0,
    tabClickCount: 0,
    scrollCount: 0,
    paintCount: 0,
    eventToPaintMs: 0,
    maxEventToPaintMs: 0,
    maxEventsPerSecond: 0,
    ipcBurstCount: 0,
    maxBurstSize: 0,
    longTaskDuringBurstMs: 0,
    missedFrameDuringBurstCount: 0,
  };
}

let diffCounters: DiffCounters = emptyDiffCounters();
let diffGauges = { diffThreadCount: 0, diffToolCallCount: 0, diffFileCount: 0 };
let pauseCounters: RuntimePauseCounters = emptyPauseCounters();
let rendererEventStats = emptyRendererEventStats();
let eventRateWindowStartedAt = 0;
let eventRateWindowCount = 0;
let tabClickActiveUntil = 0;
let scrollActiveUntil = 0;
let pendingEventPaint: { startedAt: number; count: number } | null = null;
let lastRendererEventAt = 0;
let currentBurstSize = 0;
// Set while a freeze observer runs; keeps its frame sampler armed during activity.
let armFreezeSampler: (() => void) | null = null;

interface DomMutationCounters {
  addedNodeCount: number;
  removedNodeCount: number;
  mutationCount: number;
}

function emptyDiffCounters(): DiffCounters {
  return {
    diffIngestionCount: 0,
    diffIngestionMs: 0,
    diffSerializedUtf16Bytes: 0,
    diffExtractedFileCount: 0,
    diffChangedFileCount: 0,
  };
}

function emptyPauseCounters(): RuntimePauseCounters {
  return { longTaskCount: 0, longTaskMs: 0, gcPauseCount: 0, gcPauseMs: 0 };
}

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function createId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createMonitorObserverId(): string {
  return createId("renderer");
}

function rendererContext(): Pick<MonitorRendererTelemetry, "visibilityState" | "focused"> {
  return {
    visibilityState: document.visibilityState,
    focused: document.hasFocus(),
  };
}

function heapStats(): Pick<
  MonitorRendererTelemetry,
  "jsHeapUsedBytes" | "jsHeapTotalBytes" | "jsHeapLimitBytes"
> {
  const memory = (
    performance as Performance & {
      memory?: {
        usedJSHeapSize?: number;
        totalJSHeapSize?: number;
        jsHeapSizeLimit?: number;
      };
    }
  ).memory;
  return {
    jsHeapUsedBytes: finiteOrNull(memory?.usedJSHeapSize),
    jsHeapTotalBytes: finiteOrNull(memory?.totalJSHeapSize),
    jsHeapLimitBytes: finiteOrNull(memory?.jsHeapSizeLimit),
  };
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeDomAttributionId(value: string): string | null {
  if (DOM_ATTRIBUTION_IDS.has(value)) return value;
  if (value.startsWith("agent-terminal-")) return "agent-terminal-output";
  if (value.startsWith("terminal-panel-")) return "agent-terminal-output";
  if (value.startsWith("thread-tab-") || value.startsWith("terminal-tab-")) return "global-tab-bar";
  if (value.startsWith("agent-option-") || value.startsWith("agent-setup-"))
    return "agent-selector";
  return null;
}

function countElementNodes(node: Node): number {
  if (node.nodeType !== 1) return 0;
  return 1 + (node as Element).getElementsByTagName("*").length;
}

function findAttributionId(node: Node): string | null {
  let element: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
  while (element) {
    const rawId = element.getAttribute("data-pipper-id");
    const id = rawId ? normalizeDomAttributionId(rawId) : null;
    if (id) return id;
    element = element.parentElement;
  }
  return null;
}

function collectDomAttributions(
  previousNodeCounts: Map<string, number>,
  mutations: Map<string, DomMutationCounters>,
): MonitorDomAttribution[] {
  const nodeCounts = new Map<string, number>();
  for (const element of document.querySelectorAll(DOM_ATTRIBUTION_SELECTOR)) {
    const rawId = element.getAttribute("data-pipper-id");
    const id = rawId ? normalizeDomAttributionId(rawId) : null;
    if (!id) continue;
    nodeCounts.set(id, (nodeCounts.get(id) ?? 0) + countElementNodes(element));
  }

  const ids = new Set([...previousNodeCounts.keys(), ...nodeCounts.keys(), ...mutations.keys()]);
  const attributions = [...ids].map((id) => {
    const nodeCount = nodeCounts.get(id) ?? 0;
    const mutation = mutations.get(id);
    return {
      id,
      nodeCount,
      nodeDelta: nodeCount - (previousNodeCounts.get(id) ?? 0),
      addedNodeCount: mutation?.addedNodeCount ?? 0,
      removedNodeCount: mutation?.removedNodeCount ?? 0,
      mutationCount: mutation?.mutationCount ?? 0,
    } satisfies MonitorDomAttribution;
  });

  previousNodeCounts.clear();
  for (const [id, count] of nodeCounts) previousNodeCounts.set(id, count);
  mutations.clear();

  return attributions
    .sort((a, b) => b.nodeCount - a.nodeCount || b.nodeDelta - a.nodeDelta)
    .slice(0, MAX_DOM_ATTRIBUTIONS);
}

export function recordDiffIngestion(input: {
  threadCount: number;
  toolCallCount: number;
  fileCount: number;
  durationMs: number;
  serializedUtf16Bytes: number;
  extractedFileCount: number;
  changedFileCount: number;
}): void {
  diffGauges = {
    diffThreadCount: Math.max(input.threadCount, 0),
    diffToolCallCount: Math.max(input.toolCallCount, 0),
    diffFileCount: Math.max(input.fileCount, 0),
  };
  diffCounters.diffIngestionCount += 1;
  diffCounters.diffIngestionMs += Math.max(input.durationMs, 0);
  diffCounters.diffSerializedUtf16Bytes += Math.max(input.serializedUtf16Bytes, 0);
  diffCounters.diffExtractedFileCount += Math.max(input.extractedFileCount, 0);
  diffCounters.diffChangedFileCount += Math.max(input.changedFileCount, 0);
}

export function beginRendererInteraction(kind: "tab-click" | "scroll"): void {
  armFreezeSampler?.();
  const until = now() + (kind === "scroll" ? 250 : 1200);
  if (kind === "tab-click") tabClickActiveUntil = Math.max(tabClickActiveUntil, until);
  else scrollActiveUntil = Math.max(scrollActiveUntil, until);
}

export function recordRendererEvent(input: RendererEventRecord): void {
  armFreezeSampler?.();
  const current = now();
  if (current - lastRendererEventAt <= 50) currentBurstSize += 1;
  else {
    if (currentBurstSize >= 2) {
      rendererEventStats.ipcBurstCount += 1;
      rendererEventStats.maxBurstSize = Math.max(rendererEventStats.maxBurstSize, currentBurstSize);
    }
    currentBurstSize = 1;
  }
  lastRendererEventAt = current;
  if (eventRateWindowStartedAt === 0 || current - eventRateWindowStartedAt >= 1000) {
    eventRateWindowStartedAt = current;
    eventRateWindowCount = 0;
  }
  eventRateWindowCount += 1;
  rendererEventStats.maxEventsPerSecond = Math.max(
    rendererEventStats.maxEventsPerSecond,
    eventRateWindowCount,
  );

  rendererEventStats.receivedCount += 1;
  rendererEventStats.receivedBytes += Math.max(input.bytes, 0);
  if (input.isActive) rendererEventStats.activeCount += 1;
  else rendererEventStats.backgroundCount += 1;
  rendererEventStats.applyMs += Math.max(input.applyMs, 0);
  rendererEventStats.maxApplyMs = Math.max(rendererEventStats.maxApplyMs, input.applyMs);
  if (input.ignored) rendererEventStats.ignoredCount += 1;
  if (input.buffered) rendererEventStats.bufferedCount += 1;
  if (input.coalesced) rendererEventStats.coalescedCount += 1;
  if (input.dropped) rendererEventStats.droppedCount += 1;
  if (current < tabClickActiveUntil) rendererEventStats.tabClickCount += 1;
  if (current < scrollActiveUntil) rendererEventStats.scrollCount += 1;

  if (!pendingEventPaint) {
    pendingEventPaint = { startedAt: current, count: 0 };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (!pendingEventPaint) return;
        const paintDelayMs = Math.max(0, now() - pendingEventPaint.startedAt);
        rendererEventStats.paintCount += 1;
        rendererEventStats.eventToPaintMs += paintDelayMs;
        rendererEventStats.maxEventToPaintMs = Math.max(
          rendererEventStats.maxEventToPaintMs,
          paintDelayMs,
        );
        pendingEventPaint = null;
      });
    } else {
      pendingEventPaint = null;
    }
  }
  if (pendingEventPaint) pendingEventPaint.count += 1;
}

export function recordRendererLongTask(durationMs: number): void {
  if (currentBurstSize >= 2 && now() - lastRendererEventAt <= 1000) {
    rendererEventStats.longTaskDuringBurstMs += Math.max(durationMs, 0);
  }
}

export function recordRendererFrameGap(blockedMs: number): void {
  if (currentBurstSize >= 2 && now() - lastRendererEventAt <= 1000) {
    rendererEventStats.missedFrameDuringBurstCount += 1;
  }
  if (blockedMs >= 200 && currentBurstSize >= 2) {
    rendererEventStats.maxEventToPaintMs = Math.max(
      rendererEventStats.maxEventToPaintMs,
      blockedMs,
    );
  }
}

export function startMonitorRuntimeObserver(
  context: RendererMonitorContext,
  onTelemetry: (telemetry: MonitorRendererTelemetry) => void,
): () => void {
  const startedAt = now();
  const previousDomNodeCounts = new Map<string, number>();
  const domMutations = new Map<string, DomMutationCounters>();
  const domObserver = new MutationObserver((records) => {
    for (const record of records) {
      const id = findAttributionId(record.target);
      if (!id) continue;
      const current = domMutations.get(id) ?? {
        addedNodeCount: 0,
        removedNodeCount: 0,
        mutationCount: 0,
      };
      current.addedNodeCount += [...record.addedNodes].reduce(
        (sum, node) => sum + countElementNodes(node),
        0,
      );
      current.removedNodeCount += [...record.removedNodes].reduce(
        (sum, node) => sum + countElementNodes(node),
        0,
      );
      current.mutationCount += 1;
      domMutations.set(id, current);
    }
  });
  const isDetailed = () => context.isDetailed?.() ?? true;
  let observingMutations = false;
  const syncMutationObserver = () => {
    const wanted = isDetailed();
    if (wanted === observingMutations) return;
    observingMutations = wanted;
    if (wanted) {
      domObserver.observe(document.documentElement, { childList: true, subtree: true });
    } else {
      domObserver.disconnect();
      domMutations.clear();
    }
  };
  syncMutationObserver();
  let pauseObserver: PerformanceObserver | undefined;
  try {
    pauseObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === "gc") {
          pauseCounters.gcPauseCount += 1;
          pauseCounters.gcPauseMs += entry.duration;
        } else if (entry.entryType === "longtask") {
          pauseCounters.longTaskCount += 1;
          pauseCounters.longTaskMs += entry.duration;
          recordRendererLongTask(entry.duration);
        }
      }
    });
    const supported = (
      PerformanceObserver as typeof PerformanceObserver & {
        supportedEntryTypes?: string[];
      }
    ).supportedEntryTypes;
    const entryTypes = ["longtask", "gc"].filter(
      (entryType) => !supported || supported.includes(entryType),
    );
    if (entryTypes.length > 0) pauseObserver.observe({ entryTypes });
  } catch {
    pauseObserver = undefined;
  }
  const emit = (census: boolean) => {
    const counters = diffCounters;
    diffCounters = emptyDiffCounters();
    const pauses = pauseCounters;
    pauseCounters = emptyPauseCounters();
    if (currentBurstSize >= 2) {
      rendererEventStats.ipcBurstCount += 1;
      rendererEventStats.maxBurstSize = Math.max(rendererEventStats.maxBurstSize, currentBurstSize);
    }
    currentBurstSize = 0;
    lastRendererEventAt = 0;
    const rendererEvents = rendererEventStats;
    rendererEventStats = emptyRendererEventStats();
    const contextState = rendererContext();
    const heap = heapStats();
    onTelemetry({
      timestamp: Date.now(),
      monotonicMs: now() - startedAt,
      observerId: context.observerId,
      ...contextState,
      ...heap,
      activeThreadId: context.getActiveThreadId(),
      runningThreadCount: context.getRunningThreadIds().length,
      domNodeCount: document.getElementsByTagName("*").length,
      domAttributions: census ? collectDomAttributions(previousDomNodeCounts, domMutations) : [],
      ...diffGauges,
      ...counters,
      ...pauses,
      rendererEvents,
    });
  };

  let stopped = false;
  let samples = 0;
  let censusPending = false;
  const sample = () => {
    samples += 1;
    syncMutationObserver();
    const census = isDetailed() || samples % BACKGROUND_CENSUS_EVERY_SAMPLES === 1;
    if (!census) {
      emit(false);
      return;
    }
    if (censusPending) return;
    censusPending = true;
    // The census walks the document; run it when the renderer is idle.
    runWhenIdle(() => {
      censusPending = false;
      if (!stopped) emit(true);
    });
  };

  sample();
  const interval = window.setInterval(sample, RUNTIME_SAMPLE_INTERVAL_MS);
  return () => {
    stopped = true;
    window.clearInterval(interval);
    pauseObserver?.disconnect();
    domObserver.disconnect();
  };
}

function runWhenIdle(callback: () => void): void {
  const idle = (
    globalThis as typeof globalThis & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof idle === "function") idle(callback, { timeout: 2000 });
  else window.setTimeout(callback, 0);
}

function longTasksSupported(): boolean {
  if (typeof PerformanceObserver === "undefined") return false;
  const supported = (
    PerformanceObserver as typeof PerformanceObserver & { supportedEntryTypes?: string[] }
  ).supportedEntryTypes;
  return Array.isArray(supported) && supported.includes("longtask");
}

export function startMonitorFreezeObserver(
  context: RendererMonitorContext,
  onReport: (report: MonitorRendererFreezeReport) => void,
): () => void {
  const cleanups: Array<() => void> = [];
  const observerId = context.observerId;
  let lastFrame = now();
  let visibilityEpoch = 0;
  let stopped = false;
  let episode:
    | {
        id: string;
        startedAt: number;
        lastSignalAt: number;
        maxBlockedMs: number;
        signalCount: number;
        sequence: number;
        sources: Set<MonitorFreezeSource>;
      }
    | undefined;
  let finishTimer: number | undefined;

  const emit = (
    phase: "start" | "end",
    source: MonitorFreezeSource,
    blockedMs: number,
    longTaskMs?: number,
  ) => {
    if (!episode) return;
    episode.sequence += 1;
    const contextState = rendererContext();
    onReport({
      phase,
      episodeId: episode.id,
      observerId,
      sequence: episode.sequence,
      source,
      sources: [...episode.sources],
      blockedMs,
      longTaskMs,
      maxBlockedMs: episode.maxBlockedMs,
      episodeDurationMs: Math.max(0, now() - episode.startedAt),
      signalCount: episode.signalCount,
      observedAt: performance.timeOrigin + now(),
      monotonicMs: now(),
      ...contextState,
    });
  };

  const finish = () => {
    if (!episode) return;
    emit("end", [...episode.sources][0] ?? "raf_gap", episode.maxBlockedMs);
    episode = undefined;
    finishTimer = undefined;
  };

  const signal = (source: MonitorFreezeSource, blockedMs: number, longTaskMs?: number) => {
    // Background timers and RAF are intentionally throttled by Chromium.
    // Their gaps are not evidence of a blocked renderer. Long Task entries
    // remain useful even in a background window because they measure work.
    if (stopped || (document.hidden && source !== "longtask")) return;
    if (blockedMs < 200) return;
    recordRendererFrameGap(blockedMs);
    const current = now();
    if (!episode || current - episode.lastSignalAt > FREEZE_EPISODE_QUIET_MS) {
      if (episode) finish();
      episode = {
        id: createId("freeze"),
        startedAt: current,
        lastSignalAt: current,
        maxBlockedMs: blockedMs,
        signalCount: 1,
        sequence: 0,
        sources: new Set([source]),
      };
      emit("start", source, blockedMs, longTaskMs);
    } else {
      episode.lastSignalAt = current;
      episode.maxBlockedMs = Math.max(episode.maxBlockedMs, blockedMs);
      episode.signalCount += 1;
      episode.sources.add(source);
    }
    if (finishTimer !== undefined) window.clearTimeout(finishTimer);
    finishTimer = window.setTimeout(finish, FREEZE_EPISODE_QUIET_MS);
  };

  // The RAF gap sampler keeps the compositor producing frames, so it only
  // runs while something is happening (input, renderer events, becoming
  // visible) and stops FREEZE_RAF_ARM_MS after the last activity. Long Task
  // entries cover blocking work at any other time.
  let rafId = 0;
  let rafRunning = false;
  let armedUntil = 0;
  const onFrame = (frameNow: number) => {
    const delta = frameNow - lastFrame;
    if (delta > 200) signal("raf_gap", delta);
    lastFrame = frameNow;
    if (!stopped && !document.hidden && now() < armedUntil) {
      rafId = requestAnimationFrame(onFrame);
    } else {
      rafRunning = false;
    }
  };
  const arm = () => {
    armedUntil = now() + FREEZE_RAF_ARM_MS;
    if (rafRunning || stopped || document.hidden) return;
    rafRunning = true;
    lastFrame = now();
    rafId = requestAnimationFrame(onFrame);
  };
  armFreezeSampler = arm;
  cleanups.push(() => {
    cancelAnimationFrame(rafId);
    rafRunning = false;
    if (armFreezeSampler === arm) armFreezeSampler = null;
  });
  for (const type of ["pointerdown", "keydown", "wheel"] as const) {
    window.addEventListener(type, arm, { capture: true, passive: true });
    cleanups.push(() => window.removeEventListener(type, arm, { capture: true }));
  }

  const resetVisibility = () => {
    visibilityEpoch++;
    lastFrame = now();
    if (finishTimer !== undefined) window.clearTimeout(finishTimer);
    if (episode) finish();
    finishTimer = undefined;
    if (!document.hidden) arm();
  };
  document.addEventListener("visibilitychange", resetVisibility);
  cleanups.push(() => document.removeEventListener("visibilitychange", resetVisibility));

  if ("PerformanceObserver" in window) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 50) signal("longtask", entry.duration, entry.duration);
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
      cleanups.push(() => observer.disconnect());
    } catch {
      // Long Task is not available in every Electron runtime.
    }
  }

  arm();

  // Timer drift duplicates Long Task coverage; keep it only as a fallback.
  if (longTasksSupported()) {
    return () => {
      stopped = true;
      for (const cleanup of cleanups) cleanup();
      if (finishTimer !== undefined) window.clearTimeout(finishTimer);
    };
  }
  const interval = window.setInterval(() => {
    if (document.hidden) return;
    const started = now();
    const startedEpoch = visibilityEpoch;
    window.setTimeout(() => {
      if (stopped || startedEpoch !== visibilityEpoch || document.hidden) return;
      const drift = now() - started - 100;
      if (drift > 200) signal("timer_drift", drift);
    }, 100);
  }, 250);
  cleanups.push(() => window.clearInterval(interval));

  return () => {
    stopped = true;
    for (const cleanup of cleanups) cleanup();
    if (finishTimer !== undefined) window.clearTimeout(finishTimer);
  };
}

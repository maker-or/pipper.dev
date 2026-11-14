import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { PostHog } from "posthog-node";
import type {
  AnalyticsEvent,
  AnalyticsEventName,
  AnalyticsProperties,
  AnalyticsWindowType,
} from "./analytics-schema.ts";
import {
  sanitizeAgentId,
  sanitizeAnalyticsProperties,
  sanitizeIdentifier,
} from "./analytics-sanitize.ts";
import { buildPersonProperties, type AnalyticsUserIdentity } from "./analytics-person.ts";

export type { AnalyticsUserIdentity } from "./analytics-person.ts";
export { buildPersonProperties } from "./analytics-person.ts";

const sessionId = randomUUID();

let client: PostHog | null = null;
/** Clerk provider user id once authenticated; null before sign-in. */
let identifiedUserId: string | null = null;
/** Last identity used for person-profile `$set` (re-stamped on later identifies). */
let lastIdentity: AnalyticsUserIdentity | null = null;
/** Stable per-install id used as distinctId before sign-in (pre-auth funnel). */
let deviceId: string | null = null;
let appOpenedSent = false;

/**
 * Active agent context promoted onto the base properties of every ACP-scoped
 * event, so any event is sliceable by agent in PostHog without extra plumbing.
 */
let activeAgent: { agent_id?: string; agent_name?: string; model_id?: string } = {};

function resolvePostHogKey(): string | null {
  if (process.env["ANALYTICS_ENABLED"] === "false") return null;
  return (
    process.env["PIPPER_POSTHOG_KEY"] ??
    process.env["POSTHOG_KEY"] ??
    import.meta.env.VITE_POSTHOG_KEY ??
    null
  );
}

function resolvePostHogHost(): string {
  return (
    process.env["PIPPER_POSTHOG_HOST"] ??
    process.env["POSTHOG_HOST"] ??
    import.meta.env.VITE_POSTHOG_HOST ??
    "https://us.i.posthog.com"
  );
}

let warnedMissingKey = false;

function getClient(): PostHog | null {
  if (client) return client;
  const apiKey = resolvePostHogKey();
  if (!apiKey) {
    // Fail loud: a missing key means every capture/identify is a silent no-op.
    // In release builds this happens when VITE_POSTHOG_KEY wasn't set at build time.
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.error(
        "[Analytics] No PostHog key (PIPPER_POSTHOG_KEY/POSTHOG_KEY/VITE_POSTHOG_KEY). " +
          "Analytics events will be dropped.",
      );
    }
    return null;
  }
  client = new PostHog(apiKey, {
    host: resolvePostHogHost(),
    flushAt: 10,
    flushInterval: 5000,
    enableExceptionAutocapture: true,
  });
  return client;
}

function buildBaseProperties(windowType: AnalyticsWindowType) {
  return {
    app_version: app.getVersion(),
    session_id: sessionId,
    window_type: windowType,
    platform: process.platform,
    ...activeAgent,
  };
}

/**
 * Set (or clear) the active agent promoted onto every subsequent event's base
 * properties. Pass `null` to clear. The connection manager calls this whenever
 * the active thread / agent changes.
 */
export function setActiveAgentContext(
  ctx: { agentId?: string | null; agentName?: string | null; modelId?: string | null } | null,
): void {
  if (!ctx) {
    activeAgent = {};
    return;
  }
  const next: { agent_id?: string; agent_name?: string; model_id?: string } = {};
  // Driver id only: account ids carry a label the user typed.
  const agentId = sanitizeAgentId(ctx.agentId);
  const agentName = sanitizeIdentifier(ctx.agentName);
  const modelId = sanitizeIdentifier(ctx.modelId);
  if (agentId) next.agent_id = agentId;
  if (agentName) next.agent_name = agentName;
  if (modelId) next.model_id = modelId;
  activeAgent = next;
}

/** The id events are attributed to: the signed-in user, else the device id. */
export function getAnalyticsDistinctId(): string | null {
  return currentDistinctId();
}

/** Renderer-safe config: null when disabled/keyless so renderer stays off. */
export function getAnalyticsConfig(): {
  key: string;
  host: string;
  distinctId: string | null;
} | null {
  const apiKey = resolvePostHogKey();
  if (!apiKey) return null;
  return { key: apiKey, host: resolvePostHogHost(), distinctId: currentDistinctId() };
}

function currentDistinctId(): string | null {
  return identifiedUserId ?? deviceId ?? ensureDeviceId();
}

/**
 * Load-or-create a stable device id persisted under userData. Lets us attribute
 * pre-auth events; on identify we alias the device id to the user id so the
 * open → sign-in funnel stitches together.
 */
function ensureDeviceId(): string | null {
  if (deviceId) return deviceId;
  try {
    const path = join(app.getPath("userData"), "analytics-device.json");
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { deviceId?: string };
      if (parsed.deviceId) {
        deviceId = parsed.deviceId;
        return deviceId;
      }
    }
    deviceId = randomUUID();
    writeFileSync(path, `${JSON.stringify({ deviceId }, null, 2)}\n`);
    return deviceId;
  } catch {
    // If persistence fails, fall back to an in-memory id for this run.
    deviceId ??= randomUUID();
    return deviceId;
  }
}

export function identifyAnalyticsUser(identity: AnalyticsUserIdentity): void {
  const trimmed = identity.providerUserId.trim();
  if (!trimmed) return;
  const previousId = deviceId ?? ensureDeviceId();
  identifiedUserId = trimmed;
  lastIdentity = {
    providerUserId: trimmed,
    email: identity.email ?? null,
    name: identity.name ?? null,
    avatarUrl: identity.avatarUrl ?? null,
  };
  const posthog = getClient();
  if (!posthog) return;

  const personProperties = buildPersonProperties(lastIdentity);

  // Stitch pre-auth device activity onto the now-known user.
  if (previousId && previousId !== trimmed) {
    posthog.alias({ distinctId: trimmed, alias: previousId });
  }

  // Person-profile fields ($email / $name / $avatar + bare aliases). posthog-node
  // wraps plain keys in $set automatically.
  posthog.identify({
    distinctId: trimmed,
    properties: personProperties,
  });

  // Belt-and-suspenders: also emit an explicit $set capture so profile fields
  // still land if a consumer only inspects $set events, and so later health
  // stamps cannot be the sole person write for this distinct id.
  if (Object.keys(personProperties).length > 0) {
    posthog.capture({
      distinctId: trimmed,
      event: "$set",
      properties: { $set: personProperties },
    });
  }

  // Don't wait for flushAt/flushInterval — profile props should hit PostHog as
  // soon as the user is known (short sessions used to drop them on quit).
  void posthog.flush().catch((err) => {
    console.error("[Analytics] Failed to flush person profile identify:", err);
  });

  if (!appOpenedSent) {
    appOpenedSent = true;
    captureAnalytics("app_opened", { windowType: "launch" });
  }
}

/**
 * Set person-level properties on the current distinct id (e.g. installed_version,
 * has_customizations). No-op before a distinct id is available.
 *
 * When an authenticated identity is known, identity profile fields are merged
 * into the same $set so a later stamp cannot leave a person with only health
 * metadata and no email/avatar.
 */
export function setAnalyticsPersonProperties(properties: Record<string, unknown>): void {
  const id = currentDistinctId();
  if (!id) return;
  const posthog = getClient();
  if (!posthog) return;
  const identityProps = lastIdentity ? buildPersonProperties(lastIdentity) : {};
  posthog.capture({
    distinctId: id,
    event: "$set",
    properties: {
      $set: {
        ...identityProps,
        ...properties,
      },
    },
  });
}

export function captureAnalytics(
  name: AnalyticsEventName,
  event: Omit<AnalyticsEvent, "name"> = {},
): void {
  const id = currentDistinctId();
  if (!id) return;
  const posthog = getClient();
  if (!posthog) return;
  const properties: AnalyticsProperties = event.properties ?? {};
  posthog.capture({
    distinctId: id,
    event: name,
    properties: {
      ...buildBaseProperties(event.windowType ?? "background"),
      ...sanitizeAnalyticsProperties(properties),
    },
  });
}

/** Capture handled failures that would not reach Node's global error hooks. */
export function captureAnalyticsException(
  error: unknown,
  properties: AnalyticsProperties = {},
): void {
  const id = currentDistinctId();
  const posthog = getClient();
  if (!id || !posthog) return;
  const exception = error instanceof Error ? error : new Error(String(error));
  posthog.captureException(exception, id, {
    ...buildBaseProperties("background"),
    ...sanitizeAnalyticsProperties(properties),
  });
}

/** Flush queued events while the app remains open (the normal macOS lifecycle). */
export async function flushAnalytics(): Promise<void> {
  await client?.flush();
}

export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  await client.shutdown();
  client = null;
}

import { app } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserConfig } from "../../contracts/acp.ts";

const FILE_NAME = "browser.json";

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  enabled: true,
  pagesPerSession: 4,
  idleMinutes: 5,
  downloads: "ask",
};

export function browserConfigPath(baseDir?: string): string {
  return join(baseDir ?? app.getPath("userData"), FILE_NAME);
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Coerce arbitrary JSON into a valid config; unknown fields are dropped. */
export function sanitizeBrowserConfig(raw: unknown): BrowserConfig {
  const parsed = (raw ?? {}) as Partial<Record<keyof BrowserConfig, unknown>>;
  const defaults = DEFAULT_BROWSER_CONFIG;
  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
    pagesPerSession: clamp(parsed.pagesPerSession, 1, 8, defaults.pagesPerSession),
    idleMinutes: clamp(parsed.idleMinutes, 1, 60, defaults.idleMinutes),
    downloads:
      parsed.downloads === "ask" || parsed.downloads === "block"
        ? parsed.downloads
        : defaults.downloads,
  };
}

export async function readBrowserConfig(baseDir?: string): Promise<BrowserConfig> {
  try {
    const raw = await readFile(browserConfigPath(baseDir), "utf-8");
    return sanitizeBrowserConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_BROWSER_CONFIG };
  }
}

export async function writeBrowserConfig(
  config: Partial<BrowserConfig>,
  baseDir?: string,
): Promise<BrowserConfig> {
  const current = await readBrowserConfig(baseDir);
  const next = sanitizeBrowserConfig({ ...current, ...config });
  const path = browserConfigPath(baseDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

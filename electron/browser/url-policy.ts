/**
 * Which URLs an agent's browser page may load. Applied to top-level
 * navigations, redirects, popups and every subresource request, so a page
 * can't reach a blocked scheme indirectly.
 */

export type UrlDecision = { allowed: true } | { allowed: false; reason: string };

const ALLOWED_SCHEMES = new Set(["http:", "https:", "data:", "blob:"]);

export interface UrlPolicyOptions {
  /** Origins that serve Pipper's own UI (the dev renderer URL in development). */
  appOrigins: readonly string[];
}

export function checkUrl(raw: string, options: UrlPolicyOptions): UrlDecision {
  if (raw === "about:blank") return { allowed: true };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: `not a valid URL: ${raw}` };
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { allowed: false, reason: `${url.protocol} URLs are blocked` };
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && isAppOrigin(url, options)) {
    return { allowed: false, reason: "Pipper's own pages can't be opened" };
  }
  return { allowed: true };
}

function isAppOrigin(url: URL, options: UrlPolicyOptions): boolean {
  return options.appOrigins.some((origin) => {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  });
}

/**
 * Agents often pass bare hosts ("example.com", "localhost:3000"). Add a
 * scheme so they resolve as web URLs instead of failing as relative paths.
 */
export function normalizeUserUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^localhost:\d/i.test(trimmed)) return trimmed;
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(trimmed);
  return `${isLocal ? "http" : "https"}://${trimmed}`;
}

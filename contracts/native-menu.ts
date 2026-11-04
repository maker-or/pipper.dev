/** One row of a native popup menu. */
export type NativeMenuItem =
  | {
      type: "item";
      /** Returned to the renderer when the user picks this row. */
      id: string;
      label: string;
      /** A second, dimmer line under the label. */
      sublabel?: string;
      checked?: boolean;
      enabled?: boolean;
    }
  | { type: "separator" };

/** The element the menu opens from, in the window's CSS pixels. */
export interface NativeMenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeMenuRequest {
  items: NativeMenuItem[];
  anchor: NativeMenuAnchor;
}

/** Longest a label may be before it is cut, so a stray value can't build a huge menu. */
const MAX_LABEL_LENGTH = 200;
/** Most rows a menu may hold. */
const MAX_ITEMS = 500;

function text(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, MAX_LABEL_LENGTH) : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Checks a request that crossed IPC. Rows that aren't well formed are dropped;
 * a request without a usable anchor or any rows is refused.
 */
export function parseNativeMenuRequest(value: unknown): NativeMenuRequest | null {
  if (!value || typeof value !== "object") return null;
  const { items, anchor } = value as { items?: unknown; anchor?: unknown };
  if (!Array.isArray(items) || !anchor || typeof anchor !== "object") return null;
  const box = anchor as Record<string, unknown>;
  const x = finite(box.x);
  const y = finite(box.y);
  const width = finite(box.width);
  const height = finite(box.height);
  if (x === null || y === null || width === null || height === null) return null;

  const parsed: NativeMenuItem[] = [];
  for (const raw of items.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type === "separator") {
      parsed.push({ type: "separator" });
      continue;
    }
    const id = text(item.id);
    const label = text(item.label);
    if (item.type !== "item" || id === null || label === null) continue;
    const sublabel = text(item.sublabel);
    parsed.push({
      type: "item",
      id,
      label,
      ...(sublabel ? { sublabel } : {}),
      checked: item.checked === true,
      enabled: item.enabled !== false,
    });
  }
  if (!parsed.some((item) => item.type === "item")) return null;
  return { items: parsed, anchor: { x, y, width, height } };
}

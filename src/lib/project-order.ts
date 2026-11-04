import type { Project } from "../../contracts/projects.ts";

/** The list with the item at `from` moved to `to`, clamped to the list. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item!);
  return next;
}

/** A changed project replaces its entry where it is; a new one joins the end,
 *  where the main process put it in the saved order. */
export function upsertProject(projects: readonly Project[], project: Project): Project[] {
  const index = projects.findIndex((item) => item.id === project.id);
  if (index === -1) return [...projects, project];
  const next = [...projects];
  next[index] = project;
  return next;
}

/** A rail tile's natural height in px (see ProjectTile). */
export const RAIL_TILE_HEIGHT = 82;
/** The rail fits 5 or 6 tiles into its height, spreading them to fill it;
 *  the rest scroll. */
const MIN_VISIBLE_TILES = 5;
const MAX_VISIBLE_TILES = 6;

/** Height of one tile's slot so 5–6 tiles fill `height`, never below a tile. */
export function railSlotHeight(height: number): number {
  const fits = Math.floor(height / RAIL_TILE_HEIGHT);
  const count = Math.max(MIN_VISIBLE_TILES, Math.min(MAX_VISIBLE_TILES, fits));
  return Math.max(RAIL_TILE_HEIGHT, height / count);
}

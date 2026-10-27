/**
 * Pulls the light and dark token blocks out of the app stylesheet, so widgets
 * use exactly the same variables as Pipper's UI. A token change in
 * `src/index.css` reaches widgets with no second copy to update.
 */

const LIGHT_SELECTOR = ':root,\n[data-workspace-theme="light"] {';
const DARK_SELECTOR = '.dark,\n[data-workspace-theme="dark"] {';

export function extractThemeTokens(css: string): string {
  const light = extractBlock(css, LIGHT_SELECTOR);
  const dark = extractBlock(css, DARK_SELECTOR);
  if (!light || !dark) {
    throw new Error("Couldn't find the light and dark token blocks in index.css");
  }
  return `${light}\n${dark}`;
}

/** The rule starting at `selector`, through its matching closing brace. */
function extractBlock(css: string, selector: string): string | null {
  const start = css.indexOf(selector);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + selector.length - 1; i < css.length; i++) {
    const char = css[i];
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  return null;
}

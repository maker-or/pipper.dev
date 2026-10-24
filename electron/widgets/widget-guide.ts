import guideMarkdown from "../../docs/inline-widgets/design-guide.md?raw";

/**
 * Serves the agent-facing part of `docs/inline-widgets/design-guide.md`
 * module by module, so the doc stays the single source for widget rules.
 */

export const WIDGET_GUIDE_MODULES = ["core", "chart", "diagram", "table", "interactive"] as const;
export type WidgetGuideModule = (typeof WIDGET_GUIDE_MODULES)[number];

export function parseGuideModules(markdown: string): Map<string, string> {
  const start = markdown.indexOf("## Agent-facing text");
  const body = start >= 0 ? markdown.slice(start) : markdown;
  const modules = new Map<string, string>();
  const parts = body.split(/^### /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const name = part.slice(0, newline).trim();
    modules.set(name, part.slice(newline + 1).trim());
  }
  return modules;
}

let cached: Map<string, string> | null = null;

export function widgetGuide(requested: readonly string[]): string {
  cached ??= parseGuideModules(guideMarkdown);
  const names = ["core", ...requested.filter((name) => name !== "core")];
  const sections: string[] = [];
  for (const name of names) {
    const text = cached.get(name);
    if (!text)
      throw new Error(`Unknown guide module "${name}"; use ${WIDGET_GUIDE_MODULES.join(", ")}`);
    sections.push(`# ${name}\n\n${text}`);
  }
  return sections.join("\n\n");
}

import type { AxNode } from "./browser-page.ts";

/**
 * Turns a CDP accessibility tree into the compact text an agent reads:
 *
 *   - heading "Sign in" [level=1] [ref=e1]
 *   - textbox "Email" [ref=e2]
 *   - button "Continue" [ref=e3]
 *
 * Wrapper nodes with no meaning of their own are dropped and their children
 * lifted, so a typical page lands in a few hundred tokens instead of a DOM
 * dump. Each ref maps to a backend DOM node id for click/type/screenshot.
 */

export interface SnapshotResult {
  text: string;
  refs: Map<string, number>;
  lineCount: number;
  truncated: boolean;
}

export interface SnapshotOptions {
  interactiveOnly?: boolean;
  maxLines?: number;
  maxNameLength?: number;
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "textField",
  "PopUpButton",
  "ToggleButton",
]);

/** Pure layout wrappers: never shown, children lifted. */
const ALWAYS_COLLAPSE = new Set([
  "generic",
  "none",
  "presentation",
  "GenericContainer",
  "LineBreak",
  "RootWebArea",
  "WebArea",
  "Iframe",
  "IframePresentational",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
]);

/** Structural roles that only carry meaning when they have a name. */
const COLLAPSE_WHEN_UNNAMED = new Set([
  "paragraph",
  "group",
  "section",
  "Section",
  "region",
  "Div",
  "Pre",
  "Mark",
  "Abbr",
  "time",
  "LabelText",
]);

const TEXT_ROLES = new Set(["StaticText", "text"]);
const SKIPPED_ROLES = new Set(["InlineTextBox", "ListMarker"]);

const BOOLEAN_PROPERTIES = [
  "checked",
  "disabled",
  "expanded",
  "selected",
  "pressed",
  "required",
] as const;
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "slider", "spinbutton"]);

export function buildSnapshot(nodes: AxNode[], options: SnapshotOptions = {}): SnapshotResult {
  const maxLines = options.maxLines ?? 500;
  const maxNameLength = options.maxNameLength ?? 80;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find((node) => !node.parentId || !byId.has(node.parentId)) ?? nodes[0];

  const lines: string[] = [];
  const refs = new Map<string, number>();
  let truncated = false;
  let nextRef = 1;

  const visit = (node: AxNode, depth: number, ancestorName: string) => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    const role = stringValue(node.role);
    const name = clean(stringValue(node.name));

    if (SKIPPED_ROLES.has(role)) return;

    if (TEXT_ROLES.has(role)) {
      if (options.interactiveOnly) return;
      if (!name || ancestorName.includes(name)) return;
      lines.push(`${indent(depth)}- text ${quote(name, maxNameLength)}`);
      return;
    }

    const interactive = INTERACTIVE_ROLES.has(role);
    const collapse =
      node.ignored ||
      !role ||
      ALWAYS_COLLAPSE.has(role) ||
      (!name && COLLAPSE_WHEN_UNNAMED.has(role)) ||
      (options.interactiveOnly && !interactive);

    let childDepth = depth;
    let childAncestorName = ancestorName;
    if (!collapse) {
      let line = `${indent(depth)}- ${role}`;
      if (name) line += ` ${quote(name, maxNameLength)}`;
      line += attributes(node, role);
      if (node.backendDOMNodeId != null) {
        const ref = `e${nextRef++}`;
        refs.set(ref, node.backendDOMNodeId);
        line += ` [ref=${ref}]`;
      }
      lines.push(line);
      // Interactive-only output is a flat list; nesting buttons under
      // collapsed containers would only add indentation noise.
      childDepth = options.interactiveOnly ? depth : depth + 1;
      childAncestorName = name;
    }

    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, childDepth, childAncestorName);
    }
  };

  if (root) visit(root, 0, "");
  if (truncated) lines.push(`… snapshot truncated at ${maxLines} lines`);

  return {
    text: lines.length > 0 ? lines.join("\n") : "(page has no accessible content)",
    refs,
    lineCount: lines.length,
    truncated,
  };
}

function attributes(node: AxNode, role: string): string {
  let out = "";
  const properties = new Map(
    (node.properties ?? []).map((property) => [property.name, property.value?.value]),
  );
  if (role === "heading") {
    const level = properties.get("level");
    if (typeof level === "number") out += ` [level=${level}]`;
  }
  for (const key of BOOLEAN_PROPERTIES) {
    const value = properties.get(key);
    if (value === true || value === "true") out += ` [${key}]`;
    else if (key === "checked" && value === "mixed") out += " [checked=mixed]";
  }
  if (VALUE_ROLES.has(role)) {
    const value = clean(stringValue(node.value));
    if (value) out += ` [value=${quote(value, 40)}]`;
  }
  return out;
}

function stringValue(field: { value?: unknown } | undefined): string {
  const value = field?.value;
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function quote(text: string, max: number): string {
  const short = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return JSON.stringify(short);
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

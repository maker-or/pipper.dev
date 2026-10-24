import { describe, expect, test } from "vitest";
import type { AxNode } from "./browser-page.ts";
import { buildSnapshot } from "./snapshot.ts";

function node(
  nodeId: string,
  role: string,
  options: Partial<AxNode> & { name?: string; children?: string[] } = {},
): AxNode {
  const { name, children, ...rest } = options;
  return {
    nodeId,
    role: { value: role },
    ...(name !== undefined ? { name: { value: name } } : {}),
    childIds: children ?? [],
    ...rest,
  };
}

const page: AxNode[] = [
  node("1", "RootWebArea", { name: "Shop", children: ["2", "6"] }),
  node("2", "generic", { parentId: "1", children: ["3", "4", "5"] }),
  node("3", "heading", {
    parentId: "2",
    name: "Your cart",
    backendDOMNodeId: 11,
    properties: [{ name: "level", value: { value: 1 } }],
    children: ["3a"],
  }),
  node("3a", "StaticText", { parentId: "3", name: "Your cart" }),
  node("4", "textbox", {
    parentId: "2",
    name: "Coupon",
    backendDOMNodeId: 12,
    value: { value: "SAVE10" },
    properties: [{ name: "required", value: { value: true } }],
  }),
  node("5", "paragraph", { parentId: "2", children: ["5a"] }),
  node("5a", "StaticText", { parentId: "5", name: "Free   shipping over $50" }),
  node("6", "button", {
    parentId: "1",
    name: "Checkout",
    backendDOMNodeId: 13,
    properties: [{ name: "disabled", value: { value: true } }],
  }),
];

describe("accessibility snapshot", () => {
  test("drops wrappers, keeps meaning and gives every element a ref", () => {
    const snapshot = buildSnapshot(page);
    expect(snapshot.text).toBe(
      [
        '- heading "Your cart" [level=1] [ref=e1]',
        '- textbox "Coupon" [required] [value="SAVE10"] [ref=e2]',
        '- text "Free shipping over $50"',
        '- button "Checkout" [disabled] [ref=e3]',
      ].join("\n"),
    );
    expect([...snapshot.refs]).toEqual([
      ["e1", 11],
      ["e2", 12],
      ["e3", 13],
    ]);
  });

  test("interactive-only lists just the controls", () => {
    const snapshot = buildSnapshot(page, { interactiveOnly: true });
    expect(snapshot.text).toBe(
      [
        '- textbox "Coupon" [required] [value="SAVE10"] [ref=e1]',
        '- button "Checkout" [disabled] [ref=e2]',
      ].join("\n"),
    );
  });

  test("long pages are cut off with a marker and long names are shortened", () => {
    const items: AxNode[] = [
      node("root", "RootWebArea", { children: Array.from({ length: 30 }, (_, i) => `l${i}`) }),
      ...Array.from({ length: 30 }, (_, i) =>
        node(`l${i}`, "link", { parentId: "root", name: "x".repeat(200), backendDOMNodeId: i }),
      ),
    ];
    const snapshot = buildSnapshot(items, { maxLines: 10 });
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text.split("\n").at(-1)).toContain("truncated");
    expect(snapshot.text.split("\n")[0].length).toBeLessThan(120);
  });

  test("an empty tree says so", () => {
    expect(buildSnapshot([]).text).toBe("(page has no accessible content)");
  });
});

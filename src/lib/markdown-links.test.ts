import { describe, expect, test } from "vitest";
import { classifyMarkdownHref, workspaceRelativePath } from "./markdown-links";

describe("classifyMarkdownHref", () => {
  test("web pages, including a local dev server", () => {
    expect(classifyMarkdownHref("https://github.com/a/b")).toEqual({
      kind: "web",
      url: "https://github.com/a/b",
    });
    expect(classifyMarkdownHref("http://localhost:5173/")).toEqual({
      kind: "web",
      url: "http://localhost:5173/",
    });
  });

  test("workspace files, with the line forms agents write", () => {
    expect(classifyMarkdownHref("src/app.ts")).toEqual({
      kind: "file",
      path: "src/app.ts",
      absolute: false,
      line: null,
    });
    expect(classifyMarkdownHref("./src/app.ts:42")).toMatchObject({ path: "src/app.ts", line: 42 });
    expect(classifyMarkdownHref("src/app.ts#L7-L9")).toMatchObject({ path: "src/app.ts", line: 7 });
    expect(classifyMarkdownHref("/Users/me/repo/a%20b.ts:3:1")).toMatchObject({
      path: "/Users/me/repo/a b.ts",
      absolute: true,
      line: 3,
    });
    expect(classifyMarkdownHref("file:///Users/me/repo/a.ts")).toMatchObject({
      path: "/Users/me/repo/a.ts",
      absolute: true,
    });
  });

  test("never follows other schemes, anchors or paths that climb out", () => {
    for (const href of [
      "javascript:alert(1)",
      "pipper://x",
      "mailto:a@b.c",
      "#top",
      "",
      "../etc/passwd",
    ]) {
      expect(classifyMarkdownHref(href)).toEqual({ kind: "none" });
    }
  });
});

describe("workspaceRelativePath", () => {
  const file = (path: string) =>
    classifyMarkdownHref(path) as Extract<
      ReturnType<typeof classifyMarkdownHref>,
      { kind: "file" }
    >;
  test("keeps relative paths and relativizes absolute ones inside the root", () => {
    expect(workspaceRelativePath(file("src/a.ts"), "/repo")).toBe("src/a.ts");
    expect(workspaceRelativePath(file("/repo/src/a.ts"), "/repo/")).toBe("src/a.ts");
  });
  test("rejects absolute paths outside the root, including look-alike prefixes", () => {
    expect(workspaceRelativePath(file("/other/a.ts"), "/repo")).toBeNull();
    expect(workspaceRelativePath(file("/repo-2/a.ts"), "/repo")).toBeNull();
  });
});

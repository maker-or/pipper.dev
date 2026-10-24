import { describe, expect, test } from "vitest";
import { parseKey } from "./keys.ts";
import { checkUrl, normalizeUserUrl } from "./url-policy.ts";

const policy = { appOrigins: ["http://localhost:5173"] };

describe("agent browser URL policy", () => {
  test("web pages, local dev servers and inline documents are allowed", () => {
    for (const url of [
      "https://example.com/docs",
      "http://localhost:3000",
      "http://127.0.0.1:8080/api",
      "data:text/html,<h1>hi</h1>",
      "about:blank",
    ]) {
      expect(checkUrl(url, policy)).toEqual({ allowed: true });
    }
  });

  test("local files, browser internals and Pipper's own UI are blocked", () => {
    for (const url of [
      "file:///Users/me/.ssh/id_ed25519",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "about:config",
      "javascript:alert(1)",
      "http://localhost:5173/settings.html",
      "not a url",
    ]) {
      expect(checkUrl(url, policy).allowed).toBe(false);
    }
  });

  test("bare hosts get a sensible scheme", () => {
    expect(normalizeUserUrl("example.com")).toBe("https://example.com");
    expect(normalizeUserUrl("localhost:3000/app")).toBe("http://localhost:3000/app");
    expect(normalizeUserUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeUserUrl("https://a.test")).toBe("https://a.test");
    expect(normalizeUserUrl("file:///etc/hosts")).toBe("file:///etc/hosts");
  });
});

describe("key chords", () => {
  test("named keys, characters and modifiers map to key events", () => {
    expect(parseKey("Enter")).toMatchObject({
      key: "Enter",
      keyCode: 13,
      text: "\r",
      modifiers: 0,
    });
    expect(parseKey("a")).toMatchObject({ key: "a", code: "KeyA", keyCode: 65, text: "a" });
    expect(parseKey("Shift+a")).toMatchObject({ key: "A", text: "A", modifiers: 8 });
    // Command chords don't insert text.
    expect(parseKey("Control+A")).toMatchObject({ code: "KeyA", modifiers: 2, text: undefined });
    expect(parseKey("Meta+Shift+K").modifiers).toBe(12);
  });

  test("unknown keys and modifiers are rejected", () => {
    expect(() => parseKey("Hyper+A")).toThrow(/modifier/);
    expect(() => parseKey("NotAKey")).toThrow(/key/);
  });
});

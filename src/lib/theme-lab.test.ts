import { describe, expect, it } from "vitest";
import { adjustHex, NO_ADJUST, parseHex, rgbToOklch } from "@/lib/oklch";
import {
  changedTokens,
  emptyDraft,
  exportCss,
  parseDraft,
  type ThemeOriginals,
} from "@/lib/theme-lab";

const originals: ThemeOriginals = {
  light: {
    "--workspace-tone-merged": "#6b3cba",
    "--workspace-tone-ready": "#147858",
    "--workspace-fill-ready": "#12664e",
    "--workspace-header-fade-strength": "42%",
  },
  dark: {
    "--workspace-fill-ready": "#6ee7b7",
    "--workspace-color-ready": "#088139",
    "--workspace-glow-ready": null,
  },
};

describe("oklch adjustments", () => {
  it("leaves a colour alone when the knobs are at rest", () => {
    expect(adjustHex("#147858", NO_ADJUST)).toBe("#147858");
  });

  it("makes a colour lighter, more intense, or another hue as asked", () => {
    const base = rgbToOklch(parseHex("#147858")!);
    const lighter = rgbToOklch(parseHex(adjustHex("#147858", { ...NO_ADJUST, lightness: 0.1 }))!);
    const muted = rgbToOklch(parseHex(adjustHex("#147858", { ...NO_ADJUST, chroma: 0.5 }))!);
    const grey = adjustHex("#147858", { ...NO_ADJUST, chroma: 0 });
    expect(lighter.l).toBeGreaterThan(base.l + 0.08);
    expect(muted.c).toBeCloseTo(base.c / 2, 2);
    const { r, g, b } = parseHex(grey)!;
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0.01);
  });

  it("keeps translucency and stays a valid colour when pushed out of gamut", () => {
    const result = adjustHex("#ffaa4f80", { lightness: 0.3, chroma: 2, hue: 40 });
    expect(result).toMatch(/^#[0-9a-f]{8}$/);
    expect(result.slice(7)).toBe("80");
  });
});

describe("theme lab draft", () => {
  it("reports only tokens whose final value differs from the stylesheet", () => {
    const draft = emptyDraft();
    draft.values.light["--workspace-tone-merged"] = "#6b3cba";
    draft.values.light["--workspace-header-fade-strength"] = "60%";
    expect([...changedTokens(draft, "light", originals.light)]).toEqual([
      ["--workspace-header-fade-strength", "60%"],
    ]);
  });

  it("applies a group's knobs to every colour in the group, in that theme only", () => {
    const draft = emptyDraft();
    draft.adjust.light["state-ready"] = { ...NO_ADJUST, lightness: 0.1 };
    const light = changedTokens(draft, "light", originals.light);
    expect(light.has("--workspace-tone-ready")).toBe(true);
    expect(light.has("--workspace-fill-ready")).toBe(true);
    expect(light.has("--workspace-tone-merged")).toBe(false);
    expect(changedTokens(draft, "dark", originals.dark).size).toBe(0);
  });

  it("can give a value to a token the stylesheet leaves unset", () => {
    const draft = emptyDraft();
    draft.values.dark["--workspace-glow-ready"] = "#22aa66";
    expect(changedTokens(draft, "dark", originals.dark).get("--workspace-glow-ready")).toBe(
      "#22aa66",
    );
  });

  it("exports pasteable CSS per theme with the old values, and nothing when unchanged", () => {
    expect(exportCss(emptyDraft(), originals)).toBe("");
    const draft = emptyDraft();
    draft.values.dark["--workspace-fill-ready"] = "#50d8a0";
    const css = exportCss(draft, originals);
    expect(css).toContain('.dark,\n[data-workspace-theme="dark"] {');
    expect(css).toContain("--workspace-fill-ready: #50d8a0; /* was #6ee7b7 */");
    expect(css).not.toContain(":root");
  });

  it("restores a saved draft and ignores a corrupt one", () => {
    const draft = emptyDraft();
    draft.values.light["--workspace-fill-merged"] = "#ffffff";
    draft.adjust.dark["state-merged"] = { lightness: -0.05, chroma: 1, hue: 0 };
    expect(parseDraft(JSON.stringify(draft))).toEqual(draft);
    expect(parseDraft("{not json")).toEqual(emptyDraft());
    expect(
      parseDraft(JSON.stringify({ adjust: { light: { "state-ready": { hue: "x" } } } })),
    ).toEqual(emptyDraft());
  });
});

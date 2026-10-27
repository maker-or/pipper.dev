import { canUseWASM } from "@pierre/diffs";

// Matches the Shiki theme pair used elsewhere for code (see shiki-code-block.tsx)
// so syntax highlighting looks the same in diffs, file previews and chat.
export const CODE_THEMES = { light: "github-light", dark: "github-dark" } as const;

// Highlights (WebAssembly, beta in @pierre/diffs 1.6) is far faster than Shiki
// on large files. The worker pool is a singleton shared by the diff view and
// file previews, so this is read once when it first starts. Fall back to
// Shiki where WebAssembly with SIMD is unavailable.
export const CODE_HIGHLIGHTER_OPTIONS = {
  theme: CODE_THEMES,
  preferredHighlighter: canUseWASM() ? "highlights" : "shiki-js",
} as const;

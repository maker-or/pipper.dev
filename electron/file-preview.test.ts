import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilePreviewService,
  parseByteRange,
  servePreviewFile,
  TEXT_PREVIEW_LIMIT_BYTES,
} from "./file-preview.ts";

let base: string;
let project: string;
let worktree: string;
let outside: string;

function service(worktrees: string[] = [project, worktree]) {
  return new FilePreviewService({
    getProjectPath: (id) => (id === "p1" ? project : null),
    listWorktreePaths: async () => worktrees,
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "pipper-file-preview-")));
  project = join(base, "project");
  worktree = join(base, "worktree");
  outside = join(base, "outside");
  for (const dir of [project, worktree, outside, join(project, "src")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(project, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(join(project, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
  writeFileSync(join(project, "data.bin"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(worktree, "README.md"), "# Worktree\n");
  writeFileSync(join(outside, "secret.txt"), "secret");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("FilePreviewService.stat", () => {
  test("returns a text file's contents and a binary file without them", async () => {
    const preview = service();
    const text = await preview.stat({ projectId: "p1", worktreePath: null, path: "src/app.ts" });
    expect(text).toMatchObject({ kind: "text", text: "export const a = 1;\n", tooLarge: false });

    const image = await preview.stat({ projectId: "p1", worktreePath: null, path: "logo.png" });
    expect(image).toMatchObject({ kind: "image", mimeType: "image/png", text: null });
    expect(image.canOpenExternally).toBe(true);

    const binary = await preview.stat({ projectId: "p1", worktreePath: null, path: "data.bin" });
    expect(binary).toMatchObject({ kind: "binary", text: null, canOpenExternally: false });
  });

  test("does not load text over the size limit", async () => {
    writeFileSync(join(project, "big.log"), "x".repeat(TEXT_PREVIEW_LIMIT_BYTES + 1));
    const info = await service().stat({ projectId: "p1", worktreePath: null, path: "big.log" });
    expect(info).toMatchObject({ kind: "text", tooLarge: true, text: null });
  });

  test("reads from a worktree that belongs to the project", async () => {
    const info = await service().stat({
      projectId: "p1",
      worktreePath: worktree,
      path: "README.md",
    });
    expect(info.text).toBe("# Worktree\n");
  });

  test("refuses paths that leave the workspace", async () => {
    const preview = service();
    symlinkSync(join(outside, "secret.txt"), join(project, "link.txt"));
    for (const path of ["../outside/secret.txt", join(outside, "secret.txt"), "link.txt", "src"]) {
      await expect(preview.stat({ projectId: "p1", worktreePath: null, path })).rejects.toThrow();
    }
  });

  test("refuses a folder that is not one of the project's worktrees", async () => {
    await expect(
      service([project]).stat({ projectId: "p1", worktreePath: outside, path: "secret.txt" }),
    ).rejects.toThrow("does not belong");
    await expect(
      service().stat({ projectId: "unknown", worktreePath: null, path: "src/app.ts" }),
    ).rejects.toThrow("Unknown project");
  });
});

describe("FilePreviewService.resolveRequest", () => {
  test("serves only URLs it issued, for files inside their workspace", async () => {
    const preview = service();
    const { url } = await preview.stat({ projectId: "p1", worktreePath: null, path: "logo.png" });
    expect(await preview.resolveRequest(url)).toBe(join(project, "logo.png"));

    const forgedToken = url.replace(preview.token, "0".repeat(32));
    expect(await preview.resolveRequest(forgedToken)).toBeNull();

    const escaped = url.replace("logo.png", "..%2F..%2Foutside%2Fsecret.txt");
    expect(await preview.resolveRequest(escaped)).toBeNull();

    const unknownRoot = `pipper-file://${preview.token}/ffffffffffffffff/logo.png`;
    expect(await preview.resolveRequest(unknownRoot)).toBeNull();
  });

  test("a second process cannot use the first one's URLs", async () => {
    const { url } = await service().stat({ projectId: "p1", worktreePath: null, path: "logo.png" });
    expect(await service().resolveRequest(url)).toBeNull();
  });
});

describe("servePreviewFile", () => {
  test("answers range requests with 206 so video and audio can seek", async () => {
    const path = join(project, "clip.mp4");
    writeFileSync(path, Buffer.from("0123456789"));

    const full = await servePreviewFile(path, null);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe("10");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-type")).toBe("video/mp4");

    const middle = await servePreviewFile(path, "bytes=2-5");
    expect(middle.status).toBe(206);
    expect(middle.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await middle.text()).toBe("2345");

    const tail = await servePreviewFile(path, "bytes=-3");
    expect(await tail.text()).toBe("789");

    const outOfRange = await servePreviewFile(path, "bytes=20-");
    expect(outOfRange.status).toBe(416);
    expect(outOfRange.headers.get("content-range")).toBe("bytes */10");
  });

  test("parses open-ended and clamped ranges", () => {
    expect(parseByteRange("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
    expect(parseByteRange("bytes=4-99", 10)).toEqual({ start: 4, end: 9 });
    expect(parseByteRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseByteRange("items=0-1", 10)).toBe("invalid");
  });
});

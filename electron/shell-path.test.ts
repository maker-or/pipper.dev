import { afterEach, describe, expect, test } from "vitest";
import {
  applyLoginShellPath,
  mergePathEntries,
  parseMarkedPath,
  readLoginShellPath,
} from "./shell-path.ts";

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
});

describe.skipIf(process.platform === "win32")("login shell PATH", () => {
  test("PATH is read even when shell startup files print around it", async () => {
    const path = await readLoginShellPath({
      shell: "/bin/zsh",
      run: async () =>
        "Welcome!\nnvm: using node v22\n__PIPPER_PATH_START__/Users/me/.nvm/versions/node/v22.1.0/bin:/usr/bin\n__PIPPER_PATH_END__",
    });
    expect(path).toBe("/Users/me/.nvm/versions/node/v22.1.0/bin:/usr/bin");
  });

  test("a shell that fails or hangs leaves PATH as it was", async () => {
    process.env.PATH = "/usr/bin:/bin";
    const changed = await applyLoginShellPath({
      run: async () => {
        throw new Error("timed out");
      },
    });
    expect(changed).toBe(false);
    expect(process.env.PATH).toBe("/usr/bin:/bin");
    expect(parseMarkedPath("no markers here")).toBeNull();
  });

  test("the shell's folders come first, and nothing already there is lost", async () => {
    process.env.PATH = "/opt/homebrew/bin:/usr/bin:/bin";
    const changed = await applyLoginShellPath({
      run: async () => "__PIPPER_PATH_START__/Users/me/.volta/bin:/usr/bin__PIPPER_PATH_END__",
    });
    expect(changed).toBe(true);
    expect(process.env.PATH).toBe("/Users/me/.volta/bin:/usr/bin:/opt/homebrew/bin:/bin");
    expect(mergePathEntries("/a:/b", "/b:/a")).toBe("/b:/a");
  });
});

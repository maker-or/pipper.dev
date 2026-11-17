import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER = "pipper-launch-intro";

/**
 * Build the native launch-intro helper (native/launch-intro) into its dist/
 * folder, where both electron-builder and the dev app look for it.
 *
 * Built through xcrun, like the other native helpers: a `swift` first on PATH
 * (swiftly, a Swift.org toolchain) can be a different Swift than the macOS
 * SDK, and then fails to load Foundation at all.
 *
 * `required`: a release build stops on failure; `bun run dev` only warns, so
 * the app still starts on a machine without Xcode.
 */
export function buildLaunchIntroHelper({ root, required }) {
  if (process.platform !== "darwin") return false;
  const packageDir = join(root, "native", "launch-intro");
  const args = [
    "swift",
    "build",
    "--package-path",
    packageDir,
    "--configuration",
    "release",
    "--arch",
    "arm64",
    "--product",
    HELPER,
  ];
  const fail = (message) => {
    if (required) throw new Error(`[launch-intro] ${message}`);
    console.warn(`[launch-intro] ${message}; the intro and its Dock items won't play.`);
    return false;
  };
  const build = spawnSync("xcrun", args, { stdio: "inherit" });
  if (build.error || build.status !== 0) return fail("the helper did not build");
  // The output directory depends on the SwiftPM build system; ask for it.
  const binPath = spawnSync("xcrun", [...args, "--show-bin-path"], { encoding: "utf8" });
  if (binPath.status !== 0) return fail("could not locate the helper build");
  const output = join(packageDir, "dist");
  mkdirSync(output, { recursive: true });
  copyFileSync(join(binPath.stdout.trim(), HELPER), join(output, HELPER));
  return true;
}

// `node scripts/launch-intro-helper.mjs`: the `bun run dev` step. Dev plays the
// intro unless VITE_PIPPER_LAUNCH_INTRO=0 (contracts/features.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.env.VITE_PIPPER_LAUNCH_INTRO !== "0") {
    buildLaunchIntroHelper({
      root: fileURLToPath(new URL("..", import.meta.url)),
      required: false,
    });
  }
}

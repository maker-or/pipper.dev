import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { loadEnv } from "vite";
import { preparePtyHelpers } from "./prepare-pty.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const loadedEnv = loadEnv("production", root, "");

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function run(args) {
  const result = spawnSync("bun", ["x", "--bun", ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function buildMacSleeplessHelpers() {
  if (process.platform !== "darwin") return;
  const source = join(root, "native", "sleepless");
  const output = join(source, "dist");
  mkdirSync(output, { recursive: true });
  const common = [
    "--sdk",
    "macosx",
    "clang",
    "-O2",
    "-fobjc-arc",
    "-arch",
    "arm64",
    "-mmacosx-version-min=13.0",
  ];
  runCommand("xcrun", [
    ...common,
    "-framework",
    "IOKit",
    "-framework",
    "Security",
    "-framework",
    "Foundation",
    join(source, "daemon", "main.m"),
    "-o",
    join(output, "omni-sleeplessd"),
  ]);
  runCommand("xcrun", [
    ...common,
    "-framework",
    "Security",
    "-framework",
    "Foundation",
    join(source, "control", "main.m"),
    "-o",
    join(output, "omni-sleeplessctl"),
  ]);

  for (const helper of ["omni-sleeplessd", "omni-sleeplessctl"]) {
    const helperPath = join(output, helper);
    if (!existsSync(helperPath)) {
      throw new Error(`Sleepless helper build did not produce ${helperPath}`);
    }
  }
}

function buildLaunchIntro() {
  if (process.platform !== "darwin") return;
  const packageDir = join(root, "native", "launch-intro");
  const args = [
    "build",
    "--package-path",
    packageDir,
    "--configuration",
    "release",
    "--arch",
    "arm64",
    "--product",
    "pipper-launch-intro",
  ];
  runCommand("swift", args);
  // The output directory depends on the SwiftPM build system; ask for it.
  const binPath = spawnSync("swift", [...args, "--show-bin-path"], { encoding: "utf8" });
  if (binPath.status !== 0) throw new Error("[build] could not locate the launch intro build");
  const output = join(packageDir, "dist");
  mkdirSync(output, { recursive: true });
  copyFileSync(
    join(binPath.stdout.trim(), "pipper-launch-intro"),
    join(output, "pipper-launch-intro"),
  );
}

function buildPipperIntents() {
  if (process.platform !== "darwin") return;
  const intentsDir = join(root, "native", "pipper-intents");
  const project = join(intentsDir, "PreviewApp", "PipperIntentsPreview.xcodeproj");
  if (!existsSync(project)) return;
  const output = join(intentsDir, "dist");
  mkdirSync(output, { recursive: true });
  const developerCandidates = [
    join(os.homedir(), "Downloads", "Xcode-beta.app", "Contents", "Developer"),
    "/Applications/Xcode-beta.app/Contents/Developer",
  ];
  const developerDir = developerCandidates.find((candidate) => existsSync(candidate));
  const env = developerDir ? { ...process.env, DEVELOPER_DIR: developerDir } : process.env;
  const result = spawnSync(
    "xcodebuild",
    [
      "-project",
      project,
      "-target",
      "PipperIntents",
      "-configuration",
      "Release",
      `CONFIGURATION_BUILD_DIR=${output}`,
      "PRODUCT_BUNDLE_IDENTIFIER=com.maker-or.omni.PipperIntents",
      "CODE_SIGNING_ALLOWED=YES",
      "CODE_SIGN_IDENTITY=-",
      "CODE_SIGN_STYLE=Manual",
      "CODE_SIGN_ENTITLEMENTS=../Extension/PipperIntents.entitlements",
      "build",
    ],
    {
      cwd: root,
      env,
      stdio: "inherit",
    },
  );
  if (result.error) {
    throw new Error(`[build] xcodebuild is required for PipperIntents: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`[build] PipperIntents extension build failed with exit code ${result.status}`);
  }
  const extension = join(output, "PipperIntents.appex");
  if (!existsSync(extension)) {
    throw new Error(`[build] PipperIntents extension build did not produce ${extension}`);
  }
}

preparePtyHelpers();
buildMacSleeplessHelpers();
buildLaunchIntro();
buildPipperIntents();

// Release builds must fail loud: a packaged app without a PostHog key silently
// drops every event. Local builds may still run without analytics.
// loadEnv keeps local .env builds working; process.env takes precedence in CI.
const posthogKey = firstNonEmpty(
  process.env.VITE_POSTHOG_KEY,
  process.env.PIPPER_POSTHOG_KEY,
  loadedEnv.VITE_POSTHOG_KEY,
  loadedEnv.PIPPER_POSTHOG_KEY,
);
const posthogHost =
  firstNonEmpty(
    process.env.VITE_POSTHOG_HOST,
    process.env.PIPPER_POSTHOG_HOST,
    loadedEnv.VITE_POSTHOG_HOST,
    loadedEnv.PIPPER_POSTHOG_HOST,
  ) ?? "https://us.i.posthog.com";
if (!posthogKey) {
  const message =
    "[build] missing PostHog key. Set VITE_POSTHOG_KEY/PIPPER_POSTHOG_KEY " +
    "in CI or .env before building a release.";
  if (process.env.CI === "true" || process.env.PIPPER_REQUIRE_POSTHOG_CONFIG === "true") {
    console.error(`[build] ERROR: ${message}`);
    process.exit(1);
  }
  console.warn(`[build] WARNING: ${message}`);
} else {
  console.log("[build] PostHog key present; analytics will be baked in.");
}
// Electron Vite only exposes VITE_* values through import.meta.env. Map the
// accepted PIPPER_* aliases before spawning it so validation and the bundle
// always use the same resolved configuration.
if (posthogKey) process.env.VITE_POSTHOG_KEY = posthogKey;
process.env.VITE_POSTHOG_HOST = posthogHost;
console.log(`[build] PostHog host: ${posthogHost}`);
run(["electron-vite", "build"]);

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

/**
 * Features held back from release builds; see contracts/features.ts, which
 * reads the same variables in the app. Off unless set to "1" here or in .env.
 * Resolved values are passed on to electron-vite so the app and this script
 * always agree.
 */
const FEATURE_ENV = {
  remote: "VITE_PIPPER_REMOTE",
  siri: "VITE_PIPPER_SIRI",
  clerk: "VITE_PIPPER_CLERK",
  launchIntro: "VITE_PIPPER_LAUNCH_INTRO",
};
const features = Object.fromEntries(
  Object.entries(FEATURE_ENV).map(([name, key]) => [
    name,
    firstNonEmpty(process.env[key], loadedEnv[key]) === "1",
  ]),
);
for (const [name, key] of Object.entries(FEATURE_ENV)) {
  process.env[key] = features[name] ? "1" : "0";
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
  if (!features.launchIntro) {
    // electron-builder packages whatever helper is in dist/, so a stale one
    // from an earlier build must go too.
    rmSync(join(packageDir, "dist", "pipper-launch-intro"), { force: true });
    console.log("[build] The launch intro is off; its helper is not built or packaged.");
    return;
  }
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
  if (!features.siri) {
    // electron-builder packages whatever extension is in dist/, so a stale
    // one from an earlier build must go too.
    rmSync(join(intentsDir, "dist", "PipperIntents.appex"), { recursive: true, force: true });
    console.log("[build] Siri is off; the App Intents extension is not built or packaged.");
    return;
  }
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

console.log(
  `[build] Features: ${Object.entries(features)
    .map(([name, on]) => `${name}=${on ? "on" : "off"}`)
    .join(", ")}`,
);
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
pruneUnreferencedMainChunks();

/**
 * The bundler still writes a dynamically imported chunk after the import is
 * removed as dead code (e.g. Remote with VITE_PIPPER_REMOTE off). Nothing
 * loads such a chunk, so drop it rather than ship it. Repeats until stable,
 * since an orphan may be the only thing referencing another chunk.
 */
function pruneUnreferencedMainChunks() {
  const mainDir = join(root, "out", "main");
  const chunksDir = join(mainDir, "chunks");
  if (!existsSync(chunksDir)) return;
  const sources = () => [
    ...readdirSync(mainDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => join(mainDir, name)),
    ...readdirSync(chunksDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => join(chunksDir, name)),
  ];
  const pruned = [];
  for (;;) {
    const files = sources();
    const orphans = readdirSync(chunksDir)
      .filter((name) => name.endsWith(".js"))
      .filter((name) => {
        const own = join(chunksDir, name);
        return !files.some((file) => file !== own && readFileSync(file, "utf8").includes(name));
      });
    if (orphans.length === 0) break;
    for (const name of orphans) {
      rmSync(join(chunksDir, name), { force: true });
      rmSync(join(chunksDir, `${name}.map`), { force: true });
      pruned.push(name);
    }
  }
  if (pruned.length > 0) console.log(`[build] Dropped unused main chunks: ${pruned.join(", ")}`);
}

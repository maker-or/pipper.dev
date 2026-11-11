// Builds, packages and publishes the macOS launcher from this machine, doing
// what .github/workflows/macos-launcher-release.yml does when CI is unavailable.
//
// The release lands on GitHub (which the in-app updater and the marketing
// site's /api/launcher/latest.json both read) and the Vercel Blob bridge
// manifest is repointed at it so older installs that poll Blob update too.
//
// Bun loads .env into process.env, so the PostHog and Blob credentials come
// from there.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import {
  PIPPER_LAUNCHER_MAC_MANIFEST_URL,
  PIPPER_RELEASE_REPOSITORY,
} from "../contracts/launcher-release-urls.ts";
import { launcherTagName, readPackageVersion } from "./launcher-release.ts";

type Options = {
  dryRun: boolean;
  skipBridge: boolean;
  skipChecks: boolean;
};

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const version = await readPackageVersion();
  const tag = launcherTagName(version);

  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The macOS launcher DMG must be built on an Apple Silicon Mac.");
  }
  if (capture("git", ["status", "--porcelain=v1"]).trim()) {
    throw new Error("Working tree is not clean. Commit or set aside changes before releasing.");
  }
  run("gh", ["auth", "status"]);

  // A tag that already exists (for example from a Windows release or a
  // partial CI run) pins the release to that commit; shipping a DMG built
  // from a different commit under the same version would mix sources.
  const head = capture("git", ["rev-parse", "HEAD"]).trim();
  const tagCommit = tryCapture("git", ["rev-list", "-n", "1", tag])?.trim();
  if (tagCommit && tagCommit !== head) {
    throw new Error(
      `${tag} points at ${tagCommit.slice(0, 7)} but HEAD is ${head.slice(0, 7)}. ` +
        "Check out the tag or bump package.json version.",
    );
  }

  const releaseExists =
    tryCapture("gh", ["release", "view", tag, "--repo", PIPPER_RELEASE_REPOSITORY]) !== null;

  for (const key of ["PIPPER_POSTHOG_KEY", "PIPPER_POSTHOG_HOST"]) {
    if (!process.env[key]?.trim()) throw new Error(`${key} is required (set it in .env).`);
  }
  if (!options.skipBridge && !process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    throw new Error("BLOB_READ_WRITE_TOKEN is required for the bridge (or pass --skip-bridge).");
  }

  // Mirror the CI build env. The update manifest is pinned to GitHub so a
  // local .env pointing elsewhere (e.g. the legacy Blob manifest) is never
  // baked into a shipped build.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANALYTICS_ENABLED: "true",
    PIPPER_REQUIRE_POSTHOG_CONFIG: "true",
    VITE_POSTHOG_KEY: process.env.PIPPER_POSTHOG_KEY,
    VITE_POSTHOG_HOST: process.env.PIPPER_POSTHOG_HOST,
    VITE_PIPPER_LAUNCHER_UPDATE_MANIFEST_URL: PIPPER_LAUNCHER_MAC_MANIFEST_URL,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  };

  console.log(
    `Releasing ${tag} to ${PIPPER_RELEASE_REPOSITORY} (${releaseExists ? "existing release" : "new release"}).`,
  );

  run("bun", ["install", "--frozen-lockfile"], env);
  if (!options.skipChecks) {
    // Some app tests import marketing/ modules, whose tsconfig extends astro's.
    run("bun", ["install", "--frozen-lockfile", "--cwd", "marketing"], env);
    run("bun", ["run", "fmt:check"], env);
    run("bun", ["run", "lint"], env);
    run("bun", ["run", "test"], env);
  }

  rmSync("release", { recursive: true, force: true });
  run("bun", ["run", "build"], env);
  run("bun", ["run", "sourcemaps:upload"], env);
  run("bun", ["run", "package:mac"], env);

  if (options.dryRun) {
    run("bun", ["run", "release:launcher:publish", "--", "--dry-run"], env);
    return;
  }

  const publishArgs = ["run", "release:launcher:publish", "--", "--skip-git-check"];
  if (releaseExists) publishArgs.push("--resume");
  run("bun", publishArgs, env);

  if (!options.skipBridge) run("bun", ["run", "release:launcher:bridge"], env);

  console.log(
    `\nPublished ${tag}: https://github.com/${PIPPER_RELEASE_REPOSITORY}/releases/tag/${tag}`,
  );
}

function parseOptions(argv: string[]): Options {
  const options: Options = { dryRun: false, skipBridge: false, skipChecks: false };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-bridge") options.skipBridge = true;
    else if (arg === "--skip-checks") options.skipChecks = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? 1}.`);
  }
}

function capture(command: string, args: string[]): string {
  const output = tryCapture(command, args);
  if (output === null) throw new Error(`${command} ${args.join(" ")} failed.`);
  return output;
}

function tryCapture(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout : null;
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

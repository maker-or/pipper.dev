import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  npxPackageOf,
  planStartRecovery,
  purgeNpxPackageCache,
  withNpxPackageLock,
} from "./start-recovery.ts";

describe("planStartRecovery", () => {
  const pkg = "@agentclientprotocol/codex-acp";

  test("each failure gets the repair that can fix it, or none", () => {
    expect(planStartRecovery({ reason: "not_installed", npmPackage: pkg })).toBe("refresh_path");
    expect(
      planStartRecovery({
        reason: "package_install_failed",
        stderr: "Error: Missing optional dependency @openai/codex-darwin-arm64.",
        npmPackage: pkg,
      }),
    ).toBe("purge_npx_cache");
    expect(
      planStartRecovery({
        reason: "package_install_failed",
        stderr: "npm error code ENOTFOUND\nnpm error network request failed",
        npmPackage: pkg,
      }),
    ).toBe("wait_and_retry");
    expect(planStartRecovery({ reason: "timeout", npmPackage: pkg })).toBe("retry_longer");
    expect(planStartRecovery({ reason: "exited_early", npmPackage: null })).toBe("retry");
  });

  test("failures a retry can't fix get no retry", () => {
    expect(planStartRecovery({ reason: "auth_required", npmPackage: pkg })).toBeNull();
    expect(planStartRecovery({ reason: "protocol_error", npmPackage: pkg })).toBeNull();
    expect(planStartRecovery({ reason: "unknown", npmPackage: pkg })).toBeNull();
    // npx refusing the folder it runs in: purging the cache wouldn't help.
    expect(
      planStartRecovery({
        reason: "package_install_failed",
        stderr: "npm error code EBADDEVENGINES",
        npmPackage: pkg,
      }),
    ).toBeNull();
    // A broken install that isn't an npx package has no cache to purge.
    expect(
      planStartRecovery({
        reason: "package_install_failed",
        stderr: "Cannot find module",
        npmPackage: null,
      }),
    ).toBeNull();
  });
});

describe("purgeNpxPackageCache", () => {
  test("removes only the npx folders holding that package", () => {
    const cache = mkdtempSync(join(tmpdir(), "pipper-npm-cache-"));
    const install = (hash: string, name: string) => {
      mkdirSync(join(cache, "_npx", hash, "node_modules", ...name.split("/")), { recursive: true });
    };
    install("broken", "@agentclientprotocol/codex-acp");
    install("other", "@agentclientprotocol/claude-agent-acp");
    writeFileSync(join(cache, "keep.txt"), "x");

    expect(purgeNpxPackageCache("@agentclientprotocol/codex-acp@2.6.0", cache)).toBe(1);

    expect(existsSync(join(cache, "_npx", "broken"))).toBe(false);
    expect(existsSync(join(cache, "_npx", "other"))).toBe(true);
    expect(existsSync(join(cache, "keep.txt"))).toBe(true);
  });

  test("a cache with no npx folder is left alone", () => {
    const cache = mkdtempSync(join(tmpdir(), "pipper-npm-cache-"));
    expect(purgeNpxPackageCache("@agentclientprotocol/codex-acp", cache)).toBe(0);
  });
});

describe("npx launches", () => {
  test("the package is read from an npx -y launch only", () => {
    expect(npxPackageOf("/usr/local/bin/npx", ["-y", "@a/b", "--acp"])).toBe("@a/b");
    expect(npxPackageOf("C:\\nodejs\\npx.cmd", ["-y", "@a/b"])).toBe("@a/b");
    expect(npxPackageOf("/usr/local/bin/codex-acp", [])).toBeNull();
  });

  test("starts of one package take turns; other packages run alongside", async () => {
    const log: string[] = [];
    const step = (name: string) => async () => {
      log.push(`start ${name}`);
      await new Promise((done) => setTimeout(done, 30));
      log.push(`end ${name}`);
    };
    await Promise.all([
      withNpxPackageLock("@a/codex@1", step("a1")),
      withNpxPackageLock("@a/codex@2", step("a2")),
      withNpxPackageLock("@a/claude", step("b")),
    ]);
    // Same package (any version): never overlapping.
    expect(log.indexOf("end a1")).toBeLessThan(log.indexOf("start a2"));
    // A different package started before the first one finished.
    expect(log.indexOf("start b")).toBeLessThan(log.indexOf("end a1"));
  });
});

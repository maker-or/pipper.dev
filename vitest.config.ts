import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { createCustomResolver } from "./src/lib/alias-resolver.ts";
import { nodeModulesGuardPlugin } from "./src/lib/node-modules-guard.ts";

const resolveCache = new Map<string, string | null>();

// The Expo app is its own npm project: its tsconfig extends expo/tsconfig.base
// and its sources import packages from its own node_modules, so its tests
// can only load once `npm install` has run in native/pipper-remote-expo.
const expoApp = join(__dirname, "native/pipper-remote-expo");
const expoInstalled = existsSync(join(expoApp, "node_modules/expo/tsconfig.base.json"));
if (!expoInstalled && process.env.VITEST) {
  console.warn(
    "[vitest] Skipping native/pipper-remote-expo tests: run `npm install` in that folder to include them.",
  );
}

export default defineConfig({
  plugins: [nodeModulesGuardPlugin(__dirname)],
  resolve: {
    alias: [
      {
        find: /^@\/(.*)$/,
        replacement: "$1",
        customResolver: createCustomResolver(resolveCache, __dirname),
      },
    ],
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.{ts,tsx}",
      "electron/**/*.test.{ts,tsx}",
      "scripts/**/*.test.ts",
      ...(expoInstalled ? ["native/pipper-remote-expo/src/**/*.test.ts"] : []),
    ],
    // Vitest blanks CSS by default, which would make `?raw` stylesheet
    // imports empty; the widget frame reads its tokens and icon styles that way.
    css: { include: [/src\/index\.css/, /@phosphor-icons\/web/] },
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    testTimeout: 20000,
  },
});

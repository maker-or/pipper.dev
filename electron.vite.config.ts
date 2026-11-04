import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { createCustomResolver } from "./src/lib/alias-resolver.ts";
import { nodeModulesGuardPlugin } from "./src/lib/node-modules-guard.ts";

const resolveCache = new Map<string, string | null>();

const cacheInvalidatorPlugin = {
  name: "resolve-cache-invalidator",
  configureServer(server: any) {
    server.watcher.on("all", (event: string) => {
      if (event === "add" || event === "unlink" || event === "change") {
        resolveCache.clear();
      }
    });
  },
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      minify: true,
      // Hidden maps keep shipped stacks resolvable without exposing source.
      // scripts/upload-sourcemaps.mjs injects and uploads them to PostHog;
      // electron-builder excludes *.map from the packaged app.
      sourcemap: "hidden",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/main.ts"),
          // Emitted beside index.js; electron/monitor/worker-client.ts loads it.
          "monitor-worker": resolve(__dirname, "electron/monitor/worker.ts"),
        },
        external: ["electron", "better-sqlite3", "node-pty", "qrcode-terminal"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      minify: true,
      sourcemap: "hidden",
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/preload.ts") },
        external: ["electron"],
      },
    },
  },
  renderer: {
    root: ".",
    worker: {
      format: "es",
    },
    resolve: {
      alias: [
        {
          find: /^@\/(.*)$/,
          replacement: "$1",
          customResolver: createCustomResolver(resolveCache, __dirname),
        },
      ],
    },
    server: {
      fs: {
        allow: [".."],
      },
    },
    plugins: [
      tailwindcss(),
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      cacheInvalidatorPlugin,
      nodeModulesGuardPlugin(__dirname),
    ],
    build: {
      outDir: "out/renderer",
      minify: true,
      sourcemap: "hidden",
      rollupOptions: {
        input: {
          main: resolve(__dirname, "index.html"),
          launch: resolve(__dirname, "launch.html"),
          monitor: resolve(__dirname, "monitor.html"),
          settings: resolve(__dirname, "settings.html"),
          "theme-lab": resolve(__dirname, "theme-lab.html"),
          remote: resolve(__dirname, "remote.html"),
        },
      },
    },
  },
});

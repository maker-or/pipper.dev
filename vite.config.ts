import { defineConfig } from "vite";
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

// https://vite.dev/config/
export default defineConfig({
  // Its own pre-bundle cache: sharing `node_modules/.vite` with a running
  // `bun run dev` rewrites that renderer's optimized deps under it, so its
  // next lazy chunk loads a second React ("reading 'useState' of null").
  cacheDir: "node_modules/.vite-specs",
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
});

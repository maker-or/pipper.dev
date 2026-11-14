# Pipper

Created by Harshith Pasupuleti

Pipper is a single interface to control your agents.

## Purpose

Every individual has a different way of working, so instead of us adapting to new tools and workflows, what if the tool could evolve around us? Think of it as a Claude Code or Codex instance customized to each individual's needs.

Pipper is built on ACP, so it supports many agents out of the box like Claude Code, Codex, Cursor, OpenCode, and Grok. This opens a completely new way to interact with all these agents from one place — e.g. use Sol as orchestrator to spin up Composer 2.5.

## INSTALLATION

You can download actaul application from the pipper[https://www.pipper.dev/download] both the mac and windows builds are unsigned to for mac after droping the DMG into your Applications folder. run the following command in the terminal `xattr -cr "/Applications/Pipper Code (Alpha).app"` for the windows build i have seens the its running in the older windows machine , i can do much here

## Preview the DMG installer

After building the app once with `bun run dist`, run `bun run preview:dmg` to preview
installer design changes. This reuses `release/mac-arm64/Pipper Code (Alpha).app`,
regenerates the installer and icon assets, and opens its window in Finder. Icon
changes are applied to a temporary copy of the app bundle.

Edit the `dmg` options in `electron-builder.yml`, background images in `build/`, or `pipper.icon`,
then run the preview command again. Preview images are uncompressed for faster
packaging and are written to `release/dmg-preview/`. The command ejects its previous
preview before opening the updated one. Run `bun run dist` when you need to include
changes to the application itself or produce the final distributable DMG.

## Architecture

Configure tab swipe navigation in Settings → Keyboard & trackpad. On macOS, Pipper
uses your existing “Swipe between pages” gesture: swipe left for the next visible
thread or terminal tab, or right for the previous tab. Navigation stops at the ends
of the tab bar and leaves horizontally scrollable content alone. Changes to the
system gesture preference take effect when you return to the app.

Pipper is a normal Electron desktop client with a stable launcher and a bundled renderer. The packaged application loads its UI from `out/renderer`; it does not start a guest Vite server or require a mutable active workspace.

The renderer talks to the Electron main process through the preload bridge. Main-process responsibilities include SQLite-backed projects and threads, ACP agent sessions, terminals, worktrees, MCP configuration, authentication, and launcher binary updates. User projects remain separate Git repositories and are used as agent working directories.

Desktop production builds minify the main process, preload, and renderer. Keep
renderer-only libraries and build tools in `devDependencies`: Vite bundles their
required code and assets into `out/renderer`. Reserve `dependencies` for packages
that the main process or preload loads at runtime, since electron-builder copies
production dependencies into the application. Install development dependencies
before building; a production-only install is for runtime packaging, not builds.

Minified functions make shipped error stacks unreadable, so production builds emit
hidden source maps (`.map` files with no `sourceMappingURL` reference). These maps
are never packaged — `electron-builder.yml` excludes `out/**/*.map` — and are
uploaded to PostHog error tracking instead, where `captureAnalyticsException`
reports resolve against them. Release workflows run `bun run sourcemaps:upload`
after the build and before packaging; it injects release context into each chunk
and uploads the maps to the `pipper-code-alpha` release. Set the `POSTHOG_CLI_API_KEY`
(personal API key with error-tracking write) and `POSTHOG_CLI_PROJECT_ID` secrets
to enable uploads, plus `POSTHOG_CLI_HOST` for EU Cloud or self-hosted projects.
Without those secrets the step logs a warning and ships minified stacks.

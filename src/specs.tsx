import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { ErrorBoundary } from "@/components/error-boundary";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { SpecStrip } from "@/specs/kit/spec-strip";
import { RailPoster } from "@/specs/posters/rail-poster";
import { TabReleasePoster } from "@/specs/posters/tab-release-poster";
import { TabSwapPoster } from "@/specs/posters/tab-swap-poster";

/**
 * Spec posters (the interface-bts skill): every poster in one row. A dev-only
 * page, served by `bunx vite` at /specs.html; it isn't part of the app build.
 */
function Specs() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <SpecStrip theme={resolvedTheme} onTheme={setTheme}>
      <TabSwapPoster key={`swap-${resolvedTheme}`} theme={resolvedTheme} />
      <TabReleasePoster key={`release-${resolvedTheme}`} theme={resolvedTheme} />
      <RailPoster key={`rail-${resolvedTheme}`} theme={resolvedTheme} />
    </SpecStrip>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <Specs />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);

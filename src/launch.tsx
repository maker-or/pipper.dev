import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { LaunchApp } from "@/launch/app";
import { ShapeProvider } from "@/lib/shape-context";
import { SurfaceProvider } from "@/lib/surface-context";
import { ThemeProvider } from "@/lib/theme";
import { Toaster } from "@/components/ui/toaster";
import { IconProvider } from "@/lib/icon-context";
import { ErrorBoundary } from "@/components/error-boundary";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <SurfaceProvider value={1}>
          <ShapeProvider defaultShape="pill">
            <IconProvider defaultLibrary="phosphor">
              <LaunchApp />
              <Toaster />
            </IconProvider>
          </ShapeProvider>
        </SurfaceProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);

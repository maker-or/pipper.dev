import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { ErrorBoundary } from "@/components/error-boundary";
import { ThemeLabApp } from "@/theme-lab/app";

// No ThemeProvider: the lab picks its own appearance, independent of the app's.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeLabApp />
    </ErrorBoundary>
  </StrictMode>,
);

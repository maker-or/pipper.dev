import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { WorkspaceModePicker } from "./workspace-mode-picker";
import { ThemeProvider } from "@/lib/theme";

describe("workspace mode picker", () => {
  test("renders both layout previews and rings the active one", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <WorkspaceModePicker />
      </ThemeProvider>,
    );

    expect(html).toContain('role="radiogroup"');
    expect(html.match(/type="radio"/g)?.length).toBe(3);
    expect(html).toContain("Basic");
    expect(html).toContain("Hybrid");
    expect(html).toContain("Advanced");
    // Node has no stored preference, so Basic is the active option.
    expect(html).toContain("border-[#3b82f6]");
  });
});

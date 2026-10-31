import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SettingChange } from "../../contracts/settings.ts";
import { SettingsChangeCardView } from "@/components/settings-change-card";
import { buildMessageBodyBlocks } from "@/lib/inline-widgets";
import { settingsChangeFromToolPart } from "@/lib/settings-change-links";

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const ID = "2feaf268-d2eb-46e1-8516-3f3ba247f47c";

const BROWSER_OFF: SettingChange = {
  path: "browser.enabled",
  label: "Browser for agents",
  from: true,
  to: false,
  fromText: "on",
  toText: "off",
  widens: false,
  applies: "new_threads",
};

describe("SettingsChangeCardView", () => {
  test("lists each change with an undo, and says when it applies to new threads", () => {
    const html = renderToStaticMarkup(
      <SettingsChangeCardView
        changes={[BROWSER_OFF]}
        undone={false}
        undoing={false}
        onUndo={noop}
      />,
    );
    expect(text(html)).toContain("Settings changed");
    expect(text(html)).toContain("Browser for agents");
    expect(text(html)).toContain("on → off");
    expect(text(html)).toContain("Undo");
    expect(text(html)).toContain("apply to new threads");
  });

  test("an undone change stays as a record without the button", () => {
    const html = renderToStaticMarkup(
      <SettingsChangeCardView changes={[BROWSER_OFF]} undone undoing={false} onUndo={noop} />,
    );
    expect(text(html)).toContain("Settings change undone");
    expect(text(html)).not.toContain("Undo");
  });
});

test("an update_settings call becomes one settings block; one without a change_id none", () => {
  const part = (output: string) => ({
    type: "toolCall",
    id: "t1",
    name: "pipper-agents_update_settings",
    status: "completed",
    outputPreview: output,
  });
  const changed = part(`{ "change_id": "${ID}", "status": "changed" }`);
  expect(settingsChangeFromToolPart(changed)).toBe(ID);
  expect(settingsChangeFromToolPart(part(`{ "status": "unchanged" }`))).toBeNull();
  expect(buildMessageBodyBlocks([changed, changed])).toEqual([
    { kind: "settings", changeId: ID, key: `settings:${ID}` },
  ]);
});

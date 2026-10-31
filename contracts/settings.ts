/**
 * Settings agents can read and change through `get_settings` and
 * `update_settings` (docs/capabilities/design.md, "Settings").
 */

export type SettingValue = boolean | number | string | string[];

/** One setting an update changed. */
export interface SettingChange {
  /** "browser.enabled". */
  path: string;
  /** "Browser for agents". */
  label: string;
  from: SettingValue;
  to: SettingValue;
  /** The same values, as the user reads them: "off", "on", "4 pages". */
  fromText: string;
  toText: string;
  /** True when the change widened what agents can do; it needed the user's yes. */
  widens: boolean;
  /** "new_threads" when it adds or removes tools, which a session reads once. */
  applies: "now" | "new_threads";
}

/** A settings update an agent made, shown in its thread with an undo. */
export interface SettingChangeRecord {
  changeId: string;
  threadId: string;
  changes: SettingChange[];
  undone: boolean;
  createdAt: number;
}

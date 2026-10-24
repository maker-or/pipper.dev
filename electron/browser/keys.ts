/** Key names and chords agents pass to browser_press, mapped to CDP key events. */

export interface ParsedKey {
  key: string;
  code: string;
  keyCode: number;
  modifiers: number;
  text?: string;
}

const NAMED_KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

/** "Enter", "a", "Control+Shift+K" → CDP key event fields. */
export function parseKey(input: string): ParsedKey {
  const parts = input.split("+").map((part) => part.trim());
  const keyName = parts.pop() ?? "";
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIER_BITS[part.toLowerCase()];
    if (bit == null) throw new Error(`Unknown modifier "${part}"`);
    modifiers |= bit;
  }
  const named = NAMED_KEYS[keyName.toLowerCase()];
  if (named) {
    return { ...named, modifiers, text: modifiers & ~8 ? undefined : named.text };
  }
  if (keyName.length !== 1) throw new Error(`Unknown key "${keyName}"`);
  const upper = keyName.toUpperCase();
  const isLetter = upper >= "A" && upper <= "Z";
  const isDigit = keyName >= "0" && keyName <= "9";
  const shifted = modifiers & 8 ? upper : keyName;
  return {
    key: shifted,
    code: isLetter ? `Key${upper}` : isDigit ? `Digit${keyName}` : "",
    keyCode: isLetter || isDigit ? upper.charCodeAt(0) : keyName.charCodeAt(0),
    modifiers,
    // Chords with Ctrl/Alt/Meta are commands, not text input.
    text: modifiers & ~8 ? undefined : shifted,
  };
}

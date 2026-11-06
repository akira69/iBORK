export type Modifier = "ControlLeft" | "AltLeft" | "ShiftLeft";
export type Stroke = {
  code: string;
  key: string;
  shift?: boolean;
  shifted?: string;
};
export type SendKey = (code: string, key: string, down: boolean) => void;
export const modifierKeys = {
  ControlLeft: "Control",
  AltLeft: "Alt",
  ShiftLeft: "Shift",
};
// Virtual server keys bypass noVNC's local OS modifier remapping.
const keysyms: Record<string, number> = {
  Control: 0xffe3,
  Alt: 0xffe9,
  Shift: 0xffe1,
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Delete: 0xffff,
};
export function vncKeysym(key: string): number {
  if (key.length === 1) return key.charCodeAt(0);
  if (/^F([1-9]|1[0-2])$/.test(key)) return 0xffbd + Number(key.slice(1));
  if (keysyms[key]) return keysyms[key];
  throw Error("Unsupported server key");
}
const characters = new Map<string, Stroke>();
function pair(code: string, key: string, shifted: string) {
  characters.set(key, { code, key, shifted });
  characters.set(shifted, { code, key: shifted, shifted, shift: true });
}
for (const key of "abcdefghijklmnopqrstuvwxyz")
  pair(`Key${key.toUpperCase()}`, key, key.toUpperCase());
for (const [i, key] of [..."0123456789"].entries())
  pair(`Digit${key}`, key, ")!@#$%^&*("[i]);
for (const [code, key, shifted] of [
  ["Minus", "-", "_"],
  ["Equal", "=", "+"],
  ["BracketLeft", "[", "{"],
  ["BracketRight", "]", "}"],
  ["Backslash", "\\", "|"],
  ["Semicolon", ";", ":"],
  ["Quote", "'", '"'],
  ["Backquote", "`", "~"],
  ["Comma", ",", "<"],
  ["Period", ".", ">"],
  ["Slash", "/", "?"],
])
  pair(code, key, shifted);
for (const [text, code, key] of [
  [" ", "Space", " "],
  ["\t", "Tab", "Tab"],
  ["\n", "Enter", "Enter"],
  ["\r", "Enter", "Enter"],
])
  characters.set(text, { code, key });

export function textStrokes(text: string): Stroke[] | null {
  if (text.length > 256) return null;
  const strokes = [...text.replace(/\r\n/g, "\n")].map((key) =>
    characters.get(key),
  );
  return strokes.every((stroke): stroke is Stroke => !!stroke) ? strokes : null;
}
export function sendStroke(
  stroke: Stroke,
  modifiers: Modifier[],
  send: SendKey,
) {
  const mods = new Set(modifiers);
  if (stroke.shift) mods.add("ShiftLeft");
  const keys: Stroke[] = [...mods].map((code) => ({
    code,
    key: modifierKeys[code],
  }));
  keys.push({
    code: stroke.code,
    key: mods.has("ShiftLeft") ? (stroke.shifted ?? stroke.key) : stroke.key,
  });
  const pressed: typeof keys = [];
  try {
    for (const key of keys) {
      pressed.push(key);
      send(key.code, key.key, true);
    }
  } finally {
    for (const key of pressed.reverse()) {
      try {
        send(key.code, key.key, false);
      } catch {
        /* Release the remaining keys even when transport fails. */
      }
    }
  }
}

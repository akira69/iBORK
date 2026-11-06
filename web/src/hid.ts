// SPDX-License-Identifier: GPL-2.0-only
// Adapted from jetkvm/kvm ui/src/{keyboardMappings.ts,hooks/hidRpc.ts}.
export const keyCodes: Record<string, number> = {
  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Space: 44,
  Minus: 45,
  Equal: 46,
  BracketLeft: 47,
  BracketRight: 48,
  Backslash: 49,
  Semicolon: 51,
  Quote: 52,
  Backquote: 53,
  Comma: 54,
  Period: 55,
  Slash: 56,
  CapsLock: 57,
  PrintScreen: 70,
  ScrollLock: 71,
  Pause: 72,
  Insert: 73,
  Home: 74,
  PageUp: 75,
  Delete: 76,
  End: 77,
  PageDown: 78,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
  NumLock: 83,
  NumpadDivide: 84,
  NumpadMultiply: 85,
  NumpadSubtract: 86,
  NumpadAdd: 87,
  NumpadEnter: 88,
  Numpad0: 98,
  NumpadDecimal: 99,
  IntlBackslash: 100,
  ContextMenu: 101,
  ControlLeft: 224,
  ShiftLeft: 225,
  AltLeft: 226,
  MetaLeft: 227,
  ControlRight: 228,
  ShiftRight: 229,
  AltRight: 230,
  MetaRight: 231,
};
for (let i = 0; i < 26; i++)
  keyCodes[`Key${String.fromCharCode(65 + i)}`] = 4 + i;
for (let i = 0; i < 10; i++) keyCodes[`Digit${i}`] = i ? 29 + i : 39;
for (let i = 1; i <= 24; i++) keyCodes[`F${i}`] = i <= 12 ? 57 + i : 91 + i;
for (let i = 1; i <= 9; i++) keyCodes[`Numpad${i}`] = 88 + i;
export function pointer(
  x: number,
  y: number,
  buttons: number,
): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(10);
  const view = new DataView(data.buffer);
  data[0] = 3;
  view.setInt32(1, Math.round(Math.max(0, Math.min(1, x)) * 32767));
  view.setInt32(5, Math.round(Math.max(0, Math.min(1, y)) * 32767));
  data[9] = buttons & 31;
  return data;
}

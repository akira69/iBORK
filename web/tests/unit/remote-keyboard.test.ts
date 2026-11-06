import { expect, it, vi } from "vitest";
import { textStrokes, sendStroke, vncKeysym } from "../../src/remote-keyboard";

it("maps virtual VNC characters and server keys independently of client OS", () => {
  expect(
    ["A", "Alt", "ArrowLeft", "Delete", "F1", "F12"].map(vncKeysym),
  ).toEqual([65, 0xffe9, 0xff51, 0xffff, 0xffbe, 0xffc9]);
  expect(() => vncKeysym("F13")).toThrow();
});

it("maps phone text to US physical keys with required shift", () => {
  const keys = textStrokes("aA!0_\t\n")!;
  expect(keys.map((k) => k.code)).toEqual([
    "KeyA",
    "KeyA",
    "Digit1",
    "Digit0",
    "Minus",
    "Tab",
    "Enter",
  ]);
  expect(keys.map((k) => !!k.shift)).toEqual([
    false,
    true,
    true,
    false,
    true,
    false,
    false,
  ]);
});
it("rejects unsupported or oversized input without partial typing", () => {
  expect(textStrokes("valid😀")).toBeNull();
  expect(textStrokes("a".repeat(257))).toBeNull();
  expect(textStrokes("a".repeat(256))).toHaveLength(256);
});
it("sends a complete modifier chord, then releases in reverse order", () => {
  const send = vi.fn();
  sendStroke(textStrokes("c")![0], ["ControlLeft", "ShiftLeft"], send);
  expect(send.mock.calls).toEqual([
    ["ControlLeft", "Control", true],
    ["ShiftLeft", "Shift", true],
    ["KeyC", "C", true],
    ["KeyC", "C", false],
    ["ShiftLeft", "Shift", false],
    ["ControlLeft", "Control", false],
  ]);
});
it("attempts to release every pressed key even if sending fails", () => {
  const send = vi.fn((code, _key, down) => {
    if (code === "KeyC") throw Error(String(down));
  });
  expect(() =>
    sendStroke(textStrokes("c")![0], ["ControlLeft"], send),
  ).toThrow();
  expect(send).toHaveBeenLastCalledWith("ControlLeft", "Control", false);
});

import { useEffect, useRef, useState, type RefObject } from "react";
import { Keyboard, Check, ChevronsUpDown, Scan } from "lucide-react";
import { createPortal } from "react-dom";
import { useMobileConsole } from "./useMobileConsole";
import { useConsoleZoom } from "./useConsoleZoom";
import {
  modifierKeys,
  sendStroke,
  textStrokes,
  type Modifier,
  type SendKey,
  type Stroke,
} from "./remote-keyboard";
import "./console-keyboard.css";

export function isConsoleKeyboard(target: EventTarget | null) {
  return target instanceof Element && !!target.closest(".console-keyboard");
}
export function ConsoleKeyboard({
  display,
  ready,
  enabled,
  onControl,
  onRelease,
  sendKey,
}: {
  display: RefObject<HTMLElement | null>;
  ready: boolean;
  enabled: boolean;
  onControl: () => void;
  onRelease: () => void;
  sendKey: SendKey;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const pointerMode = useRef(false);
  const typing = useRef(false);
  const [viewport, setViewport] = useState({
    bottom: 8,
    target: document.body as Element,
  });
  const [row, setRow] = useState(0);
  const [open, setOpen] = useState(false);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  const [notice, setNotice] = useState("");
  useMobileConsole(open && enabled && ready, display, dock);
  const zoom = useConsoleZoom(open && enabled && ready, display);
  const zoomTouch = useRef(zoom.touch);
  zoomTouch.current = zoom.touch;
  const current = useRef({ ready, enabled, onControl, onRelease, sendKey });
  current.current = { ready, enabled, onControl, onRelease, sendKey };
  function activate() {
    if (!current.current.ready) return;
    current.current.onControl();
    typing.current = true;
    pointerMode.current = false;
    setRow(0);
    setOpen(true);
    field.current?.focus({ preventScroll: true });
    field.current?.setSelectionRange(
      field.current.value.length,
      field.current.value.length,
    );
  }
  useEffect(() => {
    const element = display.current;
    const touch = (event: PointerEvent) => {
      if (
        event.pointerType !== "touch" ||
        !current.current.ready ||
        pointerMode.current
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "pointerdown" && !typing.current) activate();
    };
    const suppressGesture = (event: TouchEvent) => {
      if (!current.current.ready || pointerMode.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      zoomTouch.current(event);
    };
    for (const type of [
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
    ])
      element?.addEventListener(type, touch as EventListener, true);
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"])
      element?.addEventListener(type, suppressGesture as EventListener, {
        capture: true,
        passive: false,
      });
    return () => {
      for (const type of [
        "pointerdown",
        "pointermove",
        "pointerup",
        "pointercancel",
      ])
        element?.removeEventListener(type, touch as EventListener, true);
      for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"])
        element?.removeEventListener(
          type,
          suppressGesture as EventListener,
          true,
        );
    };
  }, [display]);
  useEffect(() => {
    const update = () =>
      setViewport({
        bottom: Math.max(
          8,
          window.innerHeight -
            (window.visualViewport?.height ?? window.innerHeight) -
            (window.visualViewport?.offsetTop ?? 0) +
            8,
        ),
        target: document.fullscreenElement ?? document.body,
      });
    update();
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    const fullscreen = () => {
      if (typing.current) current.current.onRelease();
      update();
    };
    document.addEventListener("fullscreenchange", fullscreen);
    return () => {
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      document.removeEventListener("fullscreenchange", fullscreen);
    };
  }, []);
  useEffect(() => {
    if (!enabled || !ready) {
      typing.current = false;
      setOpen(false);
      setModifiers([]);
      composing.current = false;
      pointerMode.current = false;
      if (field.current) {
        field.current.value = " ";
        field.current.blur();
      }
    }
  }, [enabled, ready]);
  function press(stroke: Stroke, mods = modifiers) {
    if (!typing.current || !current.current.enabled || !current.current.ready)
      return;
    try {
      sendStroke(stroke, mods, current.current.sendKey);
      setNotice("");
    } catch {
      setNotice("Keyboard input failed. Reconnect the console.");
    }
    setModifiers([]);
  }
  function flush(inputType = "") {
    const input = field.current;
    if (!input || composing.current) return;
    const value = input.value.startsWith(" ")
      ? input.value.slice(1)
      : input.value;
    input.value = " ";
    if (!typing.current || !current.current.enabled || !current.current.ready)
      return;
    if (inputType === "deleteContentBackward") {
      press({ code: "Backspace", key: "Backspace" });
      return;
    }
    if (inputType === "deleteContentForward") {
      press({ code: "Delete", key: "Delete" });
      return;
    }
    const strokes = textStrokes(value);
    if (!strokes) {
      setModifiers([]);
      setNotice("Use US keyboard characters, up to 256 characters at a time.");
      return;
    }
    strokes.forEach((stroke, index) =>
      press(stroke, index === 0 ? modifiers : []),
    );
  }
  const keys = (items: string[][]) =>
    items.map(([code, label]) => (
      <button
        key={code}
        type="button"
        aria-label={code === "Escape" ? "Esc" : code}
        onClick={() => press({ code, key: code })}
      >
        {label}
      </button>
    ));
  return (
    <>
      <div className="console-keyboard console-keyboard-launcher">
        <button
          className="console-keyboard-toggle"
          type="button"
          disabled={!ready}
          onClick={activate}
          aria-label="Show keyboard"
          title="Show phone keyboard and server keys"
        >
          <Keyboard size={18} />
        </button>
      </div>
      {createPortal(
        <div
          ref={dock}
          className="console-keyboard console-keyboard-dock"
          style={{ bottom: viewport.bottom }}
          onMouseDown={(event) => {
            if (event.target !== field.current) event.preventDefault();
          }}
          onClick={() => {
            // Restore phone typing within the tap gesture if a key took focus.
            if (
              typing.current &&
              current.current.enabled &&
              current.current.ready
            )
              field.current?.focus({ preventScroll: true });
          }}
        >
          <textarea
            ref={field}
            className="console-keyboard-input"
            aria-label="Remote keyboard input"
            defaultValue=" "
            tabIndex={-1}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="enter"
            onInput={(event) => {
              if (!(event.nativeEvent as InputEvent).isComposing)
                flush((event.nativeEvent as InputEvent).inputType);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
              queueMicrotask(() => flush());
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && event.shiftKey) {
                event.preventDefault();
                onRelease();
              } else if (
                !event.nativeEvent.isComposing &&
                ["Enter", "Tab", "Escape"].includes(event.key)
              ) {
                event.preventDefault();
                press({ code: event.key, key: event.key });
              }
            }}
            onBlur={(event) => {
              if (
                !isConsoleKeyboard(event.relatedTarget) &&
                !(
                  event.relatedTarget instanceof Node &&
                  display.current?.contains(event.relatedTarget)
                )
              )
                onRelease();
            }}
          />
          {open && enabled ? (
            <div
              className="console-keyboard-bar"
              aria-label="Server keyboard controls"
            >
              <button
                type="button"
                className="console-keyboard-row-switch"
                aria-label={`Next key row (current: ${["Keys", "Nav", "F1–12"][row]})`}
                title="Switch key row · swipe sideways for more keys"
                onClick={() => setRow((value) => (value + 1) % 3)}
              >
                <ChevronsUpDown size={12} />
                <span>{["Keys", "Nav", "F1–12"][row]}</span>
              </button>
              <div className="console-keyboard-row" key={row}>
                {row === 0 && (
                  <>
                    {(Object.keys(modifierKeys) as Modifier[]).map((code) => (
                      <button
                        type="button"
                        key={code}
                        title="Applies to the next key"
                        aria-pressed={modifiers.includes(code)}
                        onClick={() =>
                          setModifiers((value) =>
                            value.includes(code)
                              ? value.filter((key) => key !== code)
                              : [...value, code],
                          )
                        }
                      >
                        {code === "ControlLeft" ? "Ctrl" : modifierKeys[code]}
                      </button>
                    ))}
                    {keys([
                      ["Escape", "Esc"],
                      ["Tab", "Tab"],
                      ["Enter", "Enter"],
                    ])}
                  </>
                )}
                {row === 1 &&
                  keys([
                    ["ArrowLeft", "←"],
                    ["ArrowDown", "↓"],
                    ["ArrowUp", "↑"],
                    ["ArrowRight", "→"],
                    ["Backspace", "⌫"],
                    ["Delete", "Del"],
                    ["Home", "Home"],
                    ["End", "End"],
                    ["PageUp", "PgUp"],
                    ["PageDown", "PgDn"],
                  ])}
                {row === 2 &&
                  keys(
                    Array.from({ length: 12 }, (_, i) => [
                      `F${i + 1}`,
                      `F${i + 1}`,
                    ]),
                  )}
              </div>
              <button
                type="button"
                aria-label="Fit console"
                title="Fit console · pinch to zoom, drag to pan"
                onClick={zoom.reset}
              >
                <Scan size={18} />
              </button>
              <button
                type="button"
                aria-label="Done — hide keyboard"
                title="Done — hide keyboard and use touch pointer"
                onClick={() => {
                  typing.current = false;
                  composing.current = false;
                  if (field.current) field.current.value = " ";
                  setOpen(false);
                  setModifiers([]);
                  pointerMode.current = true;
                  const target =
                    display.current?.querySelector("canvas") ?? display.current;
                  target?.focus({ preventScroll: true });
                }}
              >
                <Check size={18} /> Done
              </button>
              {notice && <p role="alert">{notice}</p>}
            </div>
          ) : null}
        </div>,
        viewport.target,
      )}
    </>
  );
}

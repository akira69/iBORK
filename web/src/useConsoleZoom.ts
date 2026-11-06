import { useCallback, useEffect, useRef, type RefObject } from "react";

type View = { scale: number; x: number; y: number };
const fit: View = { scale: 1, x: 0, y: 0 };
export function boundConsoleView(
  view: View,
  width: number,
  height: number,
): View {
  const scale = Math.max(1, Math.min(5, view.scale));
  const clamp = (value: number, size: number) =>
    Math.max(
      (-size * (scale - 1)) / 2,
      Math.min((size * (scale - 1)) / 2, value),
    );
  return { scale, x: clamp(view.x, width), y: clamp(view.y, height) };
}

export function useConsoleZoom(
  active: boolean,
  display: RefObject<HTMLElement | null>,
) {
  const view = useRef(fit);
  const gesture = useRef<{ x: number; y: number; distance: number } | null>(
    null,
  );
  const target = useCallback(
    () => display.current?.querySelector("canvas") ?? display.current,
    [display],
  );
  const reset = useCallback(() => {
    view.current = fit;
    gesture.current = null;
    const element = target();
    element?.style.removeProperty("transform");
    element?.style.removeProperty("transform-origin");
  }, [target]);
  useEffect(() => {
    if (!active) {
      reset();
      return;
    }
    // A rotated phone or resized keyboard changes the fitted display dimensions.
    const observer = new ResizeObserver(reset);
    if (display.current) observer.observe(display.current);
    return () => {
      observer.disconnect();
      reset();
    };
  }, [active, display, reset]);
  function touch(event: TouchEvent) {
    const element = target();
    if (!active || !element) return;
    const points = Array.from(event.touches).slice(0, 2);
    if (!points.length) {
      gesture.current = null;
      return;
    }
    const first = points[0],
      second = points[1] ?? first;
    const next = {
      x: (first.clientX + second.clientX) / 2,
      y: (first.clientY + second.clientY) / 2,
      distance: Math.hypot(
        first.clientX - second.clientX,
        first.clientY - second.clientY,
      ),
    };
    const previous = gesture.current;
    if (event.type === "touchmove" && previous) {
      const rect = element.getBoundingClientRect();
      const old = view.current;
      const scale = Math.max(
        1,
        Math.min(
          5,
          old.scale *
            (next.distance && previous.distance
              ? next.distance / previous.distance
              : 1),
        ),
      );
      const ratio = scale / old.scale;
      view.current = boundConsoleView(
        {
          scale,
          x:
            old.x +
            next.x -
            previous.x +
            (previous.x - rect.left - rect.width / 2) * (1 - ratio),
          y:
            old.y +
            next.y -
            previous.y +
            (previous.y - rect.top - rect.height / 2) * (1 - ratio),
        },
        rect.width / old.scale,
        rect.height / old.scale,
      );
      const { x, y } = view.current;
      element.style.transformOrigin = "center";
      element.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }
    gesture.current = next;
  }
  return { touch, reset };
}

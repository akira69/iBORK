import { useLayoutEffect, type RefObject } from "react";

export function useMobileConsole(
  active: boolean,
  display: RefObject<HTMLElement | null>,
  controls: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    if (!active || !matchMedia("(pointer: coarse)").matches) return;
    const container =
      display.current?.closest<HTMLElement>(".video-area") ?? display.current;
    const screen =
      container === document.fullscreenElement ? display.current : container;
    const bar = controls.current;
    if (!screen || !bar || !screen.showPopover) return;
    const elements = [
      [screen, "mobile-console-view"],
      [bar, "mobile-console-keys"],
    ] as const;
    const update = () => {
      const view = window.visualViewport;
      for (const [element] of elements) {
        element.style.setProperty("--typing-top", `${view?.offsetTop ?? 0}px`);
        element.style.setProperty(
          "--typing-left",
          `${view?.offsetLeft ?? 0}px`,
        );
        element.style.setProperty(
          "--typing-width",
          `${view?.width ?? innerWidth}px`,
        );
        element.style.setProperty(
          "--typing-height",
          `${view?.height ?? innerHeight}px`,
        );
      }
    };
    // Top-layer promotion escapes dashboard clipping without replacing the live display.
    for (const [element, className] of elements) {
      element.classList.add(className);
      element.popover = "manual";
      element.showPopover();
    }
    update();
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      for (const [element, className] of elements) {
        if (element.matches(":popover-open")) element.hidePopover();
        element.removeAttribute("popover");
        element.classList.remove(className);
        for (const name of ["top", "left", "width", "height"])
          element.style.removeProperty(`--typing-${name}`);
      }
    };
  }, [active, display, controls]);
}

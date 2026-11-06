import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type RFB from "@novnc/novnc";
import { type ConsoleSessionStore, type ConsoleKey } from "./console-session";
import { api, APIError } from "./api";
import { ConsoleKeyboard, isConsoleKeyboard } from "./ConsoleKeyboard";
import { vncKeysym } from "./remote-keyboard";
import {
  Expand,
  Monitor,
  Terminal,
  PlugZap,
  Unplug,
  Keyboard,
  ShieldCheck,
} from "lucide-react";
import "./vnc-console.css";

export function VNCConsole({
  apiPrefix,
  csrf,
  session,
}: {
  apiPrefix: string;
  csrf: string;
  session: { store: ConsoleSessionStore; key: ConsoleKey };
}) {
  const { store, key: sessionKey } = session;
  const snapshot = useSyncExternalStore(store.subscribe, () =>
    store.getSnapshot(sessionKey),
  );
  const ready = useRef<{
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const dropControl = useCallback(() => {
    if (store.isControlling(sessionKey)) store.setControl(null);
  }, [store, sessionKey]);
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const client = useRef<RFB | null>(null);
  const pending = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState("Disconnected");
  const [notice, setNotice] = useState("");
  const [controlling, setControlling] = useState(false);
  const inputEnabled = useRef(false);
  const heldKeys = useRef(new Map<string, KeyboardEventInit>());
  const pointer = useRef({ clientX: 0, clientY: 0 });

  const releaseInputs = useCallback(() => {
    const rfb = client.current;
    const canvas = host.current?.querySelector("canvas");
    if (rfb && canvas && inputEnabled.current) {
      // noVNC disables sendKey before ungrabbing; release through its DOM handlers first.
      for (const key of heldKeys.current.values())
        canvas.dispatchEvent(
          new KeyboardEvent("keyup", { ...key, bubbles: true }),
        );
      canvas.dispatchEvent(
        new MouseEvent("mouseup", {
          ...pointer.current,
          buttons: 0,
          bubbles: true,
        }),
      );
    }
    heldKeys.current.clear();
  }, []);
  const release = useCallback(() => {
    releaseInputs();
    if (client.current) {
      client.current.viewOnly = true;
      client.current.blur();
    }
    inputEnabled.current = false;
    setControlling(false);
  }, [releaseInputs]);

  useEffect(() => {
    const screen = host.current;
    if (!screen) return;
    const key = (event: KeyboardEvent) => {
      if (!inputEnabled.current) return;
      if (event.code === "Escape" && event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        dropControl();
        return;
      }
      if (event.type === "keydown")
        heldKeys.current.set(event.code || event.key, {
          code: event.code,
          key: event.key,
          keyCode: event.keyCode,
          location: event.location,
        });
      else heldKeys.current.delete(event.code || event.key);
    };
    const mouse = (event: MouseEvent) => {
      pointer.current = { clientX: event.clientX, clientY: event.clientY };
    };
    const visibility = () => {
      if (document.hidden) dropControl();
    };
    const blur = (event: FocusEvent) => {
      releaseInputs();
      if (!isConsoleKeyboard(event.relatedTarget)) dropControl();
    };
    screen.addEventListener("keydown", key, true);
    screen.addEventListener("keyup", key, true);
    screen.addEventListener("mousedown", mouse, true);
    screen.addEventListener("mousemove", mouse, true);
    screen.addEventListener("blur", blur, true);
    window.addEventListener("blur", dropControl);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      dropControl();
      screen.removeEventListener("keydown", key, true);
      screen.removeEventListener("keyup", key, true);
      screen.removeEventListener("mousedown", mouse, true);
      screen.removeEventListener("mousemove", mouse, true);
      screen.removeEventListener("blur", blur, true);
      window.removeEventListener("blur", dropControl);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [dropControl, releaseInputs]);
  const disconnect = useCallback(() => {
    release();
    pending.current?.abort();
    pending.current = null;
    ready.current?.reject(new Error("Connection cancelled"));
    ready.current = null;
    const rfb = client.current;
    client.current = null;
    rfb?.disconnect();
    setPhase("Disconnected");
  }, [release]);

  useEffect(() => disconnect, [apiPrefix, csrf, disconnect]);

  const connect = useCallback(
    async (signal: AbortSignal) => {
      if (signal.aborted || !host.current) throw Error("Connection cancelled");
      const request = new AbortController();
      pending.current = request;
      const abort = () => disconnect();
      signal.addEventListener("abort", abort, { once: true });
      setPhase("Connecting");
      setNotice("");
      try {
        const [{ password }, { default: RFB }] = await Promise.all([
          api<{ password: string }>(apiPrefix + "vnc/session", {
            method: "POST",
            headers: { "X-CSRF-Token": csrf },
            body: "{}",
            signal: request.signal,
          }),
          import("@novnc/novnc"),
        ]);
        if (pending.current !== request || signal.aborted || !host.current)
          throw Error("Connection cancelled");
        await new Promise<void>((resolve, reject) => {
          ready.current = { resolve, reject };
          const url = new URL(`/api/${apiPrefix}vnc`, location.origin);
          url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
          let established = false,
            transportClosed = false;
          const socket = new WebSocket(url.href, "binary");
          socket.addEventListener("close", (event) => {
            transportClosed = true;
            if (pending.current !== request || signal.aborted) return;
            const failure =
              event.code === 4403
                ? "certificate"
                : event.code === 4401 ||
                    event.code === 1008 ||
                    event.code === 4406
                  ? "auth"
                  : event.code === 4409
                    ? "busy"
                    : event.code === 4001
                      ? "superseded"
                      : null;
            if (failure)
              store.report(
                sessionKey,
                {
                  phase:
                    failure === "busy" || failure === "superseded"
                      ? failure
                      : "failed",
                  error:
                    event.code === 4406
                      ? "Unsupported VNC authentication. Configure classic VNC password authentication."
                      : failure === "certificate"
                        ? "VNC certificate rejected. Verify the saved fingerprint."
                        : failure === "busy"
                          ? "VNC is busy. Close the other session before reconnecting."
                          : "VNC authentication or session rejected.",
                },
                failure,
              );
          });
          const rfb = new RFB(host.current!, socket, {
            credentials: { password },
            shared: true,
          });
          client.current = rfb;
          rfb.viewOnly = true;
          rfb.resizeSession = false;
          rfb.scaleViewport = true;
          rfb.focusOnClick = false;
          rfb.addEventListener("connect", () => {
            if (client.current !== rfb) return;
            established = true;
            setPhase("Connected · view only");
            ready.current = null;
            resolve();
          });
          rfb.addEventListener("disconnect", () => {
            if (client.current !== rfb) return;
            // noVNC rejects local protocol/auth negotiation before the socket close event.
            const rejected = !established && !transportClosed;
            store.report(
              sessionKey,
              {
                phase: "failed",
                error: rejected
                  ? "VNC handshake rejected: unsupported protocol or authentication. Use classic VNC password authentication."
                  : "VNC disconnected. Check console availability and existing sessions.",
              },
              rejected ? "auth" : "transient",
            );
          });
          for (const event of [
            "securityfailure",
            "credentialsrequired",
            "serververification",
          ]) {
            rfb.addEventListener(event, () => {
              if (client.current !== rfb) return;
              store.report(
                sessionKey,
                {
                  phase: "failed",
                  error:
                    "VNC authentication failed. Check the server's VNC configuration.",
                },
                "auth",
              );
            });
          }
        });
      } catch (error) {
        if (pending.current === request && !signal.aborted)
          store.report(
            sessionKey,
            {
              phase: "failed",
              error:
                "VNC connection failed. Check sign-in and console configuration.",
            },
            error instanceof APIError && [401, 403].includes(error.status)
              ? "auth"
              : "transient",
          );
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    [apiPrefix, csrf, disconnect, store, sessionKey],
  );
  useEffect(
    () =>
      store.register(sessionKey, {
        connect,
        disconnect,
        release,
        setInputEnabled(enabled) {
          if (!enabled) {
            release();
            return;
          }
          if (client.current) {
            inputEnabled.current = true;
            client.current.viewOnly = false;
            client.current.focus({ preventScroll: true });
            setControlling(true);
          }
        },
      }),
    [store, sessionKey, connect, disconnect, release],
  );
  const status =
    snapshot.phase === "connecting"
      ? "Connecting"
      : snapshot.phase === "reconnecting"
        ? "Reconnecting"
        : phase;

  return (
    <section
      className="vnc-console"
      ref={panel}
      aria-label="iDRAC view-only console"
    >
      <div className="vnc-toolbar">
        <span role="status">
          <i className={snapshot.phase === "live" ? "dot ok" : "dot"} />
          {controlling ? "Connected · controlling" : status}
        </span>
        <button
          aria-label="Connect VNC"
          title="Connect console"
          disabled={["connecting", "reconnecting", "live"].includes(
            snapshot.phase,
          )}
          onClick={() => store.connect(sessionKey)}
        >
          <PlugZap size={17} aria-hidden="true" />
        </button>
        <button
          aria-label={controlling ? "Release control" : "Control VNC"}
          title={
            controlling
              ? "Release keyboard and mouse"
              : "Control keyboard and mouse"
          }
          aria-pressed={controlling}
          disabled={!phase.startsWith("Connected")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            store.setControl(inputEnabled.current ? null : sessionKey)
          }
        >
          {controlling ? (
            <ShieldCheck size={17} aria-hidden="true" />
          ) : (
            <Keyboard size={17} aria-hidden="true" />
          )}
        </button>
        <button
          aria-label="Disconnect VNC"
          title="Disconnect console"
          disabled={snapshot.phase === "disconnected"}
          onClick={() => store.disconnect(sessionKey)}
        >
          <Unplug size={17} aria-hidden="true" />
        </button>
        <button
          aria-label="Fullscreen VNC"
          title="Fullscreen console"
          onClick={() => {
            const action = document.fullscreenElement
              ? document.exitFullscreen()
              : panel.current?.requestFullscreen();
            action?.catch(() =>
              setNotice("Fullscreen is unavailable in this browser."),
            );
          }}
        >
          <Expand size={17} />
        </button>
      </div>
      <p className="vnc-hint">
        {controlling
          ? "Keyboard and mouse enabled · Shift+Escape releases control."
          : "View only · Use the keyboard button to take control."}
      </p>
      {(notice || snapshot.error) && (
        <p role="alert">{notice || snapshot.error}</p>
      )}
      <div className="vnc-display-area">
        <div className="vnc-screen" ref={host} aria-label="Remote display" />
        {snapshot.phase !== "live" && (
          <div className="console-empty vnc-empty">
            <div className="monitor-glyph">
              <Monitor size={34} strokeWidth={1.3} />
            </div>
            <h2>
              {["connecting", "reconnecting"].includes(snapshot.phase)
                ? "Connecting to console…"
                : "Your console is ready"}
            </h2>
            <p>Connect to view and control this server.</p>
            <button
              className="primary"
              disabled={["connecting", "reconnecting"].includes(snapshot.phase)}
              onClick={() => store.connect(sessionKey)}
            >
              <Terminal size={16} />
              {snapshot.phase === "failed"
                ? "Retry connection"
                : "Connect to console"}
            </button>
          </div>
        )}
      </div>
      <ConsoleKeyboard
        display={host}
        ready={snapshot.phase === "live"}
        enabled={controlling}
        onControl={() => store.setControl(sessionKey)}
        onRelease={dropControl}
        sendKey={(code, key, down) => {
          if (!inputEnabled.current) return;
          client.current?.sendKey(vncKeysym(key), code, down);
        }}
      />
    </section>
  );
}

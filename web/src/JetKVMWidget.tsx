import { useEffect, useRef, useState } from "react";
import {
  Monitor,
  RefreshCw,
  Terminal,
  Expand,
  ExternalLink,
  Unplug,
} from "lucide-react";
import { type JetKVMProvider, type KVMState } from "./kvm";
import { ConsoleKeyboard, isConsoleKeyboard } from "./ConsoleKeyboard";

export function JetKVMWidget({
  provider,
  state,
  stream,
  endpoint,
  inputEnabled,
  onFeedback,
  onConnect,
  onDisconnect,
  onControl,
  onRelease,
  providerName = "JetKVM",
}: {
  provider:
    | (Pick<JetKVMProvider, "key" | "release"> &
        Partial<Pick<JetKVMProvider, "mouse" | "wheel">>)
    | null;
  providerName?: string;
  state: KVMState;
  stream: MediaStream | null;
  endpoint: string;
  inputEnabled: boolean;
  onFeedback: (message: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onControl: () => void;
  onRelease: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null),
    videoArea = useRef<HTMLDivElement>(null);
  const [resolution, setResolution] = useState("No video signal");
  const connected = state === "connected" || state === "no-signal";
  useEffect(() => {
    const element = video.current;
    const wheel = (event: WheelEvent) => {
      if (!inputEnabled || !provider?.wheel) return;
      event.preventDefault();
      provider.wheel(event.deltaY);
    };
    element?.addEventListener("wheel", wheel, { passive: false });
    if (
      inputEnabled &&
      !videoArea.current?.contains(document.activeElement) &&
      !isConsoleKeyboard(document.activeElement)
    )
      element?.focus({ preventScroll: true });
    if (!inputEnabled) {
      element?.blur();
      provider?.release();
    }
    return () => {
      element?.removeEventListener("wheel", wheel);
      provider?.release();
    };
  }, [provider, inputEnabled]);
  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
    if (!stream) setResolution("No video signal");
  }, [stream]);
  function pointer(event: React.PointerEvent<HTMLVideoElement>) {
    if (!inputEnabled) {
      if (event.type === "pointerdown") {
        event.preventDefault();
        onControl();
      }
      return;
    }
    if (!provider?.mouse) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const width = event.currentTarget.videoWidth,
      height = event.currentTarget.videoHeight;
    if (!width || !height) return;
    const scale = Math.min(rect.width / width, rect.height / height),
      w = width * scale,
      h = height * scale;
    const x = (event.clientX - rect.left - (rect.width - w) / 2) / w,
      y = (event.clientY - rect.top - (rect.height - h) / 2) / h;
    if (event.type === "pointerdown") {
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    provider?.mouse(
      Math.max(0, Math.min(1, x)),
      Math.max(0, Math.min(1, y)),
      event.buttons,
    );
  }

  return (
    <section className="console-card">
      <div className="panel-bar">
        <div>
          <Monitor size={17} />
          <strong>Remote console</strong>
          <span className="tiny-chip">{providerName}</span>
        </div>
        <button
          className="quiet"
          aria-label="Reconnect"
          title="Reconnect console"
          onClick={() => {
            onDisconnect();
            onConnect();
          }}
        >
          <RefreshCw size={17} aria-hidden="true" />
        </button>
        <button
          className="quiet"
          aria-label="Disconnect console"
          title="Disconnect console"
          onClick={onDisconnect}
          disabled={state === "disconnected"}
        >
          <Unplug size={17} aria-hidden="true" />
        </button>
      </div>
      <div ref={videoArea} className="video-area">
        <video
          ref={video}
          autoPlay
          playsInline
          muted
          tabIndex={connected && inputEnabled ? 0 : -1}
          aria-label="Remote server video and keyboard control"
          className={
            stream || state === "no-signal" ? "live-video" : "no-stream"
          }
          onLoadedMetadata={() =>
            setResolution(
              `${video.current?.videoWidth} × ${video.current?.videoHeight}`,
            )
          }
          onKeyDown={(e) => {
            if (!inputEnabled) return;
            if (e.code === "Escape" && e.shiftKey) {
              onRelease();
              e.currentTarget.blur();
              return;
            }
            e.preventDefault();
            provider?.key(e.code, true);
          }}
          onKeyUp={(e) => {
            if (!inputEnabled) return;
            if (e.code === "Escape" && e.shiftKey) {
              onRelease();
              e.currentTarget.blur();
              return;
            }
            e.preventDefault();
            provider?.key(e.code, false);
          }}
          onBlur={(event) => {
            provider?.release();
            if (!isConsoleKeyboard(event.relatedTarget)) onRelease();
          }}
          onPointerDown={pointer}
          onPointerMove={pointer}
          onPointerUp={pointer}
          onPointerCancel={() => provider?.release()}
          onContextMenu={(e) => e.preventDefault()}
        />
        <ConsoleKeyboard
          display={video}
          ready={connected}
          enabled={inputEnabled}
          onControl={onControl}
          onRelease={onRelease}
          sendKey={(code, _key, down) => provider?.key(code, down)}
        />
        {state === "no-signal" && (
          <div className="console-no-signal">
            <strong>No HDMI signal</strong>
            <span>
              Click the display to enable keyboard control and wake the server.
            </span>
          </div>
        )}
        {!stream && state !== "no-signal" && (
          <div className="console-empty">
            <div className="monitor-glyph">
              <Monitor size={34} strokeWidth={1.3} />
            </div>
            <h2>
              {connected
                ? "Waiting for video signal"
                : state === "connecting" || state === "reconnecting"
                  ? `Connecting to ${providerName}…`
                  : "Your console is ready"}
            </h2>
            <p>
              {state === "superseded"
                ? "Another session has control. Reconnect to use it here."
                : "Connect to view and control this server."}
            </p>
            <button
              className="primary"
              onClick={onConnect}
              disabled={state === "connecting" || state === "reconnecting"}
            >
              <Terminal size={16} />
              {state === "failed" ? "Retry connection" : "Connect to console"}
            </button>
            <span className="endpoint">{endpoint}</span>
          </div>
        )}
        {/^https?:\/\//i.test(endpoint) && (
          <a
            className="fullscreen native-console-link"
            href={endpoint}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open native ${providerName} interface`}
            title={`Open native ${providerName} interface in a new tab`}
          >
            <ExternalLink size={17} />
          </a>
        )}
        <button
          className="fullscreen"
          aria-label="Fullscreen console"
          title="Fullscreen console"
          onClick={() =>
            void videoArea.current
              ?.requestFullscreen()
              .catch(() =>
                onFeedback("Fullscreen is unavailable in this browser."),
              )
          }
        >
          <Expand size={17} />
        </button>
      </div>
      <div className="console-footer">
        <span>
          <i className={connected ? "dot ok" : "dot"} />
          {connected
            ? providerName === "JetKVM"
              ? "WebRTC connected"
              : "Console connected"
            : "Console not connected"}
        </span>
        <span>{resolution}</span>
        <span className="input-hint">
          Click video to control · Shift + Esc releases keyboard
        </span>
      </div>
    </section>
  );
}

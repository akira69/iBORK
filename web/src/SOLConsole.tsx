import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./sol-console.css";

export function SOLConsole({
  apiPrefix,
  active,
}: {
  apiPrefix: string;
  active: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const inputActive = useRef(active);
  const [phase, setPhase] = useState("Disconnected");
  const [notice, setNotice] = useState("");

  function disconnect() {
    const ws = socket.current;
    socket.current = null;
    ws?.close();
    setPhase("Disconnected");
  }

  useEffect(() => {
    inputActive.current = active;
    if (terminal.current) terminal.current.options.disableStdin = !active;
  }, [active]);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 1000,
      disableStdin: !inputActive.current,
      theme: { background: "#0c1118", foreground: "#dbe4ee" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    terminal.current = term;
    let frame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fit.fit());
    });
    resize.observe(host.current);
    const input = term.onData((data) => {
      const ws = socket.current;
      if (!inputActive.current || !ws || ws.readyState !== WebSocket.OPEN)
        return;
      if (new TextEncoder().encode(data).length > 4096) {
        setNotice("Input is too large. Paste at most 4096 bytes at a time.");
        return;
      }
      if (ws.bufferedAmount > 64 * 1024) {
        disconnect();
        setNotice(
          "Disconnected because the console could not keep up with input.",
        );
        return;
      }
      ws.send(data);
    });
    return () => {
      disconnect();
      cancelAnimationFrame(frame);
      resize.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, [apiPrefix]);

  function connect() {
    if (!active || socket.current || !terminal.current) return;
    const url = new URL(`/api/${apiPrefix}sol`, location.origin);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    const term = terminal.current;
    socket.current = ws;
    ws.binaryType = "arraybuffer";
    setPhase("Connecting");
    setNotice("");
    let queued = 0;
    ws.onopen = () => {
      if (socket.current !== ws) return;
      setPhase("Transport connected");
      term.focus();
    };
    ws.onmessage = (event: MessageEvent<unknown>) => {
      if (socket.current !== ws) return;
      if (
        !(event.data instanceof ArrayBuffer) ||
        event.data.byteLength > 4096 ||
        queued + event.data.byteLength > 256 * 1024
      ) {
        disconnect();
        setNotice(
          "Disconnected because console output exceeded its buffer limit.",
        );
        return;
      }
      const data = new Uint8Array(event.data);
      queued += data.byteLength;
      term.write(data, () => {
        queued -= data.byteLength;
      });
      setPhase("Receiving console output");
    };
    ws.onerror = () => {
      if (socket.current === ws)
        setNotice(
          "SOL connection failed. Check sign-in, BMC SOL settings and existing sessions.",
        );
    };
    ws.onclose = (event) => {
      if (socket.current !== ws) return;
      socket.current = null;
      setPhase("Disconnected");
      if (event.code !== 1000)
        setNotice(
          "SOL disconnected. Check sign-in, BMC SOL settings and existing sessions.",
        );
    };
  }

  return (
    <section
      className="sol-console"
      ref={panel}
      aria-label="Serial over LAN console"
    >
      <div className="sol-toolbar">
        <strong>SOL</strong>
        <span role="status">{active ? phase : "Inactive"}</span>
        <button
          disabled={!active || phase !== "Disconnected"}
          onClick={connect}
        >
          Connect SOL
        </button>
        <button disabled={phase === "Disconnected"} onClick={disconnect}>
          Disconnect SOL
        </button>
        <button
          disabled={!active}
          onClick={() => {
            const action = document.fullscreenElement
              ? document.exitFullscreen()
              : panel.current?.requestFullscreen();
            action?.catch(() =>
              setNotice("Fullscreen is unavailable in this browser."),
            );
          }}
        >
          Fullscreen SOL
        </button>
      </div>
      <p className="sol-hint">
        Connect explicitly to the BMC serial console. BIOS or OS serial
        redirection must be enabled. Use Disconnect or ~X at the start of a line
        to exit.
      </p>
      {notice && <p role="alert">{notice}</p>}
      <div className="sol-terminal" ref={host} aria-label="SOL terminal" />
    </section>
  );
}

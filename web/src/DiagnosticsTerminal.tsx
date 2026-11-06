import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { api, APIError } from "./api";
import "./operator-tools.css";

const initialOutput = "Read-only IPMI diagnostics. Enter help for commands.\n";
const outputLimit = 64 * 1024;

export function DiagnosticsTerminal({
  apiPrefix,
  csrf,
  active,
}: {
  apiPrefix: string;
  csrf: string;
  active: boolean;
}) {
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState(initialOutput);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const log = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setOutput(initialOutput);
    setCommand("");
    setHistory([]);
    setHistoryIndex(0);
    setBusy(false);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [apiPrefix, csrf]);
  useEffect(() => {
    if (!active) {
      request.current?.abort();
      request.current = null;
      setBusy(false);
    }
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [active]);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [output]);

  function append(value: string) {
    setOutput((previous) => (previous + value).slice(-outputLimit));
  }
  async function run(event: FormEvent) {
    event.preventDefault();
    const submitted = command.trim();
    if (!active || busy || !submitted) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setCommand("");
    setHistory((previous) => [...previous, submitted].slice(-20));
    setHistoryIndex(0);
    append(`\n> ${submitted}\n`);
    try {
      const result = await api<{ output: string; truncated: boolean }>(
        `${apiPrefix}diagnostics`,
        {
          method: "POST",
          headers: { "X-CSRF-Token": csrf },
          body: JSON.stringify({ command: submitted }),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(65000),
          ]),
        },
      );
      if (request.current === controller)
        append(
          `${result.output}${result.truncated ? "\n[Output truncated]" : ""}\n`,
        );
    } catch (error) {
      if (request.current === controller && !controller.signal.aborted)
        append(
          `${error instanceof APIError ? error.message : "Diagnostic request failed or timed out."}\n`,
        );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  function recall(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const next = Math.max(
      0,
      Math.min(
        history.length,
        historyIndex + (event.key === "ArrowUp" ? 1 : -1),
      ),
    );
    setHistoryIndex(next);
    setCommand(next ? history[history.length - next] : "");
  }
  return (
    <section className="diagnostics-terminal" aria-label="IPMI diagnostics">
      <p>
        Read commands only. No shell, host overrides or credentials. Use ↑ / ↓
        for recent commands.
      </p>
      {!active && (
        <p role="status">
          Diagnostics paused while this device view is inactive.
        </p>
      )}
      <pre
        ref={log}
        tabIndex={0}
        role="log"
        aria-label="Diagnostic output"
        aria-live="polite"
      >
        {output}
      </pre>
      <form onSubmit={run}>
        <label>
          Command
          <input
            value={command}
            maxLength={128}
            onChange={(event) => {
              setCommand(event.target.value);
              setHistoryIndex(0);
            }}
            onKeyDown={recall}
            autoComplete="off"
            spellCheck={false}
            placeholder="help"
            disabled={!active || busy}
          />
        </label>
        <button disabled={!active || busy || !command.trim()}>Run</button>
        {busy && (
          <button
            type="button"
            onClick={() => {
              request.current?.abort();
              request.current = null;
              setBusy(false);
              append("Canceled.\n");
            }}
          >
            Cancel
          </button>
        )}
        <button type="button" onClick={() => setOutput(initialOutput)}>
          Clear output
        </button>
      </form>
    </section>
  );
}

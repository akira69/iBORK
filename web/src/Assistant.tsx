import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { assistantCopy } from "./assistant-copy";
import { previewLayout } from "./assistant-layout";
import { catalog } from "./dashboard-layout";
import type { Device } from "./device-identity";

export type Draft = { id: string; name: string; host: string; jetUrl: string };
type State = {
  scope: string;
  servers: Record<string, string>;
  candidates?: { id: string; address: string; evidence: string }[];
  draft?: Draft;
  layout?: { source: string; target: string };
};
type Status = {
  messages?: { role: string; content: string }[];
  revision: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  state: State;
};
type Turn = {
  reply?: string;
  error?: string;
  activity: { name: string; failed: boolean }[] | null;
  state: State;
};
export default function Assistant({
  csrf,
  review,
  onLayout,
}: {
  csrf: string;
  review: (draft: Draft) => ReactNode;
  onLayout?: (id: string) => void;
}) {
  const t = assistantCopy(navigator.language);
  const [status, setStatus] = useState<State>(),
    [base, setBase] = useState(""),
    [model, setModel] = useState(""),
    [key, setKey] = useState(""),
    [hasKey, setHasKey] = useState(false);
  const [savedModel, setSavedModel] = useState({ base: "", model: "" });
  const [revision, setRevision] = useState("");
  const [expiry, setExpiry] = useState("");
  const [scope, setScope] = useState(""),
    [message, setMessage] = useState(""),
    [chat, setChat] = useState<{ question: string; result: Turn }[]>([]);
  const [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [secret, setSecret] = useState(""),
    [reviewing, setReviewing] = useState(false),
    [preview, setPreview] = useState<ReturnType<typeof previewLayout>>();
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<Status>("assistant/status", { signal: controller.signal })
      .then((s) => {
        if (controller.signal.aborted) return;
        setStatus(s.state);
        const messages = s.messages ?? [];
        setChat(
          messages.flatMap((m, i) =>
            m.role === "user" && messages[i + 1]?.role === "assistant"
              ? [
                  {
                    question: m.content,
                    result: {
                      reply: messages[i + 1].content,
                      activity: null,
                      state: s.state,
                    },
                  },
                ]
              : [],
          ),
        );
        setBase(s.baseUrl);
        setRevision(s.revision);
        setModel(s.model);
        setSavedModel({ base: s.baseUrl, model: s.model });
        setHasKey(s.hasKey);
        setScope(s.state.scope);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setNote(String(e));
      });
    return () => {
      controller.abort();
      active.current?.abort();
    };
  }, []);
  async function run(fn: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setNote("");
    try {
      await fn(
        AbortSignal.any([controller.signal, AbortSignal.timeout(62000)]),
      );
    } catch (e) {
      if (!controller.signal.aborted)
        setNote(e instanceof Error ? e.message : t.error);
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  function post<T>(path: string, body: unknown, signal: AbortSignal) {
    return api<T>("assistant/" + path, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
      signal,
    });
  }
  function update(state: State) {
    setStatus(state);
    setPreview(undefined);
    setReviewing(false);
  }
  const canSend =
    !!message.trim() &&
    !!status &&
    !!savedModel.model &&
    base === savedModel.base &&
    model === savedModel.model &&
    !key &&
    !busy;
  return (
    <section className="assistant-body">
      <p>{t.intro}</p>
      <details>
        <summary>{t.provider}</summary>
        <label>
          {t.endpoint}
          <input
            value={base}
            onChange={(e) => {
              setBase(e.target.value);
              setKey("");
              setHasKey(false);
            }}
            placeholder="https://…/v1"
          />
        </label>
        <label>
          {t.model}
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label>
          {t.key}
          <input
            type="password"
            autoComplete="new-password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        {hasKey && <p>{t.retained}</p>}
        <button
          disabled={busy || !status || !model || !base}
          onClick={() =>
            run(async (signal) => {
              const saved = await post<{ revision: string }>(
                "provider",
                { baseUrl: base, model, key },
                signal,
              );
              setRevision(saved.revision);
              setSavedModel({ base, model });
              setKey("");
              setHasKey(!!key || hasKey);
              setChat([]);
              setNote(t.tested);
            })
          }
        >
          {t.test}
        </button>
      </details>
      <details>
        <summary>{t.scope}</summary>
        <label>
          {t.hosts}
          <input value={scope} onChange={(e) => setScope(e.target.value)} />
        </label>
        <button
          disabled={busy || !scope}
          onClick={() =>
            run(async (signal) => {
              update(await post<State>("scope", { scope }, signal));
              setChat([]);
              setSecret("");
              setNote(t.scopeSaved);
            })
          }
        >
          {t.approve}
        </button>
      </details>
      <p>
        {t.scopeLabel}: {status?.scope || t.noScope}
      </p>
      <details>
        <summary>{t.connect}</summary>
        <p>{t.pairHelp}</p>
        <textarea
          readOnly
          aria-label="MCP JSON"
          onFocus={(e) => e.target.select()}
          value={JSON.stringify(
            {
              mcpServers: {
                ibork: {
                  url: location.origin + "/api/assistant/mcp",
                  headers: { Authorization: "Bearer <token>" },
                },
              },
            },
            null,
            2,
          )}
        />
        <div>
          <button
            disabled={busy}
            onClick={() =>
              run(async (signal) => {
                const pair = await post<{ token: string; expires: string }>(
                  "pair",
                  {},
                  signal,
                );
                setSecret(pair.token);
                setExpiry(new Date(pair.expires).toLocaleTimeString());
              })
            }
          >
            {t.pair}
          </button>{" "}
          <button
            disabled={busy}
            onClick={() =>
              run(async (signal) => {
                await post("revoke", {}, signal);
                setSecret("");
                setNote(t.revoked);
              })
            }
          >
            {t.revoke}
          </button>
        </div>
        {secret && (
          <p>
            {t.expires} {expiry}
          </p>
        )}
        {secret && (
          <input
            aria-label="Bearer token"
            readOnly
            title={expiry}
            value={secret}
            onFocus={(e) => e.target.select()}
          />
        )}
      </details>
      <h3>{t.chat}</h3>
      <p>{t.privacy}</p>
      {savedModel.model && (
        <p>
          {t.provider}: {savedModel.model} · {savedModel.base}
        </p>
      )}
      {chat.map(({ question, result }, i) => (
        <div className="assistant-turn" key={i}>
          <strong>{question}</strong>
          {result.activity?.map((a, j) => (
            <code key={j}>
              {a.name}
              {a.failed ? " ×" : " ✓"}
            </code>
          ))}
          <p>{result.reply || result.error}</p>
        </div>
      ))}
      <details>
        <summary>{t.suggest}</summary>
        {[t.find, t.pairKvm, t.status, t.tidy, t.sync].map((label, i) => (
          <button key={label} onClick={() => setMessage(t.prompts[i])}>
            {label}
          </button>
        ))}
      </details>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const question = message.trim();
          if (!canSend) return;
          void run(async (signal) => {
            const result = await post<Turn>(
              "chat",
              { message: question, language: navigator.language, revision },
              signal,
            );
            update(result.state);
            setChat((old) => [...old.slice(-19), { question, result }]);
            setMessage("");
          });
        }}
      >
        <label>
          {t.question}
          <textarea
            maxLength={2000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <button disabled={!canSend}>{t.send}</button>
        {busy && (
          <button
            type="button"
            onClick={() => {
              active.current?.abort();
              setNote(t.stopped);
            }}
          >
            {t.stop}
          </button>
        )}
      </form>
      <button
        disabled={busy}
        onClick={() =>
          run(async (signal) =>
            update((await api<Status>("assistant/status", { signal })).state),
          )
        }
      >
        {t.refresh}
      </button>
      {!!status?.candidates?.length && (
        <ul>
          {status.candidates.map((c) => (
            <li key={c.id}>
              {c.address} · {c.evidence}
            </li>
          ))}
        </ul>
      )}
      {status?.draft && (
        <section>
          <h4>
            {t.server}: {status.draft.name}
          </h4>
          <p>
            {[status.draft.host, status.draft.jetUrl]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <button onClick={() => setReviewing(!reviewing)}>
            {reviewing ? t.discard : t.review}
          </button>
          {reviewing && review(status.draft)}
        </section>
      )}
      {status?.layout && (
        <section>
          <h4>{t.layouts}</h4>
          <p>
            {t.source}: {status.servers[status.layout.source]} · {t.target}:{" "}
            {status.servers[status.layout.target]}
          </p>
          <button
            disabled={busy}
            onClick={() =>
              run(async (signal) => {
                const list = await api<Device[]>("devices", { signal });
                const source = list.find((d) => d.id === status.layout!.source),
                  target = list.find((d) => d.id === status.layout!.target);
                if (!source || !target) throw Error(t.error);
                setPreview(previewLayout(source, target));
              })
            }
          >
            {t.preview}
          </button>
          {preview && (
            <>
              {preview.changes.length ? (
                <>
                  <p>{t.change}</p>
                  <ul>
                    {preview.changes.map((w) => (
                      <li key={w.id}>
                        {catalog[w.kind].title} · ({w.x},{w.y}) · {w.w} × {w.h}
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => {
                      try {
                        preview.apply();
                        setNote(t.done);
                        onLayout?.(status.layout!.target);
                      } catch (e) {
                        setNote(String(e));
                      }
                      setPreview(undefined);
                    }}
                  >
                    {t.apply}
                  </button>
                </>
              ) : (
                <p>{t.nothing}</p>
              )}
            </>
          )}
        </section>
      )}
      <p role="status">{busy ? t.busy : note}</p>
    </section>
  );
}

import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
import { Cable, Network, SlidersHorizontal } from "lucide-react";
import { CopyButton } from "./CopyButton";
import { createPortal } from "react-dom";
import { ReviewedConnection } from "./ConnectionSettings";
import type { SettingsSection } from "./AssistantDrawer";
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
  host,
  link,
  opened,
  onLayout,
}: {
  csrf: string;
  host: HTMLDivElement | null;
  link?: { section: SettingsSection; request: number };
  opened: boolean;
  onLayout?: (id: string) => void;
}) {
  const t = assistantCopy(navigator.language);
  const [status, setStatus] = useState<State>();
  const [savedModel, setSavedModel] = useState({
    base: "",
    model: "",
    hasKey: false,
  });
  const [revision, setRevision] = useState("");
  const [message, setMessage] = useState(""),
    [chat, setChat] = useState<{ question: string; result: Turn }[]>([]);
  const [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [reviewing, setReviewing] = useState(false),
    [preview, setPreview] = useState<ReturnType<typeof previewLayout>>();
  const active = useRef<AbortController | null>(null);
  const lastLink = useRef(0);
  const transcript = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!host || !link || lastLink.current === link.request) return;
    const outer = host.closest("details");
    const section = host.querySelector<HTMLButtonElement>(
      `[data-section="${link.section}"]`,
    );
    if (!outer) return;
    outer.open = true;
    if (!section) {
      outer.querySelector("summary")?.focus();
      return;
    }
    lastLink.current = link.request;
    section.click();
    section.focus();
    section.scrollIntoView({ block: "center" });
  }, [host, link, status]);
  useEffect(() => {
    if (opened && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [chat, opened]);
  async function refreshStatus(signal: AbortSignal) {
    const s = await api<Status>("assistant/status", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (signal.aborted) return;
    setStatus(s.state);
    if (s.state.draft?.id !== status?.draft?.id) setReviewing(false);
    if (
      s.state.layout?.source !== status?.layout?.source ||
      s.state.layout?.target !== status?.layout?.target
    )
      setPreview(undefined);
    if (!status || s.revision !== revision) {
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
      setRevision(s.revision);
      setSavedModel({ base: s.baseUrl, model: s.model, hasKey: s.hasKey });
    }
  }
  const loadStatus = useEffectEvent(() => {
    if (!status || opened) void run(refreshStatus);
  });
  useEffect(() => {
    loadStatus();
  }, [opened]);
  useEffect(() => () => active.current?.abort(), []);
  const retryStatus = !status && note && (
    <button disabled={busy} onClick={() => void run(refreshStatus)}>
      {t.retry}
    </button>
  );
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
  const canSend = !!message.trim() && !!status && !!savedModel.model && !busy;
  return (
    <>
      {host &&
        createPortal(
          status ? (
            <AssistantSettings
              key={revision}
              provider={savedModel}
              approvedScope={status.scope}
              busy={busy}
              feedback={busy ? t.busy : note}
              setNote={setNote}
              run={run}
              post={post}
              onProvider={(provider, rev) => {
                setRevision(rev);
                setSavedModel(provider);
                setChat([]);
              }}
              onScope={(next) => {
                update(next);
                setChat([]);
              }}
            />
          ) : (
            <>
              <p role="status">{note || t.checking}</p>
              {retryStatus}
            </>
          ),
          host,
        )}
      <div
        className="assistant-transcript assistant-body"
        ref={transcript}
        role="region"
        aria-label={t.chat}
        tabIndex={0}
      >
        <p>{t.privacy}</p>
        {retryStatus}
        {status && !savedModel.model && <p>{t.setupModel}</p>}
        {savedModel.model && (
          <p>
            {t.provider}: {savedModel.model} · {savedModel.base}
          </p>
        )}
        <details>
          <summary>{t.suggest}</summary>
          {[t.find, t.pairKvm, t.status, t.tidy, t.sync].map((label, i) => (
            <button key={label} onClick={() => setMessage(t.prompts[i])}>
              {label}
            </button>
          ))}
        </details>
        <div role="log" aria-label={t.chat}>
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
        </div>
        <button
          disabled={busy || !status}
          onClick={() => void run(refreshStatus)}
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
            {reviewing && (
              <ReviewedConnection draft={status.draft} csrf={csrf} />
            )}
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
                  const source = list.find(
                      (d) => d.id === status.layout!.source,
                    ),
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
                          {catalog[w.kind].title} · ({w.x},{w.y}) · {w.w} ×{" "}
                          {w.h}
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
      </div>
      <div className="assistant-composer assistant-body">
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
              setMessage((current) =>
                current.trim() === question ? "" : current,
              );
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
        <p role="status">{busy ? t.busy : note}</p>
      </div>
    </>
  );
}

function AssistantSettings({
  provider,
  approvedScope,
  busy,
  feedback,
  setNote,
  run,
  post,
  onProvider,
  onScope,
}: {
  provider: { base: string; model: string; hasKey: boolean };
  approvedScope: string;
  busy: boolean;
  feedback: string;
  setNote: (message: string) => void;
  run: (fn: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  post: <T>(path: string, body: unknown, signal: AbortSignal) => Promise<T>;
  onProvider: (
    provider: { base: string; model: string; hasKey: boolean },
    revision: string,
  ) => void;
  onScope: (state: State) => void;
}) {
  const t = assistantCopy(navigator.language);
  const [section, setSection] = useState<SettingsSection>("provider");
  const prefix = useId();
  const tabs = ["provider", "scope", "connect"] as const;
  const icons = { provider: SlidersHorizontal, scope: Network, connect: Cable };
  const mcpConfig = JSON.stringify(
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
  );
  const [base, setBase] = useState(provider.base);
  const [model, setModel] = useState(provider.model);
  const [hasKey, setHasKey] = useState(provider.hasKey);
  const [key, setKey] = useState("");
  const [scope, setScope] = useState(approvedScope);
  const [secret, setSecret] = useState("");
  const [expiry, setExpiry] = useState("");
  return (
    <div className="assistant-body">
      <div className="assistant-tabs" role="tablist" aria-label={t.settings}>
        {tabs.map((id, index) => {
          const Icon = icons[id];
          return (
            <button
              type="button"
              role="tab"
              key={id}
              id={prefix + id}
              data-section={id}
              aria-label={t[id]}
              title={t[id]}
              aria-controls={prefix + id + "-panel"}
              aria-selected={section === id}
              tabIndex={section === id ? 0 : -1}
              onClick={() => setSection(id)}
              onKeyDown={(event) => {
                const next = {
                  ArrowLeft: (index + 2) % 3,
                  ArrowRight: (index + 1) % 3,
                  Home: 0,
                  End: 2,
                }[event.key];
                if (next === undefined) return;
                event.preventDefault();
                setSection(tabs[next]);
                document.getElementById(prefix + tabs[next])?.focus();
              }}
            >
              <Icon />
              {t.shortTabs[id]}
            </button>
          );
        })}
      </div>
      <section
        role="tabpanel"
        id={prefix + "provider-panel"}
        aria-labelledby={prefix + "provider"}
        hidden={section !== "provider"}
      >
        <h3>{t.provider}</h3>
        <div className="assistant-model-fields">
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
        </div>
        {hasKey && <p>{t.retained}</p>}
        <button
          disabled={busy || !model || !base}
          onClick={() =>
            run(async (signal) => {
              const saved = await post<{ revision: string }>(
                "provider",
                { baseUrl: base, model, key },
                signal,
              );
              onProvider(
                { base, model, hasKey: !!key || hasKey },
                saved.revision,
              );
              setKey("");
              setHasKey(!!key || hasKey);
              setNote(t.tested);
            })
          }
        >
          {t.test}
        </button>
      </section>
      <section
        role="tabpanel"
        id={prefix + "scope-panel"}
        aria-labelledby={prefix + "scope"}
        hidden={section !== "scope"}
      >
        <h3>{t.scope}</h3>
        <label>
          {t.hosts}
          <input value={scope} onChange={(e) => setScope(e.target.value)} />
        </label>
        <button
          disabled={busy || !scope}
          onClick={() =>
            run(async (signal) => {
              onScope(await post<State>("scope", { scope }, signal));
              setSecret("");
              setNote(t.scopeSaved);
            })
          }
        >
          {t.approve}
        </button>
        <p>
          {t.scopeLabel}: {approvedScope || t.noScope}
        </p>
      </section>
      <section
        role="tabpanel"
        id={prefix + "connect-panel"}
        aria-labelledby={prefix + "connect"}
        hidden={section !== "connect"}
      >
        <h3>{t.connect}</h3>
        <p>{t.pairHelp}</p>
        <div className="assistant-copy">
          <textarea
            readOnly
            aria-label="MCP JSON"
            onFocus={(e) => e.target.select()}
            value={mcpConfig}
          />
          <CopyButton label={t.copyConfig} text={mcpConfig} />
        </div>
        <div>
          <button
            disabled={busy}
            onClick={() =>
              run(async (signal) => {
                const pair = await post<{
                  token: string;
                  expires: string;
                }>("pair", {}, signal);
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
          <div className="assistant-copy">
            <input
              aria-label="Bearer token"
              readOnly
              title={expiry}
              value={secret}
              onFocus={(e) => e.target.select()}
            />
            <CopyButton label={t.copyToken} text={secret} />
          </div>
        )}
      </section>
      <p role="status">{feedback}</p>
    </div>
  );
}

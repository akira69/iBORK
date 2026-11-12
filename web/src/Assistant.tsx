import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
import {
  ArrowUp,
  Cable,
  Network,
  SlidersHorizontal,
  Square,
} from "lucide-react";
import { CopyButton } from "./CopyButton";
import { createPortal } from "react-dom";
import { ReviewedConnection } from "./ConnectionSettings";
import type { SettingsSection } from "./AssistantDrawer";
import { api } from "./api";
import { assistantCopy } from "./assistant-copy";
import { previewLayout } from "./assistant-layout";
import { catalog } from "./dashboard-layout";
import type { Device } from "./device-identity";
import { useDashboardAssistant } from "./DashboardAssistant";
import type { DashboardContext } from "./dashboard-draft";

export type Draft = { id: string; name: string; host: string; jetUrl: string };
type State = {
  dashboard?: DashboardContext;
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
  settingsRequest,
  opened,
  onLayout,
  onSettings,
}: {
  csrf: string;
  host: HTMLDivElement | null;
  settingsRequest: number;
  opened: boolean;
  onLayout?: (id: string) => void;
  onSettings: () => void;
}) {
  const dashboards = useDashboardAssistant();
  const t = assistantCopy(navigator.language);
  const [status, setStatus] = useState<State>();
  const [savedModel, setSavedModel] = useState({
    base: "",
    model: "",
    hasKey: false,
  });
  const [revision, setRevision] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelOverride, setModelOverride] = useState("");
  const [pending, setPending] = useState("");
  const [message, setMessage] = useState(""),
    [chat, setChat] = useState<{ question: string; result: Turn }[]>([]);
  const [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [reviewing, setReviewing] = useState(false),
    [preview, setPreview] = useState<ReturnType<typeof previewLayout>>();
  const active = useRef<AbortController | null>(null);
  const lastLink = useRef(0);
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!host || lastLink.current === settingsRequest) return;
    const outer = host.closest("details");
    const section = host.querySelector<HTMLButtonElement>(
      '[data-section="provider"]',
    );
    if (!outer) return;
    outer.open = true;
    if (!section) {
      outer.querySelector("summary")?.focus();
      return;
    }
    lastLink.current = settingsRequest;
    section.click();
    section.focus();
    section.scrollIntoView({ block: "center" });
  }, [host, settingsRequest, status]);
  useEffect(() => {
    if (opened && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [chat, pending, opened]);
  useEffect(() => {
    if (!savedModel.model) return;
    const controller = new AbortController();
    api<{ models: string[] }>("assistant/models", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
      .then(({ models }) => models ?? [])
      .catch((): string[] => [])
      .then((available) => {
        if (controller.signal.aborted) return;
        setModels(available);
        setModelOverride((current) =>
          available.includes(current) ? current : "",
        );
      });
    return () => controller.abort();
  }, [savedModel]);
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
      changeRevision(s.revision);
    }
    setSavedModel({ base: s.baseUrl, model: s.model, hasKey: s.hasKey });
  }
  const loadStatus = useEffectEvent(() => {
    if (!status || opened) void run(refreshStatus);
  });
  useEffect(() => {
    loadStatus();
    if (!opened) return;
    const onFocus = () => loadStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
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
    dashboards?.setBusy(true);
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
        dashboards?.setBusy(false);
      }
    }
  }
  async function post<T>(path: string, body: unknown, signal: AbortSignal) {
    if (path === "pair") await dashboards?.sync(signal);
    return api<T>("assistant/" + path, {
      method: "POST",
      headers: {
        "X-CSRF-Token": csrf,
        ...(dashboards
          ? { "X-Assistant-Instance": dashboards.store.instance }
          : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  }
  function update(state: State) {
    dashboards?.receive(state.dashboard);
    setStatus(state);
    setPreview(undefined);
    setReviewing(false);
  }
  function changeRevision(rev: string) {
    setRevision(rev);
    setModels([]);
    setModelOverride("");
  }
  const canSend = !!message.trim() && !!status && !!savedModel.model && !busy;
  const needsModel = !!status && !savedModel.model;
  const hasConversation = !!(
    chat.length ||
    pending ||
    status?.draft ||
    status?.layout ||
    status?.candidates?.length
  );
  function closeConversation() {
    void run(async (signal) => {
      update(await post<State>("reset", {}, signal));
      setChat([]);
      setMessage("");
      composer.current?.focus();
    });
  }
  function send() {
    if (!canSend) return;
    const draft = message;
    const question = draft.trim();
    void run(async (signal) => {
      setPending(question);
      setMessage("");
      composer.current?.focus();
      try {
        await dashboards?.sync(signal);
        const result = await post<Turn>(
          "chat",
          {
            message: question,
            language: navigator.language,
            revision,
            model: modelOverride || undefined,
          },
          signal,
        );
        update(result.state);
        setChat((old) => [...old.slice(-19), { question, result }]);
      } catch (error) {
        setMessage((current) => current || draft);
        throw error;
      } finally {
        setPending("");
      }
    });
  }
  return (
    <>
      {host &&
        createPortal(
          status ? (
            <AssistantSettings
              key={revision}
              provider={savedModel}
              models={models}
              approvedScope={status.scope}
              busy={busy}
              feedback={busy ? t.busy : note}
              setNote={setNote}
              run={run}
              post={post}
              onProvider={(provider, rev) => {
                setSavedModel(provider);
                changeRevision(rev);
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
        {retryStatus}
        {needsModel && (
          <div className="assistant-setup">
            <h3>{t.noModel}</h3>
            <p>{t.setupModel}</p>
            <button className="primary" onClick={onSettings}>
              {t.setupAction}
            </button>
          </div>
        )}
        {status &&
          !needsModel &&
          !chat.length &&
          !pending &&
          !status.draft &&
          !status.layout &&
          !status.candidates?.length && (
            <div
              className="assistant-prompts"
              role="group"
              aria-label={t.suggest}
            >
              <h3>{t.promptHeading}</h3>
              {dashboards && (
                <>
                  <button
                    onClick={() => {
                      setMessage(
                        "Use dashboard_context to arrange the current dashboard neatly. Preserve my existing widgets and show a preview.",
                      );
                      composer.current?.focus();
                    }}
                  >
                    Arrange this dashboard
                  </button>
                  <button
                    onClick={() => {
                      setMessage(
                        "Add CPU temperatures, measured power and highest current fan RPM for each server on this dashboard. Use actual available sensors and show a preview.",
                      );
                      composer.current?.focus();
                    }}
                  >
                    Add server readings
                  </button>
                </>
              )}
              {[t.find, t.pairKvm, t.status, t.tidy, t.sync].map((label, i) => (
                <button
                  key={label}
                  onClick={() => {
                    setMessage(t.prompts[i]);
                    composer.current?.focus();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        <div role="log" aria-label={t.chat}>
          {(pending
            ? [...chat, { question: pending, result: null }]
            : chat
          ).map(({ question, result }, i) => (
            <div className="assistant-turn" key={i}>
              <p className="assistant-question">{question}</p>
              {result?.activity?.map((a, j) => (
                <code key={j}>
                  {a.name}
                  {a.failed ? " ×" : " ✓"}
                </code>
              ))}
              {result ? (
                <p>{result.reply || result.error}</p>
              ) : (
                <p className="assistant-working">{t.busy}</p>
              )}
            </div>
          ))}
        </div>
        {status?.dashboard?.draft && (
          <p role="status">
            {status.dashboard.summary || "Dashboard draft updated."}{" "}
            <button onClick={() => dashboards?.viewDraft()}>View draft</button>
          </p>
        )}
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
      <div className="assistant-composer">
        {hasConversation && (
          <button
            className="assistant-close-conversation"
            type="button"
            disabled={busy}
            onClick={closeConversation}
          >
            {t.closeConversation}
          </button>
        )}
        <p role="status">{!status && busy ? t.checking : note}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            ref={composer}
            aria-label={t.question}
            placeholder={t.placeholder}
            disabled={needsModel}
            rows={2}
            maxLength={2000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="assistant-toolbar">
            <select
              aria-label={t.chatModel}
              disabled={!savedModel.model || busy}
              value={modelOverride || savedModel.model}
              onChange={(e) =>
                setModelOverride(
                  e.target.value === savedModel.model ? "" : e.target.value,
                )
              }
            >
              <option value={savedModel.model}>
                {savedModel.model || t.noModel}
              </option>
              {models
                .filter((id) => id !== savedModel.model)
                .map((id) => (
                  <option key={id}>{id}</option>
                ))}
            </select>
            {pending ? (
              <button
                type="button"
                aria-label={t.stop}
                title={t.stop}
                onClick={(event) => {
                  event.preventDefault();
                  active.current?.abort();
                  setNote(t.stopped);
                }}
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                aria-label={t.send}
                title={t.send}
                disabled={!canSend}
              >
                <ArrowUp size={19} />
              </button>
            )}
          </div>
        </form>
      </div>
    </>
  );
}

function AssistantSettings({
  provider,
  models,
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
  models: string[];
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
            <input
              list={base === provider.base ? prefix + "models" : undefined}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
            <datalist id={prefix + "models"}>
              {models.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
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

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { api } from "./api";
import {
  DashboardDraftStore,
  type DashboardContext,
  type DashboardSurface,
} from "./dashboard-draft";
import type { Device } from "./device-identity";
import "./Assistant.css";

type Controller = {
  store: DashboardDraftStore;
  devices: Device[];
  open: boolean;
  busy: boolean;
  notice: string;
  setOpen: (open: boolean) => void;
  setBusy: (busy: boolean) => void;
  sync: (signal: AbortSignal) => Promise<void>;
  receive: (context?: DashboardContext) => void;
  viewDraft: () => void;
};
const Context = createContext<Controller | null>(null);
export const DashboardScope = createContext<{
  deviceId?: string;
  title?: string;
  active?: boolean;
}>({});
export const useDashboardAssistant = () => useContext(Context);
const noopSubscribe = () => () => {};
const emptySnapshot = () => 0;
let tabInstance: Promise<string> | undefined;
function instanceForTab() {
  return (tabInstance ??= new Promise<string>((resolve) => {
    const key = "ibork:assistant-tab:v1";
    let candidate = crypto.randomUUID() as string;
    try {
      candidate = sessionStorage.getItem(key) || candidate;
    } catch {
      /* Storage may be disabled. */
    }
    if (!navigator.locks) return resolve(crypto.randomUUID());
    const claim = async (instance: string): Promise<void> => {
      await navigator.locks.request(
        `ibork-assistant:${instance}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) return claim(crypto.randomUUID());
          try {
            sessionStorage.setItem(key, instance);
          } catch {
            /* Optional persistence. */
          }
          resolve(instance);
          // The document owns this identity until unload; copied tabs must claim another.
          await new Promise<void>(() => {});
        },
      );
    };
    void claim(candidate).catch(() => resolve(crypto.randomUUID()));
  }));
}

export function useDashboardSurface(surface: DashboardSurface, active = true) {
  const controller = useDashboardAssistant();
  const store = controller?.store;
  useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.snapshot ?? emptySnapshot,
  );
  const signature = JSON.stringify(surface);
  const latest = useRef(surface);
  useEffect(() => {
    latest.current = surface;
  });
  useEffect(() => {
    if (active) store?.register(latest.current);
  }, [store, active, signature]);
  useEffect(
    () => () => {
      store?.unregister(surface.target);
    },
    [store, surface.target, active],
  );
  return { controller, draft: store?.draft(surface.target) };
}

type WorkspaceProps = {
  csrf: string;
  devices: Device[];
  children: ReactNode;
};
export function DashboardAssistant(props: WorkspaceProps) {
  const [store, setStore] = useState<DashboardDraftStore>();
  useEffect(() => {
    let active = true;
    void instanceForTab().then((instance) => {
      if (active) setStore(new DashboardDraftStore(instance));
    });
    return () => {
      active = false;
    };
  }, []);
  return store ? (
    <DashboardWorkspace {...props} store={store} />
  ) : (
    <p>Loading dashboard…</p>
  );
}
function DashboardWorkspace({
  csrf,
  devices,
  children,
  store,
}: WorkspaceProps & { store: DashboardDraftStore }) {
  const version = useSyncExternalStore(store.subscribe, store.snapshot);
  const [syncVersion, setSyncVersion] = useState(0);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const remote = useRef<DashboardContext | undefined>(undefined);
  const publishing = useRef<Promise<void> | null>(null);
  const receive = (context?: DashboardContext) => {
    if (!context) {
      if (remote.current) {
        remote.current = undefined;
        setSyncVersion((v) => v + 1);
      }
      return;
    }
    if (context.instance !== store.instance) return;
    if (remote.current?.revision === context.revision) return;
    try {
      store.receive(
        context,
        remote.current?.target === context.target
          ? remote.current.revision
          : undefined,
      );
    } finally {
      // Rejected proposals still advance the server revision needed to publish local edits.
      remote.current = context;
    }
  };
  async function sync(signal: AbortSignal) {
    if (publishing.current) {
      try {
        await publishing.current;
      } catch (error) {
        // Starting a turn cancels background sync, not this caller's publication.
        if (
          signal.aborted ||
          !(error instanceof DOMException && error.name === "AbortError")
        )
          throw error;
      }
    }
    signal.throwIfAborted();
    const pending = (async () => {
      const status = await api<{ state: { dashboard?: DashboardContext } }>(
        "assistant/status",
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) },
      );
      const current = status.state.dashboard;
      if (remote.current && current?.instance === store.instance)
        receive(current);
      remote.current =
        current?.instance === store.instance ? current : undefined;
      const context = store.context();
      if (
        !context ||
        (remote.current?.revision === context.revision &&
          remote.current.target === context.target)
      )
        return;
      const result = await api<DashboardContext>("assistant/dashboard", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
        body: JSON.stringify({
          ...context,
          expectedRevision: remote.current?.revision,
        }),
      });
      remote.current = result;
      setNotice("");
    })();
    publishing.current = pending;
    try {
      await pending;
    } finally {
      if (publishing.current === pending) publishing.current = null;
    }
  }
  const latest = useRef({ sync, receive });
  useEffect(() => {
    latest.current = { sync, receive };
  });
  useEffect(() => {
    if (!open || busy) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void latest.current.sync(controller.signal).catch((e) => {
        if (!controller.signal.aborted) setNotice(String(e));
      });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, busy, version, syncVersion]);
  useEffect(() => {
    if (!open || busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (!publishing.current) {
          const result = await api<{ state: { dashboard?: DashboardContext } }>(
            "assistant/status",
            {
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(10000),
              ]),
            },
          );
          latest.current.receive(result.state.dashboard);
        }
      } catch (e) {
        if (!controller.signal.aborted) setNotice(String(e));
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 2000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, busy]);
  function viewDraft() {
    setOpen(false);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(".dashboard-preview")?.focus(),
    );
  }
  return (
    <Context.Provider
      value={{
        store,
        devices,
        open,
        busy,
        setOpen,
        notice,
        setBusy,
        sync,
        receive,
        viewDraft,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function DashboardPreview({ target }: { target: string }) {
  const controller = useDashboardAssistant();
  const [error, setError] = useState("");
  const draft = controller?.store.draft(target);
  if (!controller || !draft) return null;
  const { store, busy } = controller;
  return (
    <section
      className="dashboard-preview"
      tabIndex={-1}
      aria-label="Dashboard preview"
    >
      <strong>{busy ? "Updating preview…" : "Preview · Not saved"}</strong>
      <span>
        <button
          aria-pressed={draft.showCurrent}
          onClick={() => store.compare(target, true)}
        >
          Current
        </button>
        <button
          aria-pressed={!draft.showCurrent}
          onClick={() => store.compare(target, false)}
        >
          Draft
        </button>
      </span>
      <button onClick={() => controller.setOpen(true)}>Continue in chat</button>
      <button
        disabled={busy}
        onClick={() => {
          store.discard(target);
          setError("");
        }}
      >
        Discard
      </button>
      <button
        className="primary"
        disabled={busy}
        onClick={() => {
          try {
            store.apply(target);
            setError("");
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        Apply dashboard
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ConsoleSessionStore, type ConsoleKey } from "./console-session";
import { type Device, sourcesFor } from "./device-identity";
export { sourcesFor } from "./device-identity";
import { JetKVMProvider, type KVMState } from "./kvm";
import { JetKVMWidget } from "./JetKVMWidget";
import { VNCConsole } from "./VNCConsole";
import { CometProvider } from "./comet";
import { usePoll } from "./usePoll";
import { readNavigation } from "./navigation";

type Sessions = {
  view: "server" | "wall";
  setView: (view: "server" | "wall") => void;
  store: ConsoleSessionStore;
  jets: Map<ConsoleKey, JetKVMProvider>;
  attach: (
    key: ConsoleKey,
    target: HTMLElement,
    interactive: boolean,
  ) => () => void;
};
const Context = createContext<Sessions | null>(null);
export function useConsoleSessions() {
  const value = useContext(Context);
  if (!value) throw Error("Console session owner missing");
  return value;
}
export function useConsoleSnapshot(key: ConsoleKey) {
  const { store } = useConsoleSessions();
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot(key));
}
export function ConsoleSessions({
  devices,
  csrf,
  children,
}: {
  devices: Device[];
  csrf: string;
  children: ReactNode;
}) {
  const dock = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(() => readNavigation(devices).view);
  const [store] = useState(() => new ConsoleSessionStore());
  const [jets] = useState(() => new Map<ConsoleKey, JetKVMProvider>());
  const [surfaces] = useState(() =>
    devices.flatMap((device) =>
      sourcesFor(device).map((source) => {
        const key: ConsoleKey = `${device.id}:${source}`,
          node = document.createElement("div");
        node.className = "console-surface";
        node.dataset.consoleKey = key;
        return { key, node, device, source };
      }),
    ),
  );
  const attach = useCallback(
    (key: ConsoleKey, target: HTMLElement, interactive: boolean) => {
      const surface = surfaces.find((item) => item.key === key);
      if (!surface) return () => {};
      surface.node.inert = !interactive;
      if (!interactive && store.isControlling(key)) store.setControl(null);
      target.appendChild(surface.node);
      return () => {
        if (surface.node.parentElement === target) {
          if (store.isControlling(key)) store.setControl(null);
          dock.current?.appendChild(surface.node);
        }
      };
    },
    [store, surfaces],
  );
  const value = { store, jets, attach, view, setView };
  useEffect(() => {
    for (const surface of surfaces)
      if (!surface.node.parentElement) dock.current?.appendChild(surface.node);
    const release = () => store.setControl(null);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      store.close();
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, [store, surfaces]);
  return (
    <Context.Provider value={value}>
      {children}
      <div hidden ref={dock} />
      {surfaces.map(({ key, node, device, source }) =>
        createPortal(
          source === "jetkvm" ? (
            <JetSurface device={device} sessionKey={key} />
          ) : source === "vnc" ? (
            <VNCConsole
              apiPrefix={`devices/${device.id}/`}
              csrf={csrf}
              session={{ store, key }}
            />
          ) : (
            <CometSurface device={device} sessionKey={key} />
          ),
          node,
          key,
        ),
      )}
    </Context.Provider>
  );
}
function CometSurface({
  device,
  sessionKey,
}: {
  device: Device;
  sessionKey: ConsoleKey;
}) {
  const { store } = useConsoleSessions();
  const snapshot = useConsoleSnapshot(sessionKey);
  const controlling = useSyncExternalStore(store.subscribe, () =>
    store.isControlling(sessionKey),
  );
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [notice, setNotice] = useState("");
  const [provider, setProvider] = useState<CometProvider | null>(null);
  const config = usePoll<{ glUrl: string }>(`devices/${device.id}/config`, 0);
  useEffect(() => {
    const comet = new CometProvider(
      {
        stream: setStream,
        phase: (phase) => store.report(sessionKey, { phase }),
        failure: (reason) =>
          store.report(
            sessionKey,
            {
              phase: reason === "busy" ? "busy" : "failed",
              error:
                reason === "certificate"
                  ? "Comet certificate does not match. Check its SHA-256 fingerprint in Connections."
                  : reason === "auth"
                    ? "Comet login refused. Check its credentials in Connections."
                    : reason === "busy"
                      ? "Comet already has an active console session."
                      : "Comet video connection failed. Check the device and reconnect.",
            },
            reason,
          ),
      },
      `devices/${device.id}/`,
    );
    setProvider(comet);
    return store.register(sessionKey, comet);
  }, [store, sessionKey, device.id]);
  return (
    <>
      <JetKVMWidget
        provider={provider}
        providerName="GL.iNet Comet"
        stream={stream}
        state={
          snapshot.phase === "live"
            ? "connected"
            : snapshot.phase === "busy"
              ? "failed"
              : snapshot.phase
        }
        endpoint={config.data?.glUrl ?? "GL.iNet Comet"}
        inputEnabled={controlling}
        onFeedback={setNotice}
        onConnect={() => store.connect(sessionKey)}
        onDisconnect={() => store.disconnect(sessionKey)}
        onControl={() => store.setControl(sessionKey)}
        onRelease={() => {
          if (store.isControlling(sessionKey)) store.setControl(null);
        }}
      />
      {(notice || snapshot.error) && (
        <p role="alert">{notice || snapshot.error}</p>
      )}
    </>
  );
}
export function ConsoleSlot({
  sessionKey,
  visible = true,
  interactive = true,
}: {
  sessionKey: ConsoleKey;
  visible?: boolean;
  interactive?: boolean;
}) {
  const { attach } = useConsoleSessions(),
    host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (visible && host.current)
      return attach(sessionKey, host.current, interactive);
  }, [attach, sessionKey, visible, interactive]);
  return <div className="console-slot" ref={host} />;
}
function JetSurface({
  device,
  sessionKey,
}: {
  device: Device;
  sessionKey: ConsoleKey;
}) {
  const { store, jets } = useConsoleSessions(),
    snapshot = useConsoleSnapshot(sessionKey);
  const [provider, setProvider] = useState<JetKVMProvider | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null),
    [notice, setNotice] = useState("");
  const controlling = useSyncExternalStore(store.subscribe, () =>
    store.isControlling(sessionKey),
  );
  const config = usePoll<{ jetUrl: string }>(`devices/${device.id}/config`, 0);
  useEffect(() => {
    let ready: (() => void) | undefined;
    const jet = new JetKVMProvider(
      {
        stream: setStream,
        state: (state) => {
          if (state === "connected" || state === "no-signal") {
            store.report(sessionKey, {
              phase: state === "connected" ? "live" : "no-signal",
            });
            ready?.();
          } else if (state === "connecting")
            store.report(sessionKey, { phase: "connecting" });
        },
        failure: (reason) =>
          store.report(
            sessionKey,
            {
              phase:
                reason === "superseded"
                  ? "superseded"
                  : reason === "busy"
                    ? "busy"
                    : "failed",
              error:
                reason === "transient"
                  ? "JetKVM connection failed."
                  : "JetKVM connection refused; check authentication or existing sessions.",
            },
            reason,
          ),
      },
      `devices/${device.id}/`,
    );
    jets.set(sessionKey, jet);
    setProvider(jet);
    const unregister = store.register(sessionKey, {
      connect: (signal) =>
        new Promise<void>((resolve, reject) => {
          ready = resolve;
          signal.addEventListener(
            "abort",
            () => {
              ready = undefined;
              jet.disconnect();
              reject(new Error("Connection cancelled"));
            },
            { once: true },
          );
          if (signal.aborted) {
            reject(new Error("Connection cancelled"));
            return;
          }
          jet.connect();
        }),
      disconnect: () => {
        ready = undefined;
        jet.disconnect();
      },
      release: () => jet.release(),
      setInputEnabled: (enabled) => jet.setInputEnabled(enabled),
    });
    return () => {
      unregister();
      jets.delete(sessionKey);
    };
  }, [store, jets, sessionKey, device.id]);
  const state: KVMState =
    snapshot.phase === "live"
      ? "connected"
      : snapshot.phase === "busy"
        ? "failed"
        : snapshot.phase;
  return (
    <>
      <JetKVMWidget
        provider={provider}
        state={state}
        stream={stream}
        endpoint={config.data?.jetUrl ?? "JetKVM"}
        inputEnabled={controlling}
        onFeedback={setNotice}
        onConnect={() => store.connect(sessionKey)}
        onDisconnect={() => store.disconnect(sessionKey)}
        onControl={() => store.setControl(sessionKey)}
        onRelease={() => {
          if (store.isControlling(sessionKey)) store.setControl(null);
        }}
      />
      {(notice || snapshot.error) && (
        <p role="alert">{notice || snapshot.error}</p>
      )}
    </>
  );
}

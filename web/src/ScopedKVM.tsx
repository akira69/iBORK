import {
  ConsoleSlot,
  useConsoleSessions,
  useConsoleSnapshot,
} from "./ConsoleSessions";
import { sourcesFor, type ConsoleSource, type Device } from "./device-identity";

export function ScopedKVM({
  device,
  kind,
  editing = false,
}: {
  device?: Device;
  kind: ConsoleSource;
  editing?: boolean;
}) {
  if (!device || !sourcesFor(device).includes(kind))
    return (
      <p className="empty-data">
        Console unavailable. Check the server and its configured connections.
      </p>
    );
  if (editing)
    return (
      <p className="empty-data">Console controls are disabled while editing.</p>
    );
  return <ConnectedConsole device={device} kind={kind} />;
}

function ConnectedConsole({
  device,
  kind,
}: {
  device: Device;
  kind: ConsoleSource;
}) {
  const key = `${device.id}:${kind}` as const;
  const { store } = useConsoleSessions();
  const snapshot = useConsoleSnapshot(key);
  return (
    <div className="scoped-console">
      <div className="scoped-console-actions">
        <span role="status">{snapshot.phase}</span>
        <button
          disabled={[
            "live",
            "no-signal",
            "connecting",
            "reconnecting",
          ].includes(snapshot.phase)}
          onClick={() => store.connect(key)}
        >
          Connect
        </button>
        <button
          disabled={snapshot.phase === "disconnected"}
          onClick={() => store.disconnect(key)}
        >
          Disconnect
        </button>
      </div>
      <ConsoleSlot sessionKey={key} />
    </div>
  );
}

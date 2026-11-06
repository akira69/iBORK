import { useEffect, useId, useState } from "react";
import { api } from "./api";
import { usePoll } from "./usePoll";
import { Info, Server, Plus } from "lucide-react";

import { TelemetryFields, type Telemetry } from "./TelemetryFields";
import brain from "./assets/assistant-brain.png";
import { assistantCopy } from "./assistant-copy";
import type { Draft } from "./Assistant";
type Connection = {
  telemetry?: Telemetry;
  hasGlancesToken?: boolean;
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  jetUrl: string;
  kgKeyLocation?: string;
  vncHost?: string;
  vncPort?: number;
  vncKind?: string;
  vncTransport?: string;
  vncCertificateSHA256?: string;
  glUrl?: string;
  glUsername?: string;
  glCertificateSHA256?: string;
};
const blank: Connection = {
  id: "",
  name: "",
  host: "",
  port: 623,
  username: "ADMIN",
  jetUrl: "",
};

export function ConnectionSettings({
  deviceId,
  csrf,
  openAssistant,
}: {
  deviceId?: string;
  openAssistant?: () => void;
  csrf: string;
}) {
  const t = assistantCopy(navigator.language);
  const [revision, refresh] = useState(0);
  const profiles = usePoll<Connection[]>("device-settings", 0, true, revision);
  const profile = profiles.data?.find((p) => p.id === deviceId);
  return (
    <section className="panel data-panel connection-settings">
      <h2 className="settings-card-title">
        <Server size={20} />
        {deviceId ? "Server connection" : "Add server"}
      </h2>
      <p className="small-note">
        Add an IPMI server, a standalone KVM, or a server monitored through
        Glances or a power meter. Connection settings are stored on the app
        server.
      </p>
      {openAssistant && (
        <button onClick={openAssistant} aria-haspopup="dialog">
          <img src={brain} alt="" width="30" height="25" /> {t.title}
        </button>
      )}
      {profiles.error ? (
        <p role="alert">
          {profiles.error}{" "}
          <button onClick={() => refresh((v) => v + 1)}>
            Retry server settings
          </button>
        </p>
      ) : !profiles.data ? (
        <p>Loading connections…</p>
      ) : deviceId && !profile ? (
        <p role="alert">Selected server connection is unavailable.</p>
      ) : !deviceId && profiles.data.length >= 16 ? (
        <p role="status">Maximum of 16 servers reached.</p>
      ) : (
        <ConnectionForm
          key={deviceId ?? "new"}
          initial={profile ?? blank}
          csrf={csrf}
        />
      )}
    </section>
  );
}

export function ReviewedConnection({
  draft,
  csrf,
}: {
  draft: Draft;
  csrf: string;
}) {
  return (
    <ConnectionForm
      key={JSON.stringify(draft)}
      initial={{
        ...blank,
        name: draft.name,
        host: draft.host,
        jetUrl: draft.jetUrl,
      }}
      csrf={csrf}
      assisted={draft.id}
    />
  );
}

function ConnectionForm({
  assisted = "",
  initial,
  csrf,
}: {
  assisted?: string;
  initial: Connection;
  csrf: string;
}) {
  const [draft, setDraft] = useState(initial);
  const certificateId = useId();
  const [deviceType, setDeviceType] = useState(
    (!initial.id && !assisted) || initial.host
      ? "managed"
      : initial.jetUrl || initial.glUrl || initial.vncPort
        ? "standalone"
        : "telemetry",
  );
  const managed = deviceType === "managed";
  const standalone = deviceType === "standalone";
  const [telemetry, setTelemetry] = useState<Telemetry>(
    initial.telemetry ?? {},
  );
  const [meterSecret, setMeterSecret] = useState("");
  const [glancesToken, setGlancesToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [source, setSource] = useState(
    initial.vncPort
      ? initial.vncKind || "dell"
      : initial.glUrl
        ? "glinet"
        : "jetkvm",
  );
  const [vncEnabled, setVNCEnabled] = useState(!!initial.vncPort);
  const [glEnabled, setGLEnabled] = useState(!!initial.glUrl);
  const [vncPassword, setVNCPassword] = useState("");
  const [glPassword, setGLPassword] = useState("");
  const [removing, setRemoving] = useState(false);
  const [paired, setPaired] = useState(!!initial.jetUrl);
  const [password, setPassword] = useState("");
  const [jetPassword, setJetPassword] = useState("");
  const [kgKey, setKGKey] = useState("");
  const [removeKGKey, setRemoveKGKey] = useState(false);
  const [importing, setImporting] = useState(false);
  const [passwordless, setPasswordless] = useState(false);
  const [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [error, setError] = useState("");
  const useJet = managed ? paired : standalone && source === "jetkvm";
  const useVNC = managed
    ? vncEnabled
    : standalone && (source === "dell" || source === "generic");
  const useGL = managed ? glEnabled : standalone && source === "glinet";
  const vncKind = managed ? draft.vncKind || "dell" : source;
  const transport = vncKind === "dell" ? "tls" : draft.vncTransport || "tls";
  useEffect(() => {
    if (!saved) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 20000;
    async function reconnect() {
      try {
        const response = await fetch("/api/session", {
          signal: AbortSignal.timeout(1500),
        });
        if (!stopped && (response.ok || response.status === 401)) {
          window.location.reload();
          return;
        }
      } catch {
        /* The app briefly closes its listener during reload. */
      }
      if (stopped) return;
      if (Date.now() < deadline)
        timer = setTimeout(() => void reconnect(), 500);
      else
        setError(
          "Settings saved. Reload the page to reconnect; if unavailable, check the app service.",
        );
    }
    timer = setTimeout(() => void reconnect(), 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [saved]);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api(assisted ? "assistant/apply" : "device-settings", {
            method: "POST",
            headers: {
              "X-CSRF-Token": csrf,
              ...(assisted ? { "X-Assistant-Draft": assisted } : {}),
            },
            body: JSON.stringify({
              id: draft.id,
              telemetry,
              ...(telemetry.meterKind === "mqtt" && !telemetry.meterUser
                ? { meterSecret: "" }
                : meterSecret && telemetry.meterKind
                  ? { meterSecret }
                  : {}),
              ...(telemetry.glancesUrl && (glancesToken || clearToken)
                ? { glancesToken: clearToken ? "" : glancesToken }
                : {}),
              name: draft.name,
              host: managed ? draft.host : "",
              port: managed ? draft.port : 0,
              username: managed ? draft.username : "",
              jetUrl: useJet ? draft.jetUrl : "",
              vncHost: useVNC ? draft.vncHost || "" : "",
              vncPort: useVNC ? draft.vncPort || 5900 : 0,
              vncKind: useVNC ? vncKind : "",
              vncTransport: useVNC ? transport : "",
              vncCertificateSHA256:
                useVNC && transport === "tls"
                  ? draft.vncCertificateSHA256 || ""
                  : "",
              ...(useVNC && vncPassword ? { vncPassword } : {}),
              glUrl: useGL ? draft.glUrl || "" : "",
              glUsername: useGL ? draft.glUsername || "admin" : "",
              glCertificateSHA256:
                useGL && draft.glUrl?.startsWith("https:")
                  ? draft.glCertificateSHA256 || ""
                  : "",
              ...(useGL && glPassword ? { glPassword } : {}),
              ...(managed && removeKGKey
                ? { kgKey: "" }
                : managed && kgKey
                  ? { kgKey }
                  : {}),
              ...(managed && password ? { password } : {}),
              ...(useJet && (jetPassword || passwordless)
                ? { jetPassword: passwordless ? "" : jetPassword }
                : {}),
            }),
          });
          setMeterSecret("");
          setGlancesToken("");
          setPassword("");
          setJetPassword("");
          setVNCPassword("");
          setGLPassword("");
          setKGKey("");
          setSaved(true);
        } catch (error) {
          setError(
            error instanceof Error ? error.message : "Could not save server",
          );
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy || importing} className="connection-fields">
        <legend>{initial.id ? "Edit connection" : "New connection"}</legend>
        <label>
          Device type
          <select
            value={deviceType}
            disabled={!!initial.id}
            onChange={(e) => setDeviceType(e.target.value)}
          >
            <option value="managed">IPMI server</option>
            <option value="standalone">Standalone KVM</option>
            <option value="telemetry">Telemetry server</option>
          </select>
        </label>
        {standalone && (
          <label>
            Console provider
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="jetkvm">JetKVM</option>
              <option value="dell">Dell iDRAC VNC</option>
              <option value="generic">Generic VNC</option>
              <option value="glinet">GL.iNet Comet Pro</option>
            </select>
          </label>
        )}
        <label>
          Server name
          <input
            required
            maxLength={100}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        {managed && (
          <>
            <label>
              BMC address
              <input
                required
                placeholder="192.0.2.50"
                maxLength={253}
                value={draft.host}
                onChange={(e) =>
                  setDraft({ ...draft, host: e.target.value.trim() })
                }
              />
            </label>
            <label>
              BMC port
              <input
                required
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(e) =>
                  setDraft({ ...draft, port: e.target.valueAsNumber })
                }
              />
            </label>
            <label>
              BMC username
              <input
                required
                maxLength={16}
                autoComplete="off"
                value={draft.username}
                onChange={(e) =>
                  setDraft({ ...draft, username: e.target.value })
                }
              />
            </label>
            <label>
              BMC password
              <input
                type="password"
                autoComplete="new-password"
                required={!initial.id}
                maxLength={64}
                placeholder={
                  initial.id ? "Leave blank to keep existing" : "Required"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <details className="connection-key" open={!!initial.kgKeyLocation}>
              <summary>
                IPMI encryption key (KG) ·{" "}
                {initial.kgKeyLocation ? "Configured" : "Optional"}
              </summary>
              <p className="small-note">
                Only needed when your BMC uses a custom KG key. This is separate
                from its password. Enter the existing key; saving here does not
                change the BMC.
              </p>
              <label>
                IPMI KG key
                <input
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  maxLength={40}
                  pattern="[0-9a-fA-F]{40}"
                  disabled={removeKGKey}
                  placeholder={
                    initial.kgKeyLocation
                      ? "Leave blank to keep existing"
                      : "40 hexadecimal characters"
                  }
                  value={kgKey}
                  onChange={(e) => setKGKey(e.target.value)}
                />
              </label>
              <label>
                Import KG key file
                <input
                  type="file"
                  accept=".txt,text/plain"
                  disabled={removeKGKey}
                  onChange={async (e) => {
                    const file = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    if (!file) return;
                    setImporting(true);
                    setError("");
                    setKGKey("");
                    try {
                      if (file.size > 128)
                        throw Error(
                          "Key file must contain only 40 hexadecimal characters.",
                        );
                      const key = (await file.text()).trim();
                      if (!/^[0-9a-fA-F]{40}$/.test(key))
                        throw Error(
                          "Key file must contain only 40 hexadecimal characters.",
                        );
                      setKGKey(key);
                    } catch {
                      setError(
                        "Could not import key file. Use a text file containing only 40 hexadecimal characters.",
                      );
                    } finally {
                      setImporting(false);
                    }
                  }}
                />
              </label>
              {initial.kgKeyLocation && (
                <label className="connection-toggle">
                  <input
                    type="checkbox"
                    checked={removeKGKey}
                    onChange={(e) => {
                      setRemoveKGKey(e.target.checked);
                      setKGKey("");
                    }}
                  />
                  Remove saved KG key
                </label>
              )}
              <p className="small-note">
                Storage on the app server:{" "}
                {initial.kgKeyLocation ? (
                  <code>{initial.kgKeyLocation}</code>
                ) : (
                  "a protected file created when you save"
                )}
                . Saved keys are never returned by the app or kept in dashboard
                browser storage.
              </p>
            </details>
          </>
        )}
        {managed && (
          <label className="connection-toggle">
            <input
              type="checkbox"
              checked={paired}
              onChange={(e) => setPaired(e.target.checked)}
            />
            Pair a JetKVM with this server
          </label>
        )}
        {useJet && (
          <>
            <label>
              JetKVM address
              <input
                required
                type="url"
                placeholder="http://192.0.2.51"
                value={draft.jetUrl}
                onChange={(e) =>
                  setDraft({ ...draft, jetUrl: e.target.value.trim() })
                }
              />
            </label>
            <label>
              JetKVM password
              <input
                type="password"
                autoComplete="new-password"
                disabled={passwordless}
                required={!initial.jetUrl && !passwordless}
                maxLength={1024}
                placeholder={
                  initial.jetUrl
                    ? "Leave blank to keep existing"
                    : "Device password"
                }
                value={jetPassword}
                onChange={(e) => setJetPassword(e.target.value)}
              />
            </label>
            <label className="connection-toggle">
              <input
                type="checkbox"
                checked={passwordless}
                onChange={(e) => setPasswordless(e.target.checked)}
              />
              This JetKVM is configured without a password
            </label>
          </>
        )}
        {managed && (
          <label className="connection-toggle">
            <input
              type="checkbox"
              checked={vncEnabled}
              onChange={(e) => setVNCEnabled(e.target.checked)}
            />
            Pair VNC with this server
          </label>
        )}
        {useVNC && (
          <>
            {managed && (
              <label>
                VNC provider
                <select
                  value={vncKind}
                  onChange={(e) =>
                    setDraft({ ...draft, vncKind: e.target.value })
                  }
                >
                  <option value="dell">Dell iDRAC VNC</option>
                  <option value="generic">Generic VNC</option>
                </select>
              </label>
            )}
            <label>
              VNC host
              <input
                required
                maxLength={253}
                value={draft.vncHost || ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    vncHost: e.target.value.trim(),
                    vncCertificateSHA256: "",
                  })
                }
              />
            </label>
            <label>
              VNC port
              <input
                required
                type="number"
                min={1}
                max={65535}
                value={draft.vncPort || 5900}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    vncPort: e.target.valueAsNumber,
                    vncCertificateSHA256: "",
                  })
                }
              />
            </label>
            {vncKind === "generic" && (
              <label>
                VNC transport
                <select
                  value={transport}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      vncTransport: e.target.value,
                      vncCertificateSHA256: "",
                    })
                  }
                >
                  <option value="tls">Pinned TLS</option>
                  <option value="tcp">Plaintext TCP</option>
                </select>
              </label>
            )}
            {transport === "tls" ? (
              <label>
                VNC certificate SHA256
                <input
                  required
                  maxLength={64}
                  pattern="[a-fA-F0-9]{64}"
                  value={draft.vncCertificateSHA256 || ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      vncCertificateSHA256: e.target.value.trim(),
                    })
                  }
                />
              </label>
            ) : (
              <p className="small-note">
                Plaintext TCP exposes console traffic. Use only on a trusted LAN
                or VPN; TLS is never downgraded automatically.
              </p>
            )}
            <label>
              VNC password
              <input
                type="password"
                autoComplete="new-password"
                required={!initial.vncPort}
                maxLength={8}
                minLength={vncKind === "dell" ? 8 : 1}
                value={vncPassword}
                placeholder={
                  initial.vncPort
                    ? "Leave blank to keep existing"
                    : "Device VNC password"
                }
                onChange={(e) => setVNCPassword(e.target.value)}
              />
            </label>
          </>
        )}
        {managed && (
          <label className="connection-toggle">
            <input
              type="checkbox"
              checked={glEnabled}
              onChange={(e) => setGLEnabled(e.target.checked)}
            />
            Pair GL.iNet Comet Pro with this server
          </label>
        )}
        {useGL && (
          <>
            <p className="small-note">
              Live video and keyboard control use the pinned connection. HDMI
              must be active for video.
            </p>
            <label>
              Comet address
              <input
                required
                type="url"
                value={draft.glUrl || ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    glUrl: e.target.value.trim(),
                    glCertificateSHA256: "",
                  })
                }
              />
            </label>
            <label>
              Comet username
              <input
                required
                maxLength={100}
                value={draft.glUsername || "admin"}
                onChange={(e) =>
                  setDraft({ ...draft, glUsername: e.target.value })
                }
              />
            </label>
            {draft.glUrl?.startsWith("https:") && (
              <div className="certificate-field">
                <div className="certificate-label">
                  <label htmlFor={certificateId}>
                    Comet certificate SHA256
                  </label>
                  <button
                    type="button"
                    className="certificate-help quiet"
                    popoverTarget={`${certificateId}-help`}
                    aria-label="How to find the Comet certificate fingerprint"
                  >
                    <Info size={16} aria-hidden="true" />
                  </button>
                  <p
                    id={`${certificateId}-help`}
                    popover="auto"
                    className="certificate-tooltip"
                    role="tooltip"
                  >
                    Open the Comet’s HTTPS address on your trusted management
                    network. In Chrome, press F12 → Security (or Privacy and
                    security) → View certificate. Copy SHA-256 Fingerprints →
                    Certificate, not Public Key. Remove spaces and colons: enter
                    64 hexadecimal characters. The pre-installed certificate
                    works too. Update this value if the certificate changes.
                  </p>
                </div>
                <input
                  id={certificateId}
                  aria-describedby={`${certificateId}-help`}
                  required
                  maxLength={64}
                  pattern="[a-fA-F0-9]{64}"
                  value={draft.glCertificateSHA256 || ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      glCertificateSHA256: e.target.value.trim(),
                    })
                  }
                />
              </div>
            )}
            <label>
              Comet password
              <input
                type="password"
                autoComplete="new-password"
                required={!initial.glUrl}
                maxLength={1024}
                value={glPassword}
                placeholder={
                  initial.glUrl
                    ? "Leave blank to keep existing"
                    : "Device password"
                }
                onChange={(e) => setGLPassword(e.target.value)}
              />
            </label>
          </>
        )}
        <TelemetryFields
          value={telemetry}
          onChange={setTelemetry}
          requireSource={deviceType === "telemetry"}
          meterSecret={meterSecret}
          onMeterSecret={setMeterSecret}
          clearToken={clearToken}
          onClearToken={initial.hasGlancesToken ? setClearToken : undefined}
          glancesToken={glancesToken}
          onGlancesToken={setGlancesToken}
          managed={managed}
        />
      </fieldset>
      <p className="small-note">
        Changing an address requires re-entering that device’s password. Saving
        disconnects consoles and reloads the app while keeping you signed in. No
        hardware settings are changed.
      </p>
      <button type="submit" className="primary" disabled={busy || importing}>
        {!initial.id && <Plus size={16} />}
        {saved
          ? "Saved · reconnecting…"
          : busy
            ? "Saving…"
            : assisted
              ? assistantCopy(navigator.language).verified
              : "Save server & reconnect"}
      </button>
      {initial.id && !managed && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => setRemoving(!removing)}
          >
            {standalone ? "Remove standalone KVM" : "Remove telemetry server"}
          </button>
          {removing && (
            <div role="group" aria-label="Confirm removal">
              <p>
                Remove {initial.name} from iBORK? This disconnects its console
                while keeping you signed in. It does not change the device.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await api("device-settings", {
                      method: "DELETE",
                      headers: { "X-CSRF-Token": csrf },
                      body: JSON.stringify({
                        id: initial.id,
                        confirm: initial.id,
                      }),
                    });
                    setSaved(true);
                  } catch (error) {
                    setError(
                      error instanceof Error
                        ? error.message
                        : "Could not remove device",
                    );
                    setBusy(false);
                  }
                }}
              >
                Confirm removal
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setRemoving(false)}
              >
                Cancel removal
              </button>
            </div>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

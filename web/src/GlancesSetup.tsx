import { useState } from "react";
import tunnelScript from "../../deploy/glances-tunnel.sh?raw";

export default function GlancesSetup({
  onUseOrigin,
}: {
  onUseOrigin: (origin: string) => void;
}) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("62000");
  const [copyStatus, setCopyStatus] = useState("");
  const octets = host.split(".");
  const validHost =
    octets.length === 4 &&
    octets.every(
      (part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255,
    );
  const validPort =
    /^[1-9]\d{3,4}$/.test(port) && +port >= 1024 && +port <= 65535;
  const origin = `http://127.0.0.1:${port}`;
  const command =
    validHost && validPort
      ? `bash -s -- ${host} ${port} <<'IBORK_GLANCES_SETUP'\n${tunnelScript.replace(/\r\n/g, "\n").trimEnd()}\nIBORK_GLANCES_SETUP`
      : "";
  return (
    <div>
      <p>
        Use this for Glances v4 listening on 127.0.0.1:61208 on a Debian or
        Proxmox server. You need root terminals on that server and on the iBORK
        host.
      </p>
      <label>
        Glances server IPv4 address
        <input
          value={host}
          placeholder="192.0.2.10"
          onChange={(e) => {
            setHost(e.target.value.trim());
            setCopyStatus("");
          }}
        />
      </label>
      <label>
        Local tunnel port on iBORK
        <input
          inputMode="numeric"
          value={port}
          onChange={(e) => {
            setPort(e.target.value);
            setCopyStatus("");
          }}
        />
      </label>
      {host && !validHost && <p role="status">Enter a valid IPv4 address.</p>}
      {!validPort && <p role="status">Choose a port from 1024 to 65535.</p>}
      <ol>
        <li>
          Run the setup command in the iBORK host terminal. Use a free local
          port for each new tunnel.
        </li>
        <li>
          Run the authorization block it prints in the Glances server terminal.
          Paste the public host key it returns into the waiting iBORK terminal.
        </li>
        <li>
          Once the sensor check succeeds, use the tunnel origin below and save
          the connection. The tunnel starts automatically after reboot.
        </li>
      </ol>
      <button
        type="button"
        disabled={!command}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopyStatus("Setup command copied.");
          } catch {
            setCopyStatus(
              "Open “View setup command” below to select and copy it.",
            );
          }
        }}
      >
        Copy setup command
      </button>
      {copyStatus && <p role="status">{copyStatus}</p>}
      {command && (
        <details>
          <summary>View setup command</summary>
          <textarea
            aria-label="Tunnel setup command"
            readOnly
            rows={7}
            value={command}
            onFocus={(e) => e.target.select()}
          />
        </details>
      )}
      {validPort && (
        <button type="button" onClick={() => onUseOrigin(origin)}>
          Use tunnel origin {origin}
        </button>
      )}
      <p className="small-note">
        Already have a tunnel? Enter its local port and use its origin. A
        trusted HTTPS Glances origin can be entered directly in the connection
        form.
      </p>
    </div>
  );
}

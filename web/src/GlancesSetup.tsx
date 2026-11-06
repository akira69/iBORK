import { useState } from "react";
import { CircleArrowRight } from "lucide-react";
import { CopyButton } from "./CopyButton";
import authorization from "../../deploy/glances-authorize.sh?raw";

const remoteSteps = authorization
  .trim()
  .split(/\r?\n\s*\r?\n/)
  .map((block) => {
    const [heading, command] = block.split(/\r?\n/);
    return { title: heading.slice(2), command };
  });
const validIPv4 = (ip: string) =>
  /^(?:(?:0|[1-9]\d{0,2})\.){3}(?:0|[1-9]\d{0,2})$/.test(ip) &&
  ip.split(".").every((octet) => Number(octet) <= 255);

function Command({ title, command }: { title: string; command: string }) {
  return (
    <li className="glances-command">
      <strong>{title}</strong>
      <div>
        <code tabIndex={command ? 0 : -1}>
          {command || "Waiting for setup details…"}
        </code>
        <CopyButton label={`Copy: ${title}`} text={command} />
      </div>
    </li>
  );
}

export default function GlancesSetup({
  onUseOrigin,
}: {
  onUseOrigin: (origin: string) => void;
}) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("62000");
  const [pairing, setPairing] = useState("");
  const validPort =
    /^[1-9]\d{3,4}$/.test(port) && +port >= 1024 && +port <= 65535;
  const origin = `http://127.0.0.1:${port}`;
  const launch =
    validIPv4(host) && validPort
      ? `/opt/jet-supermicro/jet-supermicro glances-tunnel ${host} ${port}`
      : "";
  const parts = /^(\S+) (ssh-ed25519 [A-Za-z0-9+/]{68})$/.exec(pairing.trim());
  const paired = parts && validIPv4(parts[1]) && launch;
  return (
    <div className="glances-guide">
      <p>
        Use root terminals on the Debian/systemd iBORK host and the Glances
        server. Glances v4 must listen on <code>127.0.0.1:61208</code> on that
        server.
      </p>
      <div className="glances-fields">
        <label>
          Glances server IPv4 address
          <input
            value={host}
            placeholder="192.0.2.10"
            onChange={(e) => {
              setHost(e.target.value.trim());
              setPairing("");
            }}
          />
        </label>
        <label>
          Local tunnel port on iBORK
          <input
            value={port}
            inputMode="numeric"
            onChange={(e) => {
              setPort(e.target.value);
              setPairing("");
            }}
          />
        </label>
      </div>
      {host && !validIPv4(host) && (
        <p role="status">Enter a valid IPv4 address.</p>
      )}
      {!validPort && <p role="status">Choose a port from 1024 to 65535.</p>}
      <div className="glances-hosts">
        <section>
          <h4>1 · iBORK host</h4>
          <ol>
            <Command key={launch} title="Start setup" command={launch} />
          </ol>
          <label>
            Public pairing line
            <input
              disabled={!launch}
              value={pairing}
              placeholder="Source IP and ssh-ed25519 public key"
              onChange={(e) => setPairing(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <p>
            Paste the line printed by the command here. Leave that terminal
            open.
          </p>
          {pairing && !paired && (
            <p role="status">
              Paste the complete IPv4 address and public key on one line.
            </p>
          )}
        </section>
        <section>
          <h4>2 · Glances server</h4>
          <ol>
            {remoteSteps.map(({ title, command }) => {
              const value = command.includes("SSH_PUBLIC_KEY")
                ? paired
                  ? command
                      .replace("SOURCE_IPV4", parts[1])
                      .replace("SSH_PUBLIC_KEY", parts[2])
                  : ""
                : launch
                  ? command
                  : "";
              return (
                <Command key={title + value} title={title} command={value} />
              );
            })}
          </ol>
        </section>
      </div>
      <div className="glances-finish">
        <h4>3 · Verify on iBORK</h4>
        <p>
          Paste the server host key into the waiting iBORK terminal. When it
          reports a verified origin, apply it here and save the connection. For
          an existing tunnel, enter its port and apply the origin directly.
        </p>
        <div className="glances-origin">
          <code>{validPort ? origin : "Enter a valid local port"}</code>
          <button
            type="button"
            disabled={!validPort}
            title="Use tunnel origin"
            aria-label={`Use tunnel origin ${origin}`}
            onClick={() => onUseOrigin(origin)}
          >
            <CircleArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

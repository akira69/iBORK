import { lazy, Suspense, useState } from "react";
const GlancesSetup = lazy(() => import("./GlancesSetup"));

export type Telemetry = {
  glancesUrl?: string;
  meterKind?: string;
  meterUrl?: string;
  meterChannel?: string;
  meterUser?: string;
  wattsField?: string;
  outletId?: string;
};

export function TelemetryFields({
  value,
  onChange,
  requireSource,
  managed,
  meterSecret,
  onMeterSecret,
  clearToken,
  onClearToken,
  glancesToken,
  onGlancesToken,
}: {
  value: Telemetry;
  onChange: (next: Telemetry) => void;
  requireSource: boolean;
  managed: boolean;
  meterSecret: string;
  onMeterSecret: (next: string) => void;
  clearToken: boolean;
  onClearToken?: (value: boolean) => void;
  glancesToken: string;
  onGlancesToken: (next: string) => void;
}) {
  const mqtt = value.meterKind === "mqtt";
  const [guideOpened, setGuideOpened] = useState(false);
  function field(
    key: keyof Telemetry,
    label: string,
    placeholder: string,
    required = false,
  ) {
    return (
      <label>
        {label}
        <input
          required={required}
          value={value[key] ?? ""}
          placeholder={placeholder}
          onChange={(event) =>
            onChange({ ...value, [key]: event.target.value })
          }
        />
      </label>
    );
  }
  return (
    <fieldset className="connection-fields">
      <legend>Hardware telemetry</legend>
      {field(
        "glancesUrl",
        "Glances API origin",
        "https://glances.example.net",
        requireSource && !value.meterKind,
      )}
      <details
        className="glances-setup"
        onToggle={(e) => {
          if (e.currentTarget.open) setGuideOpened(true);
        }}
      >
        <summary>Connect Glances over SSH</summary>
        {guideOpened && (
          <Suspense fallback={<p role="status">Loading setup guide…</p>}>
            <GlancesSetup
              onUseOrigin={(glancesUrl) => onChange({ ...value, glancesUrl })}
            />
          </Suspense>
        )}
      </details>
      {value.glancesUrl && (
        <label>
          Glances bearer token (if required)
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Leave blank to keep a saved token"
            disabled={clearToken}
            value={glancesToken}
            onChange={(e) => onGlancesToken(e.target.value)}
          />
        </label>
      )}
      {value.glancesUrl && onClearToken && (
        <label>
          <input
            type="checkbox"
            checked={clearToken}
            onChange={(e) => onClearToken(e.target.checked)}
          />
          Remove stored Glances token
        </label>
      )}
      <label>
        Power source
        <select
          value={value.meterKind ?? ""}
          onChange={(e) => {
            onChange({
              glancesUrl: value.glancesUrl,
              meterKind: e.target.value,
            });
            onMeterSecret("");
          }}
        >
          <option value="">{managed ? "IPMI system power" : "No meter"}</option>
          <option value="mqtt">MQTT outlet</option>
          <option value="home-assistant">Matter via Home Assistant</option>
        </select>
      </label>
      {value.meterKind && (
        <>
          {field("outletId", "Physical outlet ID", "demo-outlet", true)}
          <p className="small-note">
            Use the same ID for this physical outlet across sources. Assign only
            an outlet dedicated to this server.
          </p>
          {field(
            "meterUrl",
            mqtt ? "MQTT broker" : "Home Assistant origin",
            mqtt ? "mqtts://broker.example.net:8883" : "https://ha.example.net",
            true,
          )}
          {field(
            "meterChannel",
            mqtt ? "MQTT status topic" : "Power sensor entity",
            mqtt ? "rack/demo/status" : "sensor.demo_power",
            true,
          )}
          {mqtt && (
            <>
              {field("wattsField", "JSON field containing watts", "watts")}
              {field("meterUser", "MQTT username", "Optional")}
            </>
          )}
          <label>
            {mqtt ? "MQTT password" : "Home Assistant bearer token"}
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Leave blank to keep a saved credential"
              disabled={mqtt && !value.meterUser}
              value={meterSecret}
              onChange={(e) => onMeterSecret(e.target.value)}
            />
          </label>
        </>
      )}
    </fieldset>
  );
}

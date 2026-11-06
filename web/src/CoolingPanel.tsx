import "./operator-tools.css";

export type CoolingState = {
  modeCode?: string;
  modeLabel: string;
  querySupported: boolean;
  controlSupported: boolean;
  reason: string;
};

export function CoolingPanel({
  cooling,
  loading,
  error,
}: {
  cooling?: CoolingState;
  loading?: boolean;
  error?: string;
}) {
  return (
    <section className="cooling-panel" aria-label="Fan mode">
      <div className="cooling-mode">
        <strong>Fan mode</strong>
        <span>
          {error
            ? "Unavailable"
            : cooling?.querySupported
              ? `${cooling.modeLabel}${cooling.modeCode ? ` (${cooling.modeCode})` : ""}`
              : loading
                ? "Reading…"
                : "Query unavailable"}
        </span>
      </div>
      {error && <p role="status">{error}</p>}
      <p className="cooling-limit">
        {cooling?.reason ||
          "Changing built-in fan modes requires board-specific verification."}
      </p>
    </section>
  );
}

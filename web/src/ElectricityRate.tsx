import {
  createContext,
  useContext,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { DollarSign, Factory } from "lucide-react";
import { api } from "./api";
import { tariff } from "./energy";
import { usePoll } from "./usePoll";

type Rate = { usdPerKwh: number };
function readRate(data?: Rate) {
  const value = data?.usdPerKwh;
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1000
    ? value
    : null;
}

const RateContext = createContext<{
  rate: number | null;
  error?: string;
  saving: boolean;
  save: (value: number) => Promise<void>;
} | null>(null);

export function ElectricityRateProvider({
  csrf,
  children,
}: {
  csrf: string;
  children: ReactNode;
}) {
  const [confirmed, setConfirmed] = useState({
    rate: null as number | null,
    revision: 0,
  });
  const [saving, setSaving] = useState(false);
  const poll = usePoll<Rate>(
    "electricity-rate",
    30000,
    true,
    confirmed.revision,
  );
  // A GET started before the last successful PUT cannot replace its confirmed value.
  const current = poll.revision === confirmed.revision;
  const rate = current ? readRate(poll.data) : confirmed.rate;
  const error =
    current && !poll.loading && rate === null
      ? poll.error || "Invalid rate received."
      : undefined;
  async function save(value: number) {
    setSaving(true);
    try {
      const saved = readRate(
        await api<Rate>("electricity-rate", {
          method: "PUT",
          headers: { "X-CSRF-Token": csrf },
          body: JSON.stringify({ usdPerKwh: value }),
          signal: AbortSignal.timeout(15000),
        }),
      );
      if (saved === null) throw Error("Invalid rate received.");
      setConfirmed((previous) => ({
        rate: saved,
        revision: previous.revision + 1,
      }));
    } finally {
      setSaving(false);
    }
  }
  return (
    <RateContext.Provider value={{ rate, error, saving, save }}>
      {children}
    </RateContext.Provider>
  );
}

export function useElectricityRate() {
  const value = useContext(RateContext);
  if (!value) throw Error("Missing electricity rate provider");
  return value;
}

export function ElectricityRateSettings() {
  const { rate, error: loadError, saving, save } = useElectricityRate();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const text = draft ?? String(rate ?? "");
  const parsed = tariff(text);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || parsed === null || rate === null || parsed === rate) return;
    setError("");
    setSaved(false);
    try {
      await save(parsed);
      setDraft(null);
      setSaved(true);
    } catch (reason) {
      setError(
        `Could not confirm the rate was saved. ${reason instanceof Error ? reason.message : "Try again."}`,
      );
    }
  }
  return (
    <section className="panel data-panel" aria-label="Electricity cost">
      <h2 className="settings-card-title">
        <Factory size={20} /> Electricity cost
      </h2>
      <form className="tariff" onSubmit={submit}>
        <label htmlFor="electricity-rate">Electricity rate · $/kWh</label>
        <div className="rate-input">
          <DollarSign size={18} aria-hidden="true" />
          <input
            id="electricity-rate"
            type="number"
            min="0"
            max="1000"
            step="any"
            required
            disabled={saving || rate === null}
            value={text}
            onChange={(e) => {
              setDraft(e.target.value);
              setError("");
              setSaved(false);
            }}
            aria-invalid={draft !== null && parsed === null}
            aria-describedby="tariff-help"
          />
          <span>/ kWh</span>
        </div>
        <p id="tariff-help" className="small-note">
          Flat rate shared by all servers and panels. Enter $0 to $1,000 per
          kWh. Cost estimates exclude taxes and fixed fees.
        </p>
        <button
          className="primary"
          type="submit"
          disabled={
            saving || parsed === null || rate === null || parsed === rate
          }
        >
          {saving ? "Saving rate…" : "Save electricity rate"}
        </button>
      </form>
      {loadError && (
        <p role="alert">Could not load the electricity rate. {loadError}</p>
      )}
      {rate === null && !loadError && (
        <p role="status">Loading electricity rate…</p>
      )}
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Electricity rate saved.</p>}
    </section>
  );
}

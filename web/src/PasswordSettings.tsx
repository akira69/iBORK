import { useState, type FormEvent } from "react";
import { api, APIError } from "./api";
import { KeyRound, ShieldCheck } from "lucide-react";

export function PasswordSettings({
  csrf,
  onChanged,
}: {
  csrf: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const currentPassword = String(fields.get("currentPassword"));
    const newPassword = String(fields.get("newPassword"));
    setError("");
    if (
      [...newPassword].length < 12 ||
      new TextEncoder().encode(newPassword).length > 72
    ) {
      setError("Use at least 12 characters and no more than 72 UTF-8 bytes.");
      return;
    }
    if (newPassword !== fields.get("confirmPassword")) {
      setError("New passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api("app-password", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: JSON.stringify({ currentPassword, newPassword }),
        signal: AbortSignal.timeout(15000),
      });
      form.reset();
      onChanged();
    } catch (reason) {
      setError(
        reason instanceof APIError
          ? reason.message
          : "Could not confirm the password change. Try signing in with the new password before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel data-panel login-settings">
      <h2 className="settings-card-title">
        <ShieldCheck size={20} /> Dashboard login password
      </h2>
      <p className="small-note">
        Changing this password signs out all sessions and disconnects open
        consoles. Device passwords stay unchanged.
      </p>
      <form onSubmit={submit} className="password-settings">
        <fieldset disabled={busy}>
          <label>
            Current password
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              maxLength={72}
              required
            />
          </label>
          <label>
            New password
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={72}
              required
            />
          </label>
          <label>
            Confirm new password
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={72}
              required
            />
          </label>
          <button type="submit" className="primary">
            <KeyRound size={16} />
            {busy ? "Changing password…" : "Change password"}
          </button>
        </fieldset>
        <p className="small-note">
          At least 12 characters; up to 72 UTF-8 bytes.
        </p>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}

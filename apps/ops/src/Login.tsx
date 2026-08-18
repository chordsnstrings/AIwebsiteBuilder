// Operator sign-in. TOTP is mandatory for the superadmin — the code field
// appears only once the server asks for one, so the flow never implies a
// password was correct before it has been checked.
//
// ⛔ "Browse in demo mode instead" is gone. It was a link that dropped the
// operator into a full dashboard rendered from fixtures, and the same fallback
// fired silently on any 403 — so an expired session looked exactly like a
// healthy business. There is nothing to look at here without a session, and
// saying so is the honest answer.
import { useState, type FormEvent } from "react";
import { api, type OpsUser } from "./api.ts";

export function Login({ onSignedIn }: { onSignedIn: (u: OpsUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api.login(email, password, needsTotp ? totp : undefined);
    setBusy(false);
    if (res.ok) {
      onSignedIn(res.user);
      return;
    }
    if (res.reason === "totp_required") {
      setNeedsTotp(true);
      setError("Enter the six-digit code from your authenticator.");
    } else if (res.reason === "totp_invalid") {
      setNeedsTotp(true);
      setError("That code was not accepted. Try the current one.");
    } else if (res.reason === "unreachable") {
      setError("The API is not reachable. Nothing can be shown until it is.");
    } else {
      setError("Those credentials were not accepted.");
    }
  };

  return (
    <div className="login">
      <div className="login-inner">
        <div className="rail-mark" style={{ padding: 0 }}>
          ADW <small>ops</small>
        </div>
        <div>
          <h1>Operator sign-in</h1>
          <p className="figure-evidence" style={{ marginTop: "var(--s0)" }}>
            Two-factor authentication is required for the superadmin.
          </p>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email" type="email" autoComplete="username" required
              value={email} onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password" type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {needsTotp ? (
            <div className="field">
              <label htmlFor="totp">Authenticator code</label>
              <input
                id="totp" inputMode="numeric" pattern="[0-9]*" maxLength={6}
                autoComplete="one-time-code" style={{ letterSpacing: "0.3em" }}
                value={totp} onChange={(e) => setTotp(e.target.value)}
              />
            </div>
          ) : null}
          {error === null ? null : <p className="failed">{error}</p>}
          <div>
            <button className="btn" data-tone="primary" type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

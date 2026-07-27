// Operator sign-in. TOTP is mandatory for the superadmin — the form reveals the
// code field only once the server says it needs one, so the flow never implies
// a password was correct before it has been checked.
import { useState, type FormEvent } from "react";
import { Badge, Button, Card } from "@adw/ui";
import { api, type OpsUser } from "./api.ts";

export function Login({ onSignedIn, onDemoMode }: { onSignedIn: (u: OpsUser) => void; onDemoMode: () => void }) {
  const [email, setEmail] = useState("admin@adw.example");
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
      setError("API not reachable — you can browse the console in demo mode.");
    } else {
      setError("Those credentials were not accepted.");
    }
  };

  return (
    <div className="login-wrap">
      <Card className="login-card">
        <div className="ops-brand" style={{ padding: "0 0 14px" }}>
          <span className="logo" /> ADW Ops
        </div>
        <h1 style={{ fontSize: "1.3rem" }}>Operator sign-in</h1>
        <p className="adw-muted" style={{ marginBottom: 16 }}>
          Two-factor authentication is required for the superadmin.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="email" className="adw-muted">
            Email
          </label>
          <input
            id="email"
            className="adw-input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ marginBottom: 12 }}
          />
          <label htmlFor="password" className="adw-muted">
            Password
          </label>
          <input
            id="password"
            className="adw-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ marginBottom: 12 }}
          />
          {needsTotp && (
            <>
              <label htmlFor="totp" className="adw-muted">
                Authenticator code
              </label>
              <input
                id="totp"
                className="adw-input"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                autoComplete="one-time-code"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                style={{ marginBottom: 12, letterSpacing: "0.3em" }}
              />
            </>
          )}
          {error && (
            <p style={{ marginBottom: 12 }}>
              <Badge tone="warn">{error}</Badge>
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p style={{ marginTop: 18 }}>
          <button className="linkish" type="button" onClick={onDemoMode}>
            Browse in demo mode instead
          </button>
        </p>
      </Card>
    </div>
  );
}

import { useState } from "react";
import { HashRouter, NavLink, Route, Routes } from "react-router-dom";
import { Badge, Button, Card, Counter, Reveal, Stat, Table, useTheme } from "@adw/ui";
import {
  exceptions,
  killSwitches as seedSwitches,
  opsMetrics,
  registryRoles,
  vaultSlots as seedVault,
  vendors,
} from "@adw/demo-data";

function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="ops-head">
      <h1>{title}</h1>
      <p className="adw-muted">{sub}</p>
    </div>
  );
}

function Overview() {
  return (
    <>
      <Head title="Health" sub="What needs a decision — not what the system is doing. The exception queue is the home surface." />
      <div className="grid-metrics">
        {opsMetrics.map((m, i) => (
          <Reveal key={m.label} stagger={i}>
            <Card>
              <Stat label={m.label}>
                <Counter to={m.value} decimals={m.decimals} prefix={m.prefix} suffix={m.suffix} />
              </Stat>
              {m.delta !== undefined && (
                <div className={m.delta >= 0 ? "delta-up" : "delta-down"}>
                  {m.delta >= 0 ? "▲" : "▼"} {Math.abs(m.delta)}% vs last week
                </div>
              )}
            </Card>
          </Reveal>
        ))}
      </div>
    </>
  );
}

function Exceptions() {
  return (
    <>
      <Head title="Exception queue" sub="Severity-ranked. Each carries what the system already did, and a one-click decision." />
      <div className="adw-col">
        {exceptions.map((e, i) => (
          <Reveal key={e.id} stagger={i}>
            <Card hoverable>
              <div className="adw-spread">
                <div className="adw-row" style={{ alignItems: "center" }}>
                  <Badge tone={e.severity <= 2 ? "bad" : "warn"}>SEV{e.severity}</Badge>
                  <strong>{e.trigger}</strong>
                  <span className="adw-muted adw-mono">{e.id}</span>
                </div>
                <span className="adw-muted">{new Date(e.raisedAt).toLocaleString()}</span>
              </div>
              <p style={{ marginTop: 10 }}>
                <span className="adw-muted">System already did:</span> {e.systemAction}
              </p>
              <p>
                <span className="adw-muted">Recommended:</span> {e.recommendation}
              </p>
              <div className="adw-row" style={{ marginTop: 12 }}>
                <Button size="sm">Approve</Button>
                <Button size="sm" variant="ghost">
                  Reject
                </Button>
              </div>
            </Card>
          </Reveal>
        ))}
        {exceptions.length === 0 && <Card>Empty by design.</Card>}
      </div>
    </>
  );
}

function KillSwitches() {
  const [switches, setSwitches] = useState(seedSwitches);
  const toggle = (name: string) =>
    setSwitches((s) => s.map((k) => (k.name === name ? { ...k, engaged: !k.engaged, toggledBy: "you", toggledAt: new Date().toISOString() } : k)));
  return (
    <>
      <Head title="Kill switches" sub="Each independently effective within 60 seconds. Also available via CLI." />
      <Card>
        {switches.map((k) => (
          <div key={k.name} className="vault-slot">
            <div>
              <strong className="adw-mono">{k.name}</strong>
              <div className="adw-muted" style={{ fontSize: "0.82rem" }}>
                {k.engaged ? `engaged by ${k.toggledBy}` : "released"}
              </div>
            </div>
            <label className="switch">
              <input type="checkbox" checked={k.engaged} onChange={() => toggle(k.name)} aria-label={k.name} />
              <span className="track" />
            </label>
          </div>
        ))}
      </Card>
    </>
  );
}

function Registry() {
  return (
    <>
      <Head title="Model registry" sub="Champion per role, backed by a stored eval run. Pending roles select on live A/B." />
      <Card>
        <Table
          columns={[
            { key: "role", header: "Role" },
            { key: "champion", header: "Champion", render: (r) => <span className="adw-mono">{r.champion}</span> },
            { key: "status", header: "Status", render: (r) => <Badge tone={r.status === "active" ? "ok" : "warn"}>{r.status}</Badge> },
            { key: "metric", header: "Cost/pass ($)", render: (r) => r.metric.toFixed(4) },
            { key: "evalAgeDays", header: "Eval age", render: (r) => `${r.evalAgeDays}d` },
            { key: "fallbackLastOk", header: "Fallback" },
          ]}
          rows={registryRoles}
        />
      </Card>
    </>
  );
}

function Vendors() {
  return (
    <>
      <Head title="Vendors" sub="The 66-vendor lifecycle. No vendor is ACTIVE without a passing Sentinel probe." />
      <Card>
        <Table
          columns={[
            { key: "name", header: "Vendor" },
            { key: "tier", header: "Tier", render: (v) => <Badge>{v.tier}</Badge> },
            { key: "dataClass", header: "Data" },
            { key: "state", header: "State" },
            { key: "mode", header: "Mode", render: (v) => <Badge tone={v.mode === "live" ? "ok" : "neutral"}>{v.mode}</Badge> },
            { key: "probe", header: "Probe", render: (v) => <Badge tone={v.probe === "passing" ? "ok" : "bad"}>{v.probe}</Badge> },
            { key: "diligence", header: "Diligence", render: (v) => `${v.diligence}/9` },
          ]}
          rows={vendors}
        />
      </Card>
    </>
  );
}

function Vault() {
  const [slots, setSlots] = useState(seedVault);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const deposit = (vendorId: string, keyName: string) => {
    const secret = draft[`${vendorId}:${keyName}`] ?? "";
    if (!secret) return;
    const fp = "sha256:" + Array.from(secret).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).slice(0, 12);
    setSlots((s) => s.map((sl) => (sl.vendorId === vendorId && sl.keyName === keyName ? { ...sl, deposited: true, fingerprint: fp } : sl)));
    setDraft((d) => ({ ...d, [`${vendorId}:${keyName}`]: "" }));
  };
  return (
    <>
      <Head
        title="Settings · Vault"
        sub="Deposit vendor credentials to go live. Write-only: once deposited, only a fingerprint is shown — never the secret. Depositing flips that vendor from mock to live."
      />
      <Card>
        <p className="adw-muted" style={{ marginBottom: 16 }}>
          Compliance config (jurisdictions, thresholds, pricing) is changed by pull request, never here. This surface manages
          credentials, flags and kill switches only.
        </p>
        {slots.map((sl) => (
          <div key={`${sl.vendorId}:${sl.keyName}`} className="vault-slot">
            <div style={{ minWidth: 180 }}>
              <strong>{sl.vendorId}</strong>
              <div className="adw-muted adw-mono" style={{ fontSize: "0.8rem" }}>
                {sl.keyName}
              </div>
            </div>
            {sl.deposited ? (
              <div className="adw-row" style={{ alignItems: "center" }}>
                <Badge tone="ok">deposited</Badge>
                <span className="adw-mono adw-muted">{sl.fingerprint}</span>
                <Button size="sm" variant="ghost">
                  Request rotation
                </Button>
              </div>
            ) : (
              <div className="adw-row" style={{ alignItems: "center", flex: 1, justifyContent: "flex-end" }}>
                <input
                  className="adw-input"
                  type="password"
                  placeholder="Paste secret…"
                  style={{ maxWidth: 260 }}
                  value={draft[`${sl.vendorId}:${sl.keyName}`] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [`${sl.vendorId}:${sl.keyName}`]: e.target.value }))}
                />
                <Button size="sm" onClick={() => deposit(sl.vendorId, sl.keyName)}>
                  Deposit
                </Button>
              </div>
            )}
          </div>
        ))}
      </Card>
    </>
  );
}

const NAV = [
  { to: "/", label: "Health", el: <Overview /> },
  { to: "/exceptions", label: "Exceptions", el: <Exceptions /> },
  { to: "/switches", label: "Kill switches", el: <KillSwitches /> },
  { to: "/registry", label: "Registry", el: <Registry /> },
  { to: "/vendors", label: "Vendors", el: <Vendors /> },
  { to: "/vault", label: "Settings · Vault", el: <Vault /> },
];

export function App() {
  const [theme, toggle] = useTheme();
  return (
    <HashRouter>
      <div className="ops-shell">
        <aside className="ops-side">
          <div className="ops-brand">
            <span className="logo" /> ADW Ops
          </div>
          <nav className="ops-nav adw-col" style={{ gap: 2, flex: 1 }}>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === "/"}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <Button variant="ghost" size="sm" onClick={toggle}>
            {theme === "dark" ? "☀ Light" : "☾ Dark"}
          </Button>
        </aside>
        <main className="ops-main">
          <Routes>
            {NAV.map((n) => (
              <Route key={n.to} path={n.to} element={n.el} />
            ))}
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}

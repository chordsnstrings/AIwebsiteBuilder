// Vendors & vault — the go-live surface.
//
// ⛔ The vault is write-only and there is no route that returns a secret. What
// is shown is a fingerprint prefix and a version, which is enough to answer
// "is the key I am holding the one that is deposited?" and not enough to be
// worth stealing. A console that could display a credential would be a console
// worth phishing an operator for.

import { useState } from "react";
import { AsOf, Board, Empty, Eyebrow, State, ViewHead, shortAge, usePoll } from "../primitives.tsx";
import { api, type VaultEntry, type VendorRow } from "../api.ts";

const PROBE_STATE: Record<string, string> = {
  pass: "ok", passing: "ok", fail: "failing", failing: "failing", unknown: "never_run",
};

export function Vendors() {
  const [vendors] = usePoll(() => api.vendors(), 60_000);
  const [vault, reloadVault] = usePoll(() => api.vault(), 60_000);

  return (
    <>
      <ViewHead
        title="Vendors & vault"
        blurb="Every vendor's lifecycle state and probe, and the credential slots that flip each adapter from mock to live."
        right={<AsOf at={vendors.status === "ok" ? vendors.at : null} />}
      />

      <section className="section">
        <Board what="The vendor register" result={vendors}>
          {(rows: VendorRow[]) => {
            const live = rows.filter((v) => v.state === "ACTIVE");
            return (
              <>
                <Eyebrow count={`${live.length}/${rows.length}`} note="active — the rest are mocked">
                  Vendors
                </Eyebrow>
                {rows.length === 0 ? (
                  <Empty headline="No vendors registered" checked="the vendors table is seeded from config/vendors.yaml" />
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Vendor</th>
                          <th className="num">Tier</th>
                          <th>Data class</th>
                          <th>Lifecycle</th>
                          <th>Probe</th>
                          <th className="num">Last pass</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((v) => (
                          <tr key={v.id}>
                            <td>
                              {v.name}
                              <span className="cell-sub mono">{v.id}</span>
                            </td>
                            <td className="num muted">T{v.tier}</td>
                            <td className="muted">{v.data_class}</td>
                            <td>
                              {v.state}
                              {v.gate === null ? null : <span className="cell-sub">gate: {v.gate}</span>}
                            </td>
                            {/* ⛔ No vendor reaches ACTIVE without a passing probe.
                                A probe that has never run reads "never run", not
                                "fine". */}
                            <td><State state={PROBE_STATE[v.probe_status ?? "unknown"] ?? "never_run"} /></td>
                            <td className="num muted">{shortAge(v.probe_last_ok)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            );
          }}
        </Board>
      </section>

      <section className="section">
        <Board what="The vault" result={vault}>
          {(entries: VaultEntry[]) => <VaultPanel entries={entries} onDeposited={reloadVault} />}
        </Board>
      </section>
    </>
  );
}

function VaultPanel({ entries, onDeposited }: { entries: VaultEntry[]; onDeposited: () => void }) {
  const [vendorId, setVendorId] = useState("");
  const [keyName, setKeyName] = useState("");
  const [secret, setSecret] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const deposit = async () => {
    if (vendorId.trim() === "" || keyName.trim() === "" || secret === "") return;
    setBusy(true);
    const res = await api.depositCredential(vendorId.trim(), keyName.trim(), secret);
    setBusy(false);
    // ⛔ Cleared immediately whether it worked or not. A secret left in a text
    // input is a secret in a screenshot, in a session recording, and in the
    // next person's shoulder view.
    setSecret("");
    setNote(res.status === "ok" ? `deposited as ${res.data.ref ?? "a new version"}` : `failed: ${res.reason}`);
    onDeposited();
  };

  return (
    <>
      <Eyebrow count={entries.length} note="write-only — no route returns a secret">
        Credentials
      </Eyebrow>

      {entries.length === 0 ? (
        <Empty
          headline="No credentials deposited"
          checked="every vendor adapter is therefore running against its mock, and nothing reaches a real API"
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Vendor</th><th>Key</th><th className="num">Version</th>
                <th>Fingerprint</th><th className="num">Expires</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.ref}>
                  <td className="mono">{e.vendorId}</td>
                  <td className="mono">{e.keyName}</td>
                  <td className="num muted">v{e.version}</td>
                  <td className="mono muted">{e.fingerprint}</td>
                  <td className="num muted">{e.expiresAt === null ? "—" : shortAge(e.expiresAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: "var(--s2)", display: "grid", gap: "var(--s1)", maxWidth: 520 }}>
        <div className="field">
          <label htmlFor="v-vendor">Vendor id</label>
          <input id="v-vendor" type="text" value={vendorId} onChange={(e) => setVendorId(e.target.value)} placeholder="stripe" />
        </div>
        <div className="field">
          <label htmlFor="v-key">Key name</label>
          <input id="v-key" type="text" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="secret_key" />
        </div>
        <div className="field">
          <label htmlFor="v-secret">Secret</label>
          <input id="v-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
        </div>
        <div>
          <button className="btn" data-tone="primary" disabled={busy} onClick={() => void deposit()}>
            {busy ? "Depositing…" : "Deposit"}
          </button>
          {note === null ? null : <span className="figure-evidence" style={{ marginLeft: "var(--s1)" }}>{note}</span>}
        </div>
        <p className="figure-evidence">
          Encrypted with a per-secret key wrapped by the master key. Once deposited it can be
          replaced but never read back, including by this console.
        </p>
      </div>
    </>
  );
}

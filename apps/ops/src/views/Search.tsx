// Search — one box.
//
// An email address, a domain, a business name, a customer, a build or a trace
// id. The operator arriving here has a specific thing in hand and wants its
// history; making them choose which of six tables it lives in first is a
// question the console should be answering, not asking.

import { useState } from "react";
import { Empty, Eyebrow, Failed, ViewHead } from "../primitives.tsx";
import { api, isOk, type Loaded } from "../api.ts";

type Results = { query: string; results: Record<string, Record<string, unknown>[]> };

const SECTION_LABEL: Record<string, string> = {
  businesses: "Businesses",
  contacts: "Contacts",
  customers: "Customers",
  gateDecisions: "Gate decisions",
  recentBuilds: "Recent builds",
};

export function Search() {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<Loaded<Results> | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim() === "") return;
    setBusy(true);
    setResult(await api.search(q.trim()));
    setBusy(false);
  };

  return (
    <>
      <ViewHead
        title="Search"
        blurb="Email, domain, business, customer, build or trace id — one box, full history."
      />
      <form onSubmit={(e) => void run(e)} style={{ display: "flex", gap: "var(--s0)", maxWidth: 560, marginBottom: "var(--s3)" }}>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="someone@example.com"
          aria-label="Search"
        />
        <button className="btn" data-tone="primary" disabled={busy}>{busy ? "…" : "Search"}</button>
      </form>

      {result === null ? (
        <Empty headline="Nothing searched yet" checked="results come from businesses, contacts, customers, gate decisions and builds" />
      ) : result.status === "failed" ? (
        <Failed what="The search" reason={result.reason} />
      ) : isOk(result) ? (
        <SearchResults data={result.data} />
      ) : null}
    </>
  );
}

function SearchResults({ data }: { data: Results }) {
  const sections = Object.entries(data.results).filter(([, rows]) => rows.length > 0);
  if (sections.length === 0) {
    return (
      <Empty
        headline={`Nothing matches "${data.query}"`}
        // ⛔ Names what was searched. "No results" without the list of places
        // looked is indistinguishable from "the search only checked one table".
        checked="searched businesses, contacts, customers, gate decisions and recent builds"
      />
    );
  }
  return (
    <>
      {sections.map(([key, rows]) => (
        <section className="section" key={key}>
          <Eyebrow count={rows.length}>{SECTION_LABEL[key] ?? key}</Eyebrow>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>{Object.keys(rows[0] ?? {}).map((col) => <th key={col}>{col.replace(/_/g, " ")}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {Object.entries(row).map(([col, v]) => (
                      <td key={col} className={typeof v === "number" ? "num" : "muted"}>
                        {v === null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

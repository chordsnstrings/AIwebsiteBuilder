// Customers — one row per customer, fourteen mechanism families across it.
//
// ⛔ The screen that did not exist. Fourteen families were built, each with its
// own tables and its own worker job, and there was nowhere in the product to
// answer "how is Bright Plumbing doing?" — you could read fourteen tables by
// hand, which is a query, not an answer.
//
// The strip is fourteen marks per row. At that density a label per cell is
// impossible, so the column names live in the header and each cell carries its
// state in SHAPE as well as colour: a hatched cell means "cannot answer", an
// empty one means "this vertical does not do that", and they must not be
// confusable at a glance or the board is worse than nothing.

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  AsOf, Board, Empty, Eyebrow, State, ViewHead, shortAge, usePoll,
} from "../primitives.tsx";
import { api, type CustomerBoard, type CustomerDetail, type FamilyCell } from "../api.ts";

/** Mirrors FAMILIES in @adw/opsview. Short labels: the header is vertical. */
const FAMILIES = [
  { id: "knowledge", label: "Knowledge", mf: "MF1" },
  { id: "cases", label: "Cases", mf: "MF2" },
  { id: "queue", label: "Owner queue", mf: "MF3" },
  { id: "clocks", label: "Clocks", mf: "MF4" },
  { id: "journeys", label: "Journeys", mf: "MF5" },
  { id: "documents", label: "Documents", mf: "MF6" },
  { id: "watches", label: "Watchers", mf: "MF7" },
  { id: "reconcile", label: "Reconcile", mf: "MF8" },
  { id: "assessments", label: "Assessments", mf: "MF9" },
  { id: "scheduling", label: "Scheduling", mf: "MF10" },
  { id: "calls", label: "Calls", mf: "MF11" },
  { id: "publishing", label: "Publishing", mf: "MF12" },
  { id: "assets", label: "Assets", mf: "MF13" },
  { id: "protocols", label: "Protocols", mf: "MF14" },
] as const;

const cellTitle = (label: string, mf: string, cell: FamilyCell | undefined): string =>
  cell === undefined
    ? `${label} (${mf}) — no data`
    : `${label} (${mf}) — ${cell.state.replace(/_/g, " ")}: ${cell.note}`;

export function Customers() {
  const [board] = usePoll(() => api.customers(200), 30_000);
  const [onlyAttention, setOnlyAttention] = useState(false);

  return (
    <>
      <ViewHead
        title="Customers"
        blurb="Every customer against all fourteen mechanism families. Sorted by what needs attention."
        right={<AsOf at={board.status === "ok" ? board.at : null} />}
      />
      <Board what="The customer board" result={board}>
        {(data: CustomerBoard) => {
          const rows = onlyAttention ? data.rows.filter((r) => r.attentionCount > 0) : data.rows;
          return (
            <>
              {/* ⛔ Surfaced above the table, not buried in a cell. A customer
                  whose vertical never resolved silently gets no case types, no
                  clocks, no journeys and no channels — and on a board that
                  painted those "not applicable" they would look like the
                  healthiest row on screen. */}
              {data.unresolvedVerticals > 0 ? (
                <div className="failed" style={{ marginBottom: "var(--s2)" }}>
                  {data.unresolvedVerticals} customer
                  {data.unresolvedVerticals === 1 ? " has" : "s have"} no resolved vertical. Every
                  family keys off that column, so they are receiving no clocks, journeys, watches,
                  reconciliations or publishing channels at all.
                </div>
              ) : null}

              <Eyebrow
                count={`${rows.length}/${data.totalCustomers}`}
                note={
                  <label style={{ display: "inline-flex", gap: "var(--s0)", alignItems: "center", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={onlyAttention}
                      onChange={(e) => setOnlyAttention(e.target.checked)}
                      style={{ width: "auto" }}
                    />
                    only rows needing attention
                  </label>
                }
              >
                Fleet
              </Eyebrow>

              {rows.length === 0 ? (
                <Empty
                  headline={onlyAttention ? "No customer needs attention" : "No customers yet"}
                  checked={`${data.totalCustomers} customers in the database as of ${new Date(data.asOf).toLocaleTimeString()}`}
                />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th style={{ minWidth: 200 }}>Customer</th>
                        <th>Vertical</th>
                        <th>Status</th>
                        <th style={{ minWidth: 260 }}>
                          <span className="family-head">
                            {FAMILIES.map((f) => (
                              <span key={f.id} title={`${f.label} (${f.mf})`}>{f.label}</span>
                            ))}
                          </span>
                        </th>
                        <th className="num">Waiting</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <Link to={`/customers/${r.id}`}>{r.legalName}</Link>
                            <span className="cell-sub">{r.domain ?? "no domain"} · {r.regionCode}</span>
                          </td>
                          <td className={r.vertical === null ? "" : "muted"}>
                            {r.vertical ?? <State state="unknown" label="unresolved" />}
                          </td>
                          <td className="muted">
                            {r.status}
                            <span className="cell-sub">won {shortAge(r.wonAt)} ago</span>
                          </td>
                          <td>
                            <div className="family-strip">
                              {FAMILIES.map((f) => {
                                const cell = r.cells[f.id];
                                return (
                                  <span
                                    key={f.id}
                                    className="family-cell"
                                    data-state={cell?.state ?? "unknown"}
                                    title={cellTitle(f.label, f.mf, cell)}
                                  />
                                );
                              })}
                            </div>
                          </td>
                          <td className="num">{r.attentionCount === 0 ? "—" : r.attentionCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <Legend />
            </>
          );
        }}
      </Board>
    </>
  );
}

function Legend() {
  return (
    <div className="coverage" style={{ borderTop: "1px solid var(--rule)" }}>
      {["ok", "attention", "stale", "unconfigured", "not_applicable", "unknown"].map((s) => (
        <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: "var(--s0)" }}>
          <span className="family-cell" data-state={s} style={{ width: 16, height: 12, display: "inline-block" }} />
          {s === "ok" ? "running"
            : s === "attention" ? "waiting on a person"
            : s === "stale" ? "nothing recently"
            : s === "unconfigured" ? "never used"
            : s === "not_applicable" ? "not defined for this vertical"
            : "vertical unresolved"}
        </span>
      ))}
    </div>
  );
}

// ── Detail ────────────────────────────────────────────────────────────────

export function CustomerView() {
  const { id = "" } = useParams();
  const [detail] = usePoll(() => api.customer(id), 30_000);

  return (
    <Board what="This customer" result={detail}>
      {(d: CustomerDetail) => {
        const c = d.customer;
        return (
          <>
            <ViewHead
              title={c.legalName}
              blurb={`${c.vertical ?? "vertical unresolved"} · ${c.regionCode} · ${c.status}${
                c.domain === null ? "" : ` · ${c.domain}`
              }`}
              right={<AsOf at={new Date(d.asOf)} />}
            />

            <section className="section">
              <Eyebrow
                count={c.attentionCount === 0 ? "0" : c.attentionCount}
                note="config on the left, what is actually running on the right"
              >
                Mechanism families
              </Eyebrow>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Family</th>
                      <th>State</th>
                      <th className="num">Live</th>
                      <th className="num">Waiting</th>
                      <th className="num">Defined</th>
                      <th className="wrap">What the vertical defines</th>
                    </tr>
                  </thead>
                  <tbody>
                    {FAMILIES.map((f) => {
                      const cell = c.cells[f.id];
                      const defines = d.defines.find((x) => x.family === f.id);
                      return (
                        <tr key={f.id}>
                          <td>
                            {f.label}
                            <span className="cell-sub">{f.mf}</span>
                          </td>
                          <td>
                            <State state={cell?.state ?? "unknown"} />
                            <span className="cell-sub">{cell?.note ?? ""}</span>
                          </td>
                          <td className="num">{cell === undefined || cell.count === 0 ? "—" : cell.count}</td>
                          <td className="num">{cell === undefined || cell.waiting === 0 ? "—" : cell.waiting}</td>
                          {/* ⛔ The denominator. "2 clocks running" means one
                              thing against 2 defined and another against 6. */}
                          <td className="num muted">{cell?.configured ?? "—"}</td>
                          <td className="wrap muted">
                            {defines === undefined || defines.items.length === 0
                              ? "—"
                              : defines.items.join(", ")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <p className="figure-evidence">
              <Link to="/customers">← all customers</Link>
            </p>
          </>
        );
      }}
    </Board>
  );
}

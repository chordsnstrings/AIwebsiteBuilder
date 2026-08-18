// Acquisition — the enterprise pipeline.
//
// ⛔ `missingEvidence` is rendered on the BOARD, not on a failed attempt to
// move a deal. The acquisition package has computed it all along and nothing
// displayed it, so a deal stalled three weeks on an unrecorded DPA reference
// looked identical to a deal nobody had got round to. The blocker belongs
// where the deal is, not behind a click that fails.

import { AsOf, Board, Empty, Eyebrow, ViewHead, money, shortAge, usePoll } from "../primitives.tsx";
import { api, type OpportunityRow } from "../api.ts";

export function Acquisition() {
  const [pipeline] = usePoll(() => api.opportunities(), 30_000);

  return (
    <>
      <ViewHead
        title="Acquisition"
        blurb="Enterprise opportunities and what each one is waiting for. SMB runs through the lead workflow and never appears here."
        right={<AsOf at={pipeline.status === "ok" ? pipeline.at : null} />}
      />
      <Board what="The pipeline" result={pipeline}>
        {({ pipeline: rows }: { pipeline: OpportunityRow[] }) => {
          const blocked = rows.filter((r) => r.missingEvidence.length > 0);
          const stale = rows.filter((r) => Date.now() - new Date(r.updatedAt).getTime() > 14 * 86_400_000);
          return (
            <>
              <Eyebrow
                count={rows.length}
                note={`${blocked.length} blocked on evidence · ${stale.length} untouched for a fortnight`}
              >
                Open opportunities
              </Eyebrow>
              {rows.length === 0 ? (
                <Empty
                  headline="No open enterprise opportunities"
                  checked="opportunities table, excluding closed — the SMB motion is the lead pipeline and is not counted here"
                />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th>Stage</th>
                        <th>Next gate</th>
                        <th className="wrap">Blocked on</th>
                        <th className="num">Quote</th>
                        <th>Owner</th>
                        <th className="num">Idle</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <span className="mono">{r.businessId.slice(0, 8)}</span>
                            <span className="cell-sub">{r.vertical.replace(/_/g, " ")}</span>
                          </td>
                          <td>
                            {r.stageLabel}
                            {r.targetFunction === null ? null : <span className="cell-sub">{r.targetFunction}</span>}
                          </td>
                          <td className="muted">{r.nextGate ?? (r.nextStage === null ? "terminal" : "no gate")}</td>
                          <td className="wrap">
                            {r.missingEvidence.length === 0 ? (
                              <span className="muted">—</span>
                            ) : (
                              <span style={{ color: "var(--bad)" }}>{r.missingEvidence.join(", ")}</span>
                            )}
                          </td>
                          <td className="num">{r.quoteAmountCents === null ? "—" : money(r.quoteAmountCents)}</td>
                          {/* ⛔ An unowned deal is its own kind of blocked. */}
                          <td className={r.ownerEmail === null ? "" : "muted"}>
                            {r.ownerEmail ?? <span style={{ color: "var(--bad)" }}>unassigned</span>}
                          </td>
                          <td className="num">{shortAge(r.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="coverage">
                <span>
                  Enterprise accounts never receive a speculative preview — they receive a business
                  case, and the preview activity refuses and raises an exception if asked.
                </span>
              </div>
            </>
          );
        }}
      </Board>
    </>
  );
}

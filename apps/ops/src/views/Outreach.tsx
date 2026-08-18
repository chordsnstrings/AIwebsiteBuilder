// Outreach — every business ADW has reached out to.
//
// ⛔ 676 businesses, 280 contacts, 228 leads, 125 gate decisions, 69 messages,
// 55 previews and 62 suppressions sat in the database with no screen of any
// kind. The console had "Acquisition", which covers the 33 enterprise clusters,
// and nothing at all for the SMB motion — which is the entire business.
//
// ⛔ The funnel is a COHORT: every stage counts distinct BUSINESSES out of the
// same starting population, so the percentages are comparable and the whole
// thing shrinks monotonically. Counting each stage's own table instead produced
// "contacts: 583% of previous", which is what happens when independent
// populations are drawn as a funnel.

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  AsOf, Board, Empty, Eyebrow, Failed, FigureTile, Figures, State, ViewHead,
  shortAge, usePoll,
} from "../primitives.tsx";
import {
  api,
  type BusinessBoard, type BusinessDetail, type FunnelStage,
  type GateSummary, type OutreachPayload,
} from "../api.ts";

export function Outreach() {
  const [payload] = usePoll(() => api.outreach(), 60_000);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [businesses] = usePoll(() => api.businesses(query, 100), 60_000);

  return (
    <>
      <ViewHead
        title="Outreach"
        blurb="The SMB motion: who was ingested, who could lawfully be contacted, who was, and what came back."
        right={<AsOf at={payload.status === "ok" ? payload.at : null} />}
      />

      <Board what="The outreach board" result={payload}>
        {(data: OutreachPayload) => (
          <>
            {data.funnel.ok ? <Funnel stages={data.funnel.data.stages} /> : <Failed what="The funnel" reason={data.funnel.error} />}
            {data.gate.ok ? <GateDenials summary={data.gate.data} /> : <Failed what="Gate decisions" reason={data.gate.error} />}
          </>
        )}
      </Board>

      <section className="section">
        <Eyebrow note="search by name or website">Businesses</Eyebrow>
        <form
          onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}
          style={{ display: "flex", gap: "var(--s0)", maxWidth: 480, marginBottom: "var(--s1)" }}
        >
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Bright Plumbing" aria-label="Search businesses" />
          <button className="btn">Search</button>
        </form>
        <Board what="The business list" result={businesses}>
          {(b: BusinessBoard) => (
            <>
              {b.withoutProvenance > 0 ? (
                <div className="failed" style={{ marginBottom: "var(--s1)" }}>
                  {b.withoutProvenance.toLocaleString()} of {b.total.toLocaleString()} businesses have no
                  provenance record. None of them may lawfully be cold-contacted — the gate denies on
                  PROVENANCE_MISSING, so these are dead weight in the pipeline until provenance is captured.
                </div>
              ) : null}
              {b.rows.length === 0 ? (
                <Empty
                  headline={query === "" ? "No businesses ingested" : `Nothing matches "${query}"`}
                  checked={`${b.total.toLocaleString()} businesses in the database`}
                />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Business</th><th>Vertical</th><th>Segment</th>
                        <th>Provenance</th><th className="num">Contacts</th><th className="num">Leads</th>
                        <th className="num">Sent</th><th className="num">Gate ✓/✗</th>
                        <th>Preview</th><th>Outcome</th><th className="num">Ingested</th>
                      </tr>
                    </thead>
                    <tbody>
                      {b.rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <Link to={`/outreach/${r.id}`}>{r.name}</Link>
                            <span className="cell-sub">{r.city ?? "—"} · {r.countryCode}/{r.regionCode}</span>
                          </td>
                          <td className="muted">{r.vertical ?? r.category ?? "—"}</td>
                          <td className="muted">{r.segment}</td>
                          {/* ⛔ The precondition for lawful contact, on every row. */}
                          <td>
                            <State
                              state={r.hasProvenance ? "ok" : "attention"}
                              label={r.hasProvenance ? "captured" : "missing"}
                            />
                          </td>
                          <td className="num">{r.contacts === 0 ? "—" : r.contacts}</td>
                          <td className="num">{r.leads === 0 ? "—" : r.leads}</td>
                          <td className="num">{r.messagesSent === 0 ? "—" : r.messagesSent}</td>
                          <td className="num muted">
                            {r.gateAllowed}/{r.gateDenied}
                          </td>
                          <td className="muted">
                            {r.previewClaimed ? "claimed" : r.hasPreview ? "built" : "—"}
                          </td>
                          <td>
                            {r.isCustomer ? <State state="ok" label="customer" />
                              : r.suppressed ? <State state="not_applicable" label="suppressed" />
                              : <span className="muted">—</span>}
                          </td>
                          <td className="num muted">{shortAge(r.ingestedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Board>
      </section>
    </>
  );
}

function Funnel({ stages }: { stages: FunnelStage[] }) {
  const top = stages[0]?.count ?? 0;
  return (
    <section className="section">
      <Eyebrow note="every stage counts distinct businesses out of the same cohort">
        Funnel
      </Eyebrow>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Stage</th><th className="num">Businesses</th><th className="num">Of cohort</th>
              <th style={{ width: "34%" }}>Share</th><th className="wrap">Counted as</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((s) => (
              <tr key={s.key}>
                <td className="funnel-stage">
                  {s.label}
                  {s.violatesSubset ? (
                    <span className="cell-sub" style={{ color: "var(--bad)" }}>
                      larger than {s.subsetOf}, which is impossible — a join is wrong
                    </span>
                  ) : null}
                </td>
                <td className="num">{s.count < 0 ? "—" : s.count.toLocaleString()}</td>
                <td className="num muted">
                  {s.ofCohort === null ? "—" : `${(s.ofCohort * 100).toFixed(1)}%`}
                </td>
                <td>
                  {/* A bar, not a chart: the comparison that matters is against
                      the cohort, and one length per row says it exactly. */}
                  <span className="funnel-bar">
                    <span
                      style={{ width: top === 0 || s.count < 0 ? "0%" : `${(s.count / top) * 100}%` }}
                      {...(s.violatesSubset ? { "data-tone": "bad" } : {})}
                    />
                  </span>
                </td>
                <td className="wrap muted" style={{ fontSize: "var(--t-small)" }}>{s.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function GateDenials({ summary }: { summary: GateSummary }) {
  return (
    <section className="section">
      <Eyebrow note="the only route to transport">Gate decisions</Eyebrow>
      <Figures>
        <FigureTile
          label="Decisions evaluated"
          value={summary.total.toLocaleString()}
          evidence="gate_decisions — one row per send considered, allowed or not"
        />
        <FigureTile
          label="Allowed"
          value={summary.allowed.toLocaleString()}
          evidence={`${summary.denied.toLocaleString()} denied`}
        />
        <FigureTile
          label="Denial rate"
          // ⛔ Null when nothing was ever evaluated.
          value={summary.denialRate === null ? null : `${(summary.denialRate * 100).toFixed(1)}%`}
          evidence={
            summary.total === 0
              ? "nothing has been evaluated — not measurable"
              : `${summary.denied.toLocaleString()} of ${summary.total.toLocaleString()}`
          }
        />
      </Figures>
      {summary.reasons.length === 0 ? null : (
        <>
          <Eyebrow count={summary.reasons.length}>Why sends were denied</Eyebrow>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Rule</th><th className="wrap">Reason</th><th className="num">Denials</th><th className="num">Share</th></tr></thead>
              <tbody>
                {summary.reasons.map((r) => (
                  <tr key={`${r.ruleId}:${r.reason}`}>
                    <td className="mono">{r.ruleId}</td>
                    <td className="wrap muted">{r.reason}</td>
                    <td className="num">{r.count}</td>
                    <td className="num muted">
                      {summary.denied === 0 ? "—" : `${((r.count / summary.denied) * 100).toFixed(0)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// ── One business, in full ─────────────────────────────────────────────────

export function BusinessView() {
  const { id = "" } = useParams();
  const [detail] = usePoll(() => api.business(id), 60_000);

  return (
    <Board what="This business" result={detail}>
      {(d: BusinessDetail) => {
        const b = d.business;
        return (
          <>
            <ViewHead
              title={b.name}
              blurb={`${b.vertical ?? b.category ?? "unclassified"} · ${b.segment} · ${b.city ?? "—"}, ${b.countryCode}/${b.regionCode}${b.websiteUrl === null ? "" : ` · ${b.websiteUrl}`}`}
              right={<AsOf at={new Date(d.asOf)} />}
            />

            <section className="section">
              <Eyebrow count={d.provenance.length} note="where these details were found, and on what legal basis">
                Provenance
              </Eyebrow>
              {d.provenance.length === 0 ? (
                <div className="failed">
                  No provenance record. This business may not lawfully be cold-contacted — the gate
                  denies on PROVENANCE_MISSING, and any send that did happen needs explaining.
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th className="num">Retrieved</th><th>Legal basis</th><th>No-CEM</th><th>Reviewed by</th><th className="wrap">Source</th></tr></thead>
                    <tbody>
                      {d.provenance.map((p) => (
                        <tr key={p.id}>
                          <td className="num muted">{shortAge(p.retrievedAt)}</td>
                          <td>{p.legalBasis ?? "—"}</td>
                          <td className="muted">{p.noCemStatement === null ? "—" : p.noCemStatement ? "present" : "absent"}</td>
                          <td className="muted">{p.reviewedBy ?? "—"}</td>
                          <td className="wrap muted" style={{ fontSize: "var(--t-small)" }}>{p.sourceUrl ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="section">
              <Eyebrow count={d.contacts.length}>Contacts</Eyebrow>
              {d.contacts.length === 0 ? (
                <Empty headline="No contacts identified" checked="contacts for this business" />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Hash</th><th>Verification</th><th>Subscriber type</th><th>Suppressed</th></tr></thead>
                    <tbody>
                      {d.contacts.map((c) => (
                        <tr key={c.id}>
                          {/* ⛔ The hash, never the address. This screen is read
                              by operators and the email itself is not needed to
                              answer any question it exists to answer. */}
                          <td className="mono muted">{c.emailHash.slice(0, 16)}…</td>
                          <td className="muted">{c.verification ?? "—"}</td>
                          <td className="muted">{c.subscriberType ?? "—"}</td>
                          <td>
                            {c.suppressed
                              ? <State state="not_applicable" label={c.suppressionReason ?? "suppressed"} />
                              : <span className="muted">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="section">
              <Eyebrow
                count={d.decisions.length}
                note="every send considered, allowed or denied, with the rule that decided it"
              >
                Gate decisions
              </Eyebrow>
              {d.decisions.length === 0 ? (
                <Empty headline="No send was ever considered" checked="gate_decisions joined via this business's contacts" />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th className="num">When</th><th>Verdict</th><th>Rule</th><th className="wrap">Reason</th>
                        <th>Channel</th><th>Class</th><th>Jurisdiction</th><th>Legal basis</th><th>Config</th></tr>
                    </thead>
                    <tbody>
                      {d.decisions.map((x) => (
                        <tr key={x.id}>
                          <td className="num muted">{shortAge(x.decidedAt)}</td>
                          <td><State state={x.allow ? "ok" : "attention"} label={x.allow ? "allowed" : "denied"} /></td>
                          <td className="mono muted">{x.ruleId ?? "—"}</td>
                          <td className="wrap">{x.reason ?? "—"}</td>
                          <td className="muted">{x.channel ?? "—"}</td>
                          <td className="muted">{x.messageClass ?? "—"}</td>
                          <td className="muted">{x.jurisdiction ?? "—"}</td>
                          <td className="muted">{x.legalBasis ?? "—"}</td>
                          <td className="mono muted" style={{ fontSize: "var(--t-small)" }}>{x.configVersion ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="section">
              <Eyebrow count={d.messages.length}>Messages</Eyebrow>
              {d.messages.length === 0 ? (
                <Empty headline="Nothing was ever sent" checked="messages joined via conversations and leads for this business" />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th className="num">Sent</th><th>Direction</th><th className="wrap">Subject</th><th>Gate decision</th></tr></thead>
                    <tbody>
                      {d.messages.map((m) => (
                        <tr key={m.id}>
                          <td className="num muted">{shortAge(m.sentAt)}</td>
                          <td className="muted">{m.direction ?? "—"}</td>
                          <td className="wrap">{m.subject ?? "—"}</td>
                          {/* ⛔ An outbound message with no gate_decision_id is a
                              send that bypassed the only route to transport —
                              the single worst invariant breach in the system. */}
                          <td>
                            {m.gateDecisionId === null && m.direction !== "inbound"
                              ? <State state="unknown" label="NO GATE DECISION" />
                              : <span className="mono muted" style={{ fontSize: "var(--t-small)" }}>
                                  {m.gateDecisionId?.slice(0, 8) ?? "—"}
                                </span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {d.previews.length === 0 ? null : (
              <section className="section">
                <Eyebrow count={d.previews.length}>Previews</Eyebrow>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th className="num">Generated</th><th>Claimed</th><th className="num">Expires</th><th>Taken down</th><th className="wrap">URL</th></tr></thead>
                    <tbody>
                      {d.previews.map((p) => (
                        <tr key={p.id}>
                          <td className="num muted">{shortAge(p.generatedAt)}</td>
                          <td>{p.claimedAt === null ? <span className="muted">—</span> : <State state="ok" label={shortAge(p.claimedAt)} />}</td>
                          <td className="num muted">{p.expiresAt === null ? "—" : shortAge(p.expiresAt)}</td>
                          <td className="muted">{p.takedownAt === null ? "—" : shortAge(p.takedownAt)}</td>
                          <td className="wrap muted" style={{ fontSize: "var(--t-small)" }}>{p.deployUrl ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <p className="figure-evidence"><Link to="/outreach">← all businesses</Link></p>
          </>
        );
      }}
    </Board>
  );
}

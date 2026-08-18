// Agents — ADW's own roster, and per-agent control.
//
// ⛔ Not the Models view. Models answers "which model is champion for this
// role and what does it cost". This answers "what is this agent allowed to do,
// how often does it work first time, how often has it seen something that
// looked like a prompt injection, and how do I stop it".
//
// ⛔ And not the deployed agent either — that is the one shipped to a customer's
// site, and it has its own screen. Conflating the two is why neither existed.
//
// The per-agent halt is `HALT_AGENT:<role>`, which the gate has read correctly
// for some time with nothing anywhere able to set it. An incident response that
// requires an operator to open psql is not an incident response.

import { useState } from "react";
import {
  AsOf, Board, Empty, Eyebrow, Failed, FigureTile, Figures, State, ViewHead,
  money, shortAge, usePoll,
} from "../primitives.tsx";
import { api, isOk, type AgentBoard, type AgentRow, type Invocation } from "../api.ts";

/** Capabilities that let an agent affect the outside world, rather than only read. */
const WRITE_CAPS = new Set([
  "write:draft", "write:exception", "write:vendor_state", "send:gated",
  "deploy:preview", "deploy:site", "propose:price", "provision:scoped", "trigger:remediation",
]);

export function Agents() {
  const [board, reload] = usePoll(() => api.agents(30), 30_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const halt = async (row: AgentRow, engage: boolean) => {
    const name = `HALT_AGENT:${row.role}`;
    if (engage && !window.confirm(
      `Engage ${name}?\n\nEvery call to the ${row.role} role will be refused at the gateway until released. ` +
      `Other agents are unaffected — this switch is exact-match, never a prefix.`,
    )) return;
    setPending(row.id);
    await api.toggleKillSwitch(name, engage);
    setPending(null);
    reload();
  };

  return (
    <>
      <ViewHead
        title="Agents"
        blurb="ADW's own agents: what each is permitted to do, how it is behaving, and how to stop it. The agent deployed to customers is a separate screen."
        right={<AsOf at={board.status === "ok" ? board.at : null} />}
      />

      <Board what="The agent roster" result={board}>
        {(data: AgentBoard) => {
          const halted = data.agents.filter((a) => a.halted);
          const injections = data.agents.reduce((n, a) => n + a.activity.injectionSuspected, 0);
          const escalations = data.agents.reduce((n, a) => n + a.activity.escalations, 0);
          const ran = data.agents.filter((a) => a.activity.invocations > 0);
          const overallFirstPass =
            data.totalInvocations === 0
              ? null
              : ran.reduce((n, a) => n + (a.activity.firstPassRate ?? 0) * a.activity.invocations, 0) /
                data.totalInvocations;

          return (
            <>
              <section className="section">
                <Figures>
                  <FigureTile
                    label="Agents defined"
                    value={data.agents.length}
                    evidence={`${data.neverInvoked} have never been invoked · from code, not a table`}
                  />
                  <FigureTile
                    label="First-pass rate"
                    // ⛔ Null over zero invocations. 100% is the most misleading
                    // possible rendering of "nothing has run".
                    value={overallFirstPass === null ? null : `${(overallFirstPass * 100).toFixed(1)}%`}
                    evidence={
                      data.totalInvocations === 0
                        ? "no invocations recorded in the window"
                        : `${data.totalInvocations.toLocaleString()} invocations · last ${data.windowDays}d`
                    }
                  />
                  <FigureTile
                    label="Injection suspected"
                    value={injections}
                    evidence={
                      injections === 0
                        ? `none in ${data.totalInvocations.toLocaleString()} invocations`
                        : "an agent saw text that looked like an instruction to it"
                    }
                  />
                  <FigureTile
                    label="Halted"
                    value={halted.length === 0 ? "none" : halted.map((a) => a.role).join(", ")}
                    evidence={`${data.agents.length} roles · HALT_AGENT is exact-match, never a prefix`}
                  />
                </Figures>
              </section>

              <section className="section">
                <Eyebrow
                  count={data.agents.length}
                  note={`${escalations} escalations · last ${data.windowDays} days`}
                >
                  Roster
                </Eyebrow>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>Class</th>
                        <th className="wrap">Capabilities</th>
                        <th className="num">Budget</th>
                        <th className="num">Runs</th>
                        <th className="num">First pass</th>
                        <th className="num">Esc</th>
                        <th className="num">Inj</th>
                        <th className="num">Last run</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.agents.map((a) => {
                        const writes = a.capabilities.filter((c) => WRITE_CAPS.has(c));
                        return (
                          <tr key={a.id}>
                            <td>
                              <button
                                className="linklike"
                                onClick={() => setSelected(selected === a.id ? null : a.id)}
                              >
                                {a.id}
                              </button>
                              <span className="cell-sub">
                                {a.role}
                                {a.hasClamp ? " · clamped" : ""}
                                {a.hasEscalation ? " · can escalate" : ""}
                              </span>
                            </td>
                            {/* ⛔ PAY class must never appear here — no agent may
                                see payment data — so showing the class per agent
                                makes that checkable at a glance. */}
                            <td className={a.dataClass === "PAY" ? "" : "muted"}>
                              {a.dataClass === "PAY" ? <State state="unknown" label="PAY" /> : a.dataClass}
                            </td>
                            <td className="wrap muted" style={{ maxWidth: 280 }}>
                              {writes.length === 0 ? (
                                <span>read-only ({a.capabilities.length})</span>
                              ) : (
                                <span title={a.capabilities.join(", ")}>{writes.join(", ")}</span>
                              )}
                            </td>
                            <td className="num muted">{a.budgetUsdPerPassingOutput.toFixed(3)}</td>
                            <td className="num">
                              {a.activity.invocations === 0 ? "—" : a.activity.invocations.toLocaleString()}
                            </td>
                            <td className="num">
                              {a.activity.firstPassRate === null
                                ? "—"
                                : `${(a.activity.firstPassRate * 100).toFixed(0)}%`}
                            </td>
                            <td className="num">{a.activity.escalations === 0 ? "—" : a.activity.escalations}</td>
                            <td className="num" style={a.activity.injectionSuspected > 0 ? { color: "var(--bad)", fontWeight: 600 } : {}}>
                              {a.activity.injectionSuspected === 0 ? "—" : a.activity.injectionSuspected}
                            </td>
                            <td className="num muted">{shortAge(a.activity.lastRunAt)}</td>
                            <td>
                              <button
                                className="btn"
                                data-tone={a.halted ? undefined : "danger"}
                                disabled={pending === a.id}
                                onClick={() => void halt(a, !a.halted)}
                              >
                                {pending === a.id ? "…" : a.halted ? "Release" : "Halt"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="coverage">
                  <span>
                    Capabilities are declared in code and structurally limited: <b>write:config</b>,{" "}
                    <b>write:suppression</b>, <b>write:registry</b>, <b>charge:money</b> and{" "}
                    <b>write:tos_acceptance</b> are not members of the capability union, so no agent
                    can be given them by configuration.
                  </span>
                </div>
              </section>

              {selected === null ? null : <InvocationLog agentId={selected} />}
              <FlaggedInvocations />
            </>
          );
        }}
      </Board>
    </>
  );
}

function InvocationLog({ agentId }: { agentId: string }) {
  const [log] = usePoll(() => api.agentInvocations({ agentId, limit: 50 }), 30_000);
  return (
    <section className="section">
      <Eyebrow note="newest first">{agentId} — recent invocations</Eyebrow>
      <Board what="The invocation log" result={log}>
        {(d: { invocations: Invocation[] }) =>
          d.invocations.length === 0 ? (
            <Empty
              headline="No invocations recorded"
              checked={`agent_invocations for ${agentId} — the ledger is written by the agent framework itself on every run`}
            />
          ) : (
            <InvocationTable rows={d.invocations} />
          )
        }
      </Board>
    </section>
  );
}

/**
 * ⛔ Always on screen, not behind a filter. These are the invocations where
 * something went differently — a suspected injection, an escalation, or a
 * champion that failed to produce valid output first try. Before this ledger
 * existed all three were computed and discarded.
 */
function FlaggedInvocations() {
  const [inj] = usePoll(() => api.agentInvocations({ injection: true, limit: 50 }), 60_000);
  return (
    <section className="section">
      <Eyebrow>Injection suspected</Eyebrow>
      <Board what="Flagged invocations" result={inj}>
        {(d: { invocations: Invocation[] }) =>
          d.invocations.length === 0 ? (
            <Empty
              headline="No agent has flagged a suspected injection"
              checked="agent_invocations where injection_suspected — an append-only ledger, written on every agent run"
            />
          ) : (
            <InvocationTable rows={d.invocations} />
          )
        }
      </Board>
    </section>
  );
}

function InvocationTable({ rows }: { rows: Invocation[] }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>When</th><th>Agent</th><th>Model</th><th>Class</th>
            <th className="num">Cost</th><th className="num">Took</th>
            <th>Outcome</th><th className="wrap">Subject / trace</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.id}>
              <td className="num muted">{shortAge(i.createdAt)}</td>
              <td className="mono">{i.agentId}</td>
              <td className="muted">{i.model}</td>
              <td className="muted">{i.dataClass}</td>
              <td className="num">{money(i.costCents)}</td>
              <td className="num muted">{i.durationMs === null ? "—" : `${i.durationMs}ms`}</td>
              <td>
                {i.injectionSuspected ? <State state="unknown" label="injection suspected" /> : null}
                {i.escalated ? (
                  <State state="attention" label={i.escalateReason ?? "escalated"} />
                ) : null}
                {!i.firstPass ? <State state="stale" label="retried" /> : null}
                {!i.injectionSuspected && !i.escalated && i.firstPass ? <State state="ok" label="clean" /> : null}
              </td>
              <td className="wrap muted mono" style={{ fontSize: "var(--t-small)" }}>
                {i.subjectId ?? "—"}
                {i.traceId === null ? null : <span className="cell-sub">trace {i.traceId}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── The deployed agent ────────────────────────────────────────────────────

export function DeployedAgents() {
  const [board] = usePoll(() => api.deployedAgents(200), 30_000);
  const [onlyBlocked, setOnlyBlocked] = useState(true);

  return (
    <>
      <ViewHead
        title="Deployed agents"
        blurb="The agent that ships with each customer's site. Whether it can answer at all, and what it is doing when it does."
        right={<AsOf at={board.status === "ok" ? board.at : null} />}
      />
      <Board what="The deployed agents" result={board}>
        {(data) => {
          const rows = onlyBlocked ? data.rows.filter((r) => !r.live) : data.rows;
          const turns = data.rows.reduce((n, r) => n + r.turns, 0);
          const deflected = data.rows.reduce((n, r) => n + r.answeredFromPack, 0);
          return (
            <>
              <section className="section">
                <Figures>
                  <FigureTile
                    label="Agents live"
                    value={`${data.liveCount} / ${data.totalCustomers}`}
                    evidence="a knowledge base, an approved pack and a resolved vertical — all three"
                    of={{ used: data.liveCount, cap: Math.max(1, data.totalCustomers) }}
                  />
                  <FigureTile
                    label="Conversations"
                    value={data.rows.reduce((n, r) => n + r.sessions, 0).toLocaleString()}
                    evidence={`${turns.toLocaleString()} turns across all customers`}
                  />
                  <FigureTile
                    label="Answered from the pack"
                    // ⛔ Null over zero turns, and refusals and protocol replies
                    // are excluded — counting those as deflection would inflate
                    // the one number this screen exists to report.
                    value={turns === 0 ? null : `${((deflected / turns) * 100).toFixed(1)}%`}
                    evidence={
                      turns === 0
                        ? "no turns recorded — nothing to measure"
                        : `${deflected.toLocaleString()} of ${turns.toLocaleString()} · refusals and protocol replies excluded`
                    }
                  />
                  <FigureTile
                    label="Open knowledge gaps"
                    value={data.rows.reduce((n, r) => n + r.openGaps, 0)}
                    evidence="questions asked that the pack could not answer"
                  />
                </Figures>
              </section>

              {data.liveCount === 0 && data.totalCustomers > 0 ? (
                <div className="failed" style={{ marginBottom: "var(--s2)" }}>
                  Not one customer agent can answer. Every customer is paying for a product that is
                  silently switched off — check the blocking reasons below before anything else.
                </div>
              ) : null}

              <section className="section">
                <Eyebrow
                  count={`${rows.length}/${data.rows.length}`}
                  note={
                    <label style={{ display: "inline-flex", gap: "var(--s0)", alignItems: "center", cursor: "pointer" }}>
                      <input
                        type="checkbox" checked={onlyBlocked} style={{ width: "auto" }}
                        onChange={(e) => setOnlyBlocked(e.target.checked)}
                      />
                      only agents that cannot answer
                    </label>
                  }
                >
                  Per customer
                </Eyebrow>
                {rows.length === 0 ? (
                  <Empty
                    headline={onlyBlocked ? "Every customer agent can answer" : "No customers"}
                    checked={`${data.totalCustomers} customers checked for knowledge base, approved pack and resolved vertical`}
                  />
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Customer</th><th>Status</th><th className="wrap">Blocked by</th>
                          <th className="num">Pack</th><th className="num">Pairs</th>
                          <th className="num">Sessions</th><th className="num">Turns</th>
                          <th className="num">Deflected</th><th className="num">Gaps</th>
                          <th className="num">Last seen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.customerId}>
                            <td>
                              {r.legalName}
                              <span className="cell-sub">{r.vertical ?? "vertical unresolved"}</span>
                            </td>
                            <td><State state={r.live ? "ok" : "attention"} label={r.live ? "answering" : "cannot answer"} /></td>
                            <td className="wrap">
                              {r.blockedBy.length === 0
                                ? <span className="muted">—</span>
                                : <span style={{ color: "var(--bad)" }}>{r.blockedBy.join(" · ")}</span>}
                            </td>
                            <td className="num muted">{r.packVersion === null ? "—" : `v${r.packVersion}`}</td>
                            <td className="num muted">{r.pairCount === 0 ? "—" : r.pairCount}</td>
                            <td className="num">{r.sessions === 0 ? "—" : r.sessions}</td>
                            <td className="num">{r.turns === 0 ? "—" : r.turns}</td>
                            <td className="num">
                              {r.deflectionRate === null ? "—" : `${(r.deflectionRate * 100).toFixed(0)}%`}
                            </td>
                            <td className="num">{r.openGaps === 0 ? "—" : r.openGaps}</td>
                            <td className="num muted">{shortAge(r.lastSessionAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          );
        }}
      </Board>
    </>
  );
}

export { isOk };

// Models — the registry's champions beside what each role actually costs.
//
// ⛔ Two tables that belong on one screen. The champion for a role and the
// money that role is spending were in different places, so "the developer role
// is eating the budget" and "the developer champion changed on Tuesday" were
// two separate investigations. The eval age matters for the same reason: a
// champion chosen against a six-month-old eval is a champion nobody has
// checked, and that is invisible unless the age is on the row.

import { AsOf, Board, Empty, Eyebrow, State, ViewHead, money, shortAge, usePoll } from "../primitives.tsx";
import { api, type ModelsBoard, type RoleCost } from "../api.ts";

/** Mirrors RegistryStatus from @adw/registry. */
interface RegistryRow {
  role: string;
  champion: string | null;
  championSince: string | null;
  championMetric: number | null;
  hasEvalRun: boolean;
  championEvalRunId: string | null;
  status: string;
  fallbackLastOk: string | null;
  escalation: string[];
}

/**
 * ⛔ A champion with no eval behind it is `unknown`, not `ok`. The registry's
 * whole promise is that a champion was chosen by a stored eval run, and a role
 * where that is not true is a role nobody has checked — which reads as a
 * question mark, never as a tick.
 */
function evalState(row: RegistryRow): string {
  if (row.champion === null) return "unknown";
  if (!row.hasEvalRun) return "unknown";
  if (row.championSince === null) return "ok";
  const days = (Date.now() - new Date(row.championSince).getTime()) / 86_400_000;
  return days > 90 ? "stale" : "ok";
}

export function Models() {
  const [board] = usePoll(() => api.models(), 60_000);

  return (
    <>
      <ViewHead
        title="Models"
        blurb="Which model is champion for each role, how old the eval behind it is, and what that role costs per passing output."
        right={<AsOf at={board.status === "ok" ? board.at : null} />}
      />
      <Board what="The model board" result={board}>
        {(data: ModelsBoard) => {
          const registry = data.registry as unknown as RegistryRow[];
          const costByRole = new Map<string, RoleCost>();
          for (const c of data.cost) {
            const existing = costByRole.get(c.role);
            if (existing === undefined || c.costCents > existing.costCents) costByRole.set(c.role, c);
          }
          const totalCents = data.cost.reduce((n, c) => n + c.costCents, 0);
          const unattributed = data.cost.find((c) => c.role === "(unattributed)");

          return (
            <>
              <section className="section">
                <Eyebrow
                  count={registry.length}
                  note={`${money(totalCents)} USD across ${data.cost.reduce((n, c) => n + c.calls, 0).toLocaleString()} calls · ${data.window}`}
                >
                  Roles
                </Eyebrow>
                {registry.length === 0 ? (
                  <Empty headline="No roles registered" checked="registry_roles — the eval harness writes this table" />
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Role</th>
                          <th>Champion</th>
                          <th>Eval</th>
                          <th className="num">Since</th>
                          <th className="num">Calls</th>
                          <th className="num">Spend</th>
                          <th className="num">Per call</th>
                        </tr>
                      </thead>
                      <tbody>
                        {registry.map((r) => {
                          const cost = costByRole.get(r.role);
                          return (
                            <tr key={r.role}>
                              <td className="mono">{r.role}</td>
                              <td>
                                {r.champion ?? <span style={{ color: "var(--bad)" }}>none</span>}
                              </td>
                              <td>
                                <State
                                  state={evalState(r)}
                                  label={
                                    r.champion === null
                                      ? "no champion"
                                      : !r.hasEvalRun
                                        ? "no eval run"
                                        : r.championSince === null
                                          ? "recorded"
                                          : `${Math.round((Date.now() - new Date(r.championSince).getTime()) / 86_400_000)}d old`
                                  }
                                />
                              </td>
                              <td className="num muted">{shortAge(r.championSince)}</td>
                              {/* ⛔ Zero calls is a real reading, not a blank: a
                                  role nothing invokes is either dead code or a
                                  workflow that has stopped reaching it. */}
                              <td className="num">{cost === undefined ? "—" : cost.calls.toLocaleString()}</td>
                              <td className="num">{cost === undefined ? "—" : money(cost.costCents)}</td>
                              <td className="num muted">{cost === undefined ? "—" : (cost.perCallCents / 100).toFixed(4)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {unattributed === undefined ? null : (
                <div className="failed">
                  {unattributed.calls.toLocaleString()} model calls ({money(unattributed.costCents)} USD)
                  carry no role attribution. Spend that cannot be attributed cannot be capped.
                </div>
              )}
            </>
          );
        }}
      </Board>
    </>
  );
}

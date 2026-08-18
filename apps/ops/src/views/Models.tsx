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

interface RegistryRow {
  role: string;
  champion: string | null;
  since?: string | null;
  metric?: number | null;
  champion_eval_run_id?: string | null;
  eval_age_days?: number | null;
  [k: string]: unknown;
}

/** An eval older than a quarter is stale; a champion with no eval at all is worse. */
function evalState(row: RegistryRow): string {
  if (row.champion === null || row.champion === undefined) return "unknown";
  if (row.champion_eval_run_id === null || row.champion_eval_run_id === undefined) return "unknown";
  const age = row.eval_age_days;
  if (age === null || age === undefined) return "ok";
  return age > 90 ? "stale" : "ok";
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
                                    r.champion_eval_run_id === null || r.champion_eval_run_id === undefined
                                      ? "no eval run"
                                      : r.eval_age_days === null || r.eval_age_days === undefined
                                        ? "recorded"
                                        : `${Math.round(r.eval_age_days)}d old`
                                  }
                                />
                              </td>
                              <td className="num muted">{r.since === null || r.since === undefined ? "—" : shortAge(r.since)}</td>
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

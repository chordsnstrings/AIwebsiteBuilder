// Fleet — sending assets and deliverability.
//
// ⛔ Every rate on this screen carries the count it was divided by, and is
// withheld entirely when that count is zero. A 0.00% complaint rate over four
// sends is not a healthy fleet, it is an unmeasured one, and the two are
// indistinguishable once the denominator is dropped — which is exactly how a
// fleet gets to the point of being blocked while its dashboard reads green.

import { AsOf, Board, Empty, Eyebrow, FigureTile, Figures, State, ViewHead, rate, shortAge, usePoll } from "../primitives.tsx";
import { api, type FleetBoard } from "../api.ts";

interface Asset {
  id: string; kind: string; provider: string; identifier: string; domain_class: string;
  pool: string; health: string; daily_cap: number; sends_today: number;
  warmup_started: string | null; first_send_at: string | null;
}

/** Health names from the fleet package mapped onto the console's five states. */
const HEALTH_STATE: Record<string, string> = {
  healthy: "ok",
  warming: "ok",
  watch: "stale",
  warn: "stale",
  throttled: "stale",
  // ⛔ Halted and quarantined are red, not amber. An asset that is not sending
  // is not "a bit unwell" — it is capacity the fleet no longer has, and amber
  // is the colour an operator scrolls past.
  halted: "failing",
  quarantined: "failing",
  retired: "not_applicable",
};

export function Fleet() {
  const [board] = usePoll(() => api.fleet(), 30_000);

  return (
    <>
      <ViewHead
        title="Fleet"
        blurb="Sending assets, warm-up progress and deliverability against the thresholds that throttle them."
        right={<AsOf at={board.status === "ok" ? board.at : null} />}
      />
      <Board what="The fleet" result={board}>
        {(data: FleetBoard) => {
          const assets = data.assets as unknown as Asset[];
          const sent = data.deliverability.sent;
          return (
            <>
              <section className="section">
                <Eyebrow note={data.window}>Deliverability</Eyebrow>
                <Figures>
                  <FigureTile
                    label="Messages sent"
                    value={sent.toLocaleString()}
                    evidence={`events of type email.sent · ${data.window}`}
                  />
                  <FigureTile
                    label="Bounce rate"
                    // ⛔ Null, not 0, when nothing was sent.
                    value={sent === 0 ? null : rate(data.deliverability.bounced, sent)}
                    evidence={
                      sent === 0
                        ? "not measurable — nothing was sent in this window"
                        : `${data.deliverability.bounced} of ${sent.toLocaleString()}`
                    }
                  />
                  <FigureTile
                    label="Complaint rate"
                    value={sent === 0 ? null : rate(data.deliverability.complained, sent, 3)}
                    evidence={
                      sent === 0
                        ? "not measurable — nothing was sent in this window"
                        : `${data.deliverability.complained} of ${sent.toLocaleString()}`
                    }
                  />
                  <FigureTile
                    label="Active assets"
                    value={assets.length}
                    evidence={`${data.retired} retired and not shown`}
                  />
                </Figures>
              </section>

              <section className="section">
                <Eyebrow count={assets.length}>Sending assets</Eyebrow>
                {assets.length === 0 ? (
                  <Empty
                    headline="No sending assets provisioned"
                    checked="sending_assets, excluding retired — nothing can be sent until at least one exists"
                  />
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Address</th>
                          <th>Pool</th>
                          <th>Provider</th>
                          <th>Class</th>
                          <th>Health</th>
                          <th className="num">Today</th>
                          <th className="num">Cap</th>
                          <th className="num">Warming</th>
                        </tr>
                      </thead>
                      <tbody>
                        {assets.map((a) => (
                          <tr key={a.id}>
                            <td className="mono">{a.identifier}</td>
                            <td className="muted">{a.pool}</td>
                            <td className="muted">{a.provider}</td>
                            <td className="muted">{a.domain_class}</td>
                            <td><State state={HEALTH_STATE[a.health] ?? "stale"} label={a.health} /></td>
                            <td className="num">{a.sends_today}</td>
                            <td className="num muted">{a.daily_cap}</td>
                            <td className="num muted">
                              {a.warmup_started === null ? "—" : shortAge(a.warmup_started)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="coverage">
                  <span>
                    Warm-up runs 21 days and is never compressible. Open rates are deliberately not
                    a metric here — they are measured by tracking pixels, which this system does not
                    set.
                  </span>
                </div>
              </section>
            </>
          );
        }}
      </Board>
    </>
  );
}

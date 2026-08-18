// Now — the home surface.
//
// It opens on three questions, in the order an operator asks them:
//
//   1. What needs me?      (merged across six tables that each had no screen)
//   2. Is it running?      (the recurring work, judged on last SUCCESS)
//   3. What is it spending? (the money this system commits on its own)
//
// ⛔ What it deliberately does NOT open on: MRR and a customer count. Those
// were the old home board's two biggest numbers, and there is nothing an
// operator does about either at three in the morning. Subscription revenue is
// still here — at the bottom, small, as context.

import { Link } from "react-router-dom";
import {
  AsOf, Board, Empty, Eyebrow, Failed, FigureTile, Figures, State,
  cadence, money, shortAge, usePoll,
} from "../primitives.tsx";
import { api, type Band, type JobRow, type NowPayload, type SpendBoard, type Worklist } from "../api.ts";

/** How many worklist rows the home surface shows before it says "and N more". */
const TRIAGE_LIMIT = 20;

const SOURCE_LABEL: Record<string, string> = {
  protocol_incident: "safety protocols",
  exception: "exceptions",
  qa_pack: "Q&A packs",
  publication: "publications",
  asset: "asset spend",
  opportunity_gate: "enterprise deals",
};

export function Now() {
  const [now] = usePoll(() => api.now(), 15_000);

  return (
    <>
      <header className="view-head">
        <div>
          <h1>Now</h1>
          <p>What needs a decision, whether the work is running, and what it is spending.</p>
        </div>
        <AsOf at={now.status === "ok" ? now.at : null} />
      </header>

      <Board what="This page" result={now}>
        {(payload: NowPayload) => (
          <>
            <NeedsYou band={payload.worklist} />
            <IsItRunning band={payload.jobs} />
            <MoneyInFlight band={payload.spend} />
          </>
        )}
      </Board>
    </>
  );
}

// ── Band 1: what needs a person ───────────────────────────────────────────

function NeedsYou({ band }: { band: Band<Worklist> }) {
  if (!band.ok) {
    return (
      <section className="section">
        <Eyebrow>Needs you</Eyebrow>
        <Failed what="The worklist" reason={band.error} />
      </section>
    );
  }
  const { items, coverage, truncated } = band.data;
  const healthy = coverage.filter((c) => c.ok);
  const broken = coverage.filter((c) => !c.ok);
  const considered = healthy.reduce((n, c) => n + c.considered, 0);
  // ⛔ Capped. This band is for triage, not for holding the queue: rendering
  // two hundred rows produces a screen nobody scrolls to the bottom of, which
  // is functionally the same as not showing them. The count below says exactly
  // how many are not on screen, so the cap is visible rather than silent.
  const shown = items.slice(0, TRIAGE_LIMIT);
  // ⛔ `truncated` is what the READ MODEL dropped before this component ever saw
  // it — the API caps the list so one runaway source cannot make the response
  // unusable. Counting only the rows this view hides would report "and 180
  // more" while several hundred sat behind the server-side cap, and an operator
  // who worked to the bottom would believe they had reached the end.
  const hidden = items.length - shown.length + truncated;
  const waiting = items.length + truncated;

  return (
    <section className="section">
      <Eyebrow
        count={waiting}
        note={`${healthy.length} of ${coverage.length} sources answered`}
      >
        Needs you
      </Eyebrow>

      {waiting === 0 ? (
        <Empty
          headline="Nothing is waiting on a person"
          checked={`${healthy.length} sources checked over ${considered.toLocaleString()} rows${
            broken.length > 0 ? ` · ${broken.length} source(s) failed and are NOT included` : ""
          }`}
        />
      ) : (
        <div>
          {shown.map((item) => (
            <article
              key={item.key}
              className="work-row rise"
              data-sev={Math.min(3, Math.max(1, item.severity))}
            >
              <span className="work-sev">S{item.severity}</span>
              {/* Two lines, not four. A triage row that takes 150px means eight
                  fit on a screen, and an operator scrolling a queue is no longer
                  triaging it. Customer sits with the title; the blocker sits
                  with the detail. */}
              <div>
                <div className="work-title">
                  {item.title}
                  {item.customerName === null ? null : (
                    <span className="work-who"> · {item.customerName}</span>
                  )}
                </div>
                <div className="work-detail">
                  {item.detail}
                  {item.blocking === null ? null : (
                    <span className="work-blocking"> · blocks {item.blocking}</span>
                  )}
                </div>
              </div>
              <span className="work-source">{SOURCE_LABEL[item.source] ?? item.source}</span>
              <span className="work-age" title={new Date(item.waitingSince).toISOString()}>
                {shortAge(item.waitingSince)}
              </span>
            </article>
          ))}
          {hidden > 0 ? (
            <p className="figure-evidence" style={{ padding: "var(--s1)" }}>
              and {hidden.toLocaleString()} more, less severe or more recent — the {TRIAGE_LIMIT} above
              are the most severe, oldest first.
              {truncated > 0
                ? ` ${truncated.toLocaleString()} of them are past the server's cap and are not in this response at all.`
                : ""}
            </p>
          ) : null}
        </div>
      )}

      {/* ⛔ The coverage strip renders whether the list is empty or full. It is
          the only thing separating "nothing needs you" from "the queries that
          would have told you threw". */}
      <div className="coverage">
        {coverage.map((c) => (
          <span key={c.source} data-failed={!c.ok}>
            {SOURCE_LABEL[c.source] ?? c.source}{" "}
            {c.ok ? (
              <>
                <b>{c.waiting}</b> of <b>{c.considered.toLocaleString()}</b>
              </>
            ) : (
              <b>failed: {c.error ?? "unknown"}</b>
            )}
          </span>
        ))}
      </div>
    </section>
  );
}

// ── Band 2: is the recurring work running ─────────────────────────────────

function IsItRunning({ band }: { band: Band<JobRow[]> }) {
  if (!band.ok) {
    return (
      <section className="section">
        <Eyebrow>Is it running</Eyebrow>
        <Failed what="The job board" reason={band.error} />
      </section>
    );
  }
  const jobs = band.data;
  const unhealthy = jobs.filter((j) => j.state !== "ok");

  if (jobs.length === 0) {
    return (
      <section className="section">
        <Eyebrow>Is it running</Eyebrow>
        {/* ⛔ No rows means the worker has never registered its roster — i.e.
            it has never started. That is the loudest possible finding on this
            band and must not read as "all quiet". */}
        <Failed
          what="The job roster"
          reason="no job has ever registered, which means the worker process has never started"
        />
      </section>
    );
  }

  return (
    <section className="section">
      <Eyebrow
        count={`${jobs.length - unhealthy.length}/${jobs.length}`}
        note={unhealthy.length === 0 ? "all succeeding within their own cadence" : `${unhealthy.length} not succeeding`}
      >
        Is it running
      </Eyebrow>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Job</th>
              <th>State</th>
              <th>Cadence</th>
              <th className="num">Last success</th>
              <th className="num">Last run</th>
              <th className="num">Runs</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {[...jobs]
              .sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name))
              .map((j) => (
                <tr key={j.name}>
                  <td className="mono">{j.name}</td>
                  <td><State state={j.state} /></td>
                  <td className="muted">{cadence(j.intervalMs)}</td>
                  {/* ⛔ Success and run are separate columns because they were
                      once the same column, and a job failing every ten seconds
                      looked exactly as fresh as one that was working. */}
                  <td className="num">{shortAge(j.lastSuccessAt)}</td>
                  <td className="num muted">{shortAge(j.lastRunAt)}</td>
                  <td className="num muted">
                    {j.runsTotal.toLocaleString()}
                    {j.failuresTotal > 0 ? <span className="cell-sub">{j.failuresTotal} failed</span> : null}
                  </td>
                  <td className="wrap muted">{j.lastError ?? ""}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const rank = (s: string) => (s === "failing" ? 0 : s === "never_run" ? 1 : s === "stale" ? 2 : 3);

// ── Band 3: money in flight ───────────────────────────────────────────────

function MoneyInFlight({ band }: { band: Band<SpendBoard> }) {
  if (!band.ok) {
    return (
      <section className="section">
        <Eyebrow>Money in flight</Eyebrow>
        <Failed what="Spend" reason={band.error} />
      </section>
    );
  }
  const s = band.data;
  const overCap = s.assetBudgets.filter((b) => b.spentCents >= b.capCents * 0.8);

  return (
    <section className="section">
      <Eyebrow note="what the system commits on its own initiative">Money in flight</Eyebrow>
      <Figures>
        <FigureTile
          label="Model spend today"
          value={money(s.gatewayToday.cents)}
          unit="USD"
          evidence={`${s.gatewayToday.rows.toLocaleString()} calls · ${s.gatewayToday.window}`}
          of={s.gatewayToday.capCents === null ? undefined : { used: s.gatewayToday.cents, cap: s.gatewayToday.capCents }}
        />
        <FigureTile
          label="Model spend this month"
          value={money(s.gatewayMonth.cents)}
          unit="USD"
          evidence={`${s.gatewayMonth.rows.toLocaleString()} calls · no ceiling configured`}
        />
        <FigureTile
          label="Asset generation"
          value={money(s.assetsMonth.cents)}
          unit="USD"
          evidence={`${s.assetsMonth.rows.toLocaleString()} approved, generating or ready · month to date`}
        />
        <FigureTile
          label="Subscription revenue"
          value={money(s.activeSubscriptions.monthlyCents)}
          unit="USD/mo"
          evidence={`${s.activeSubscriptions.count} active subscriptions · context, not an alarm`}
        />
      </Figures>

      {overCap.length === 0 ? null : (
        <>
          <Eyebrow count={overCap.length} note="at or above 80% of their monthly cap">
            Asset budgets running out
          </Eyebrow>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Customer</th><th className="num">Spent</th><th className="num">Cap</th><th className="num">Used</th></tr>
              </thead>
              <tbody>
                {overCap.map((b) => (
                  <tr key={b.customerId}>
                    <td><Link to={`/customers/${b.customerId}`}>{b.legalName}</Link></td>
                    <td className="num">{money(b.spentCents)}</td>
                    <td className="num muted">{money(b.capCents)}</td>
                    <td className="num">{b.capCents === 0 ? "—" : `${Math.round((b.spentCents / b.capCents) * 100)}%`}</td>
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

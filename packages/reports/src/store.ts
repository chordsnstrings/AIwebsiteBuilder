// Storing and serving the monthly value report — the half `@adw/reports` never
// had.
//
// ⛔ `generateValueReport` was correct and had no callers. This is what turns it
// from a function into a thing a customer receives: a monthly sweep that writes
// one report per closed month, and the reads the dashboard needs.
import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { generateValueReport, priorMonth, type ReportMonth, type ValueReport } from "./value-report.ts";

export interface StoredReport {
  customerId: string;
  month: ReportMonth;
  generatedAt: Date;
  report: ValueReport;
}

function toStored(r: { customer_id: string; period_year: number; period_month: number; report: unknown; generated_at: Date }): StoredReport {
  return {
    customerId: r.customer_id,
    month: { year: r.period_year, month: r.period_month },
    generatedAt: r.generated_at,
    report: r.report as ValueReport,
  };
}

const SELECT = `SELECT customer_id, period_year, period_month, report, generated_at FROM value_reports`;

export async function reportsFor(db: Db, customerId: string, limit = 12): Promise<StoredReport[]> {
  const res = await db.query<{ customer_id: string; period_year: number; period_month: number; report: unknown; generated_at: Date }>(
    `${SELECT} WHERE customer_id = $1 ORDER BY period_year DESC, period_month DESC LIMIT $2`,
    [customerId, Math.min(60, Math.max(1, limit))],
  );
  return res.rows.map(toStored);
}

export async function latestReport(db: Db, customerId: string): Promise<StoredReport | null> {
  const rows = await reportsFor(db, customerId, 1);
  return rows[0] ?? null;
}

/**
 * Write one month's report, once.
 *
 * ⛔ `ON CONFLICT DO NOTHING`, not `DO UPDATE`. A closed month's figures cannot
 * change, so a second generation of the same month is either a duplicate pass
 * (harmless, ignore it) or a restatement of numbers the customer has already
 * read (never do that silently). Returns whether this call was the one that
 * created it, so the job can report real work rather than an inflated count.
 */
export async function storeValueReport(
  db: Db,
  report: ValueReport,
  month: ReportMonth,
): Promise<{ stored: boolean }> {
  const res = await db.query(
    `INSERT INTO value_reports (customer_id, period_year, period_month, report)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (customer_id, period_year, period_month) DO NOTHING`,
    [report.customerId, month.year, month.month, JSON.stringify(report)],
  );
  const stored = (res.rowCount ?? 0) > 0;
  if (stored) {
    await emit({
      eventType: "value_report.generated",
      subject: { kind: "customer", id: report.customerId },
      payload: { year: month.year, month: month.month },
    });
  }
  return { stored };
}

export interface SweepOutcome {
  month: ReportMonth;
  /** Active customers considered this pass. */
  considered: number;
  generated: number;
  /** Already had a report for the month — the steady state after the first run. */
  skipped: number;
  errors: number;
}

/**
 * Generate last month's report for every active customer that lacks one.
 *
 * ⛔ Reports the LAST CLOSED month, never the current one. A report for a month
 * still in progress is a number that changes after the customer reads it, and
 * §58's whole premise is that every figure is checkable.
 *
 * ⛔ Denominators, not just counts: `considered` is reported alongside
 * `generated` so "0 generated" can be told apart from "0 customers". They mean
 * completely different things and a bare zero hides which one you have.
 */
export async function sweepValueReports(
  db: Db,
  now: Date = new Date(),
  opts: { limit?: number } = {},
): Promise<SweepOutcome> {
  const month = priorMonth({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });
  const customers = await db.query<{ id: string }>(
    `SELECT c.id FROM customers c
      WHERE c.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM value_reports v
           WHERE v.customer_id = c.id AND v.period_year = $1 AND v.period_month = $2
        )
      ORDER BY c.won_at ASC NULLS LAST
      LIMIT $3`,
    [month.year, month.month, Math.min(1000, Math.max(1, opts.limit ?? 200))],
  );

  const out: SweepOutcome = { month, considered: customers.rows.length, generated: 0, skipped: 0, errors: 0 };
  for (const c of customers.rows) {
    try {
      const report = await generateValueReport(db, c.id, month);
      const { stored } = await storeValueReport(db, report, month);
      if (stored) out.generated++;
      else out.skipped++;
    } catch {
      // ⛔ One customer's report failing must not stop the rest of the sweep,
      // and it must be COUNTED rather than swallowed — an error is not a
      // customer who had nothing to report.
      out.errors++;
    }
  }
  return out;
}

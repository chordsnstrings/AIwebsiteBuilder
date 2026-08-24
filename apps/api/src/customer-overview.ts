// Everything the customer dashboard's home, domain and billing screens need,
// in one round trip.
//
// ⛔ Nine of the dashboard's twelve views painted `demoCustomer` — a fixture
// business called Bright Plumbing with 342 visits, 28 calls and two paid
// invoices, none of which belonged to the person looking at the screen. The
// client had three live methods in total. Every figure on Home, Performance,
// Domain, Payments and Billing was someone else's, and it looked entirely
// convincing.
//
// One route rather than six because a dashboard that opens with six spinners
// and fails five of them is worse than one that fails once, honestly. Every
// figure here comes from a table; nothing is estimated and nothing is defaulted
// to a plausible-looking number — an absent figure is null and the screen says
// so.
import type { Db } from "@adw/db";

export interface CustomerOverview {
  customerId: string;
  businessName: string;
  /** Where the site actually is: their domain if the cutover ran, else the subdomain. */
  siteUrl: string | null;
  status: string;
  vertical: string | null;
  wonAt: Date;
  domain: { name: string; cutoverAt: Date | null } | null;
  subscription: {
    planCode: string;
    amountCents: number;
    currency: string;
    interval: string;
    status: string;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
  } | null;
  invoices: { id: string; amountCents: number; currency: string; status: string; issuedAt: Date; paidAt: Date | null }[];
  agent: {
    /** False means the site is up but the agent is not answering — a real state. */
    live: boolean;
    packVersion: number | null;
    approvedAt: Date | null;
    calendarConnected: boolean;
  };
  counts: {
    openEnquiries: number;
    emergencyEnquiries: number;
    upcomingBookings: number;
    openQueueItems: number;
    openGaps: number;
  };
  /** Last month's report, if the sweep has produced one. Null until it has. */
  latestReport: {
    year: number;
    month: number;
    visits: number;
    calls: number;
    formSubmissions: number;
    bookings: number;
  } | null;
}

/**
 * ⛔ `Promise.all`, not sequential awaits, and every query scoped by
 * `customer_id`. Nothing here reads a capped list and filters it: each count is
 * a `count(*)` over the whole population, because "3 open enquiries" computed
 * from the first page of a list is a number that silently stops growing.
 */
export async function customerOverview(db: Db, customerId: string, now: Date = new Date()): Promise<CustomerOverview | null> {
  const base = await db.maybeOne<{
    id: string; legal_name: string; status: string; won_at: Date;
    domain: string | null; vertical: string | null; business_name: string; business_vertical: string | null;
  }>(
    `SELECT c.id, c.legal_name, c.status, c.won_at, c.domain, c.vertical,
            b.name AS business_name, b.vertical AS business_vertical
       FROM customers c JOIN businesses b ON b.id = c.business_id
      WHERE c.id = $1`,
    [customerId],
  );
  if (base === null) return null;

  const [deploy, cutover, sub, invoices, pack, calendar, counts, report] = await Promise.all([
    db.maybeOne<{ deployed_url: string }>(
      `SELECT deployed_url FROM builds
        WHERE customer_id = $1 AND deployed_url IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [customerId],
    ),
    db.maybeOne<{ completed_at: Date | null }>(
      `SELECT completed_at FROM dns_cutovers WHERE customer_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [customerId],
    ).catch(() => null),
    db.maybeOne<{
      plan_code: string; amount_cents: number; currency: string; billing_interval: string;
      status: string; current_period_end: Date; cancel_at_period_end: boolean;
    }>(
      `SELECT plan_code, amount_cents, currency, billing_interval, status, current_period_end, cancel_at_period_end
         FROM subscriptions WHERE customer_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [customerId],
    ),
    db.query<{ id: string; amount_cents: number; currency: string; status: string; issued_at: Date; paid_at: Date | null }>(
      `SELECT id, amount_cents, currency, status, issued_at, paid_at
         FROM invoices WHERE customer_id = $1 ORDER BY issued_at DESC LIMIT 24`,
      [customerId],
    ),
    // ⛔ `approval_kind = 'owner'`, matching loadLiveAgent exactly. A
    // speculative approval must never render as "your agent is live".
    db.maybeOne<{ version: number; approved_at: Date }>(
      `SELECT version, approved_at FROM qa_packs
        WHERE customer_id = $1 AND approved_at IS NOT NULL AND approval_kind = 'owner'
        ORDER BY version DESC LIMIT 1`,
      [customerId],
    ),
    db.maybeOne<{ id: string }>(
      `SELECT id FROM customer_calendars WHERE customer_id = $1 AND revoked_at IS NULL LIMIT 1`,
      [customerId],
    ),
    db.one<{ enquiries: string; emergencies: string; bookings: string; queue: string; gaps: string }>(
      `SELECT
         (SELECT count(*) FROM enquiries
           WHERE customer_id = $1 AND status <> 'closed')                              AS enquiries,
         (SELECT count(*) FROM enquiries
           WHERE customer_id = $1 AND status <> 'closed' AND urgency = 'emergency')    AS emergencies,
         (SELECT count(*) FROM bookings
           WHERE customer_id = $1 AND status <> 'cancelled' AND slot_start >= $2)      AS bookings,
         (SELECT count(*) FROM exceptions
           WHERE customer_id = $1 AND resolved_at IS NULL)                             AS queue,
         (SELECT count(*) FROM agent_gaps
           WHERE customer_id = $1 AND status = 'open')                                 AS gaps`,
      [customerId, now],
    ),
    db.maybeOne<{ period_year: number; period_month: number; report: unknown }>(
      `SELECT period_year, period_month, report FROM value_reports
        WHERE customer_id = $1 ORDER BY period_year DESC, period_month DESC LIMIT 1`,
      [customerId],
    ),
  ]);

  const r = report?.report as
    | { visits?: number; calls?: number; formSubmissions?: number; bookings?: number }
    | undefined;

  return {
    customerId: base.id,
    businessName: base.business_name || base.legal_name,
    // Their own domain once the cutover completed, otherwise the subdomain the
    // site has been live on since deploy. Never a guess at a URL.
    siteUrl: base.domain !== null ? `https://${base.domain}` : (deploy?.deployed_url ?? null),
    status: base.status,
    vertical: base.vertical ?? base.business_vertical,
    wonAt: base.won_at,
    domain: base.domain === null ? null : { name: base.domain, cutoverAt: cutover?.completed_at ?? null },
    subscription: sub === null ? null : {
      planCode: sub.plan_code,
      amountCents: sub.amount_cents,
      currency: sub.currency,
      interval: sub.billing_interval,
      status: sub.status,
      currentPeriodEnd: sub.current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    },
    invoices: invoices.rows.map((i) => ({
      id: i.id, amountCents: i.amount_cents, currency: i.currency,
      status: i.status, issuedAt: i.issued_at, paidAt: i.paid_at,
    })),
    agent: {
      live: pack !== null,
      packVersion: pack?.version ?? null,
      approvedAt: pack?.approved_at ?? null,
      calendarConnected: calendar !== null,
    },
    counts: {
      openEnquiries: Number(counts.enquiries),
      emergencyEnquiries: Number(counts.emergencies),
      upcomingBookings: Number(counts.bookings),
      openQueueItems: Number(counts.queue),
      openGaps: Number(counts.gaps),
    },
    latestReport: report === null ? null : {
      year: report.period_year,
      month: report.period_month,
      visits: r?.visits ?? 0,
      calls: r?.calls ?? 0,
      formSubmissions: r?.formSubmissions ?? 0,
      bookings: r?.bookings ?? 0,
    },
  };
}

// Monthly value report (spec §58). The report a customer receives is the honest
// arithmetic of what their site did. Every figure on it is the result of a
// deterministic SQL query against the ledger — no model writes a number, no
// number is estimated, extrapolated or "modelled". If a metric has no data the
// figure is 0, not an approximation.
//
// The one editorial element is a single suggested action, chosen by a rule from
// the customer's own figures and carrying a one-word reply keyword that triggers
// it. The hard constraint (spec §58): in a month where metrics are DOWN there is
// no upsell. A worse month is not a sales opportunity — see `suggestFor`.
import type { Db } from "@adw/db";

/**
 * Event types the report reads. Visits, calls, bookings, payments, traffic
 * source, on-site queries and AI-assistant visibility have no dedicated table,
 * so each is derived from `events` under a documented type and returns 0 when
 * no rows exist. Form submissions come from `messages` (a real table), and
 * `builds` is read for suggestion context only.
 */
export const EVENT_TYPES = {
  /** One page view of the customer's live site. `payload.source` buckets the referrer. */
  visit: "site.visit",
  /** A tap on the tel: link in the rendered page. */
  call: "site.call_click",
  /** A booking completed through the site's booking widget. */
  booking: "site.booking",
  /** A payment captured through the site. `payload.amount_cents` is an integer string. */
  payment: "site.payment.succeeded",
  /** A search term that landed on the site. `payload.query`. */
  searchQuery: "site.search_query",
  /** One AI-assistant visibility probe. `payload.appears` is "true"/"false". */
  aiProbe: "ai.visibility.probe",
} as const;

/** The four traffic buckets. Anything unrecognised counts as direct, so the buckets sum to `visits`. */
export const TRAFFIC_SOURCES = ["direct", "search", "ai_assistants", "referral"] as const;

/** `messages.channel` used for a website contact-form submission. */
export const WEB_FORM_CHANNEL = "web_form";

export interface ReportMonth {
  year: number;
  /** 1-12. */
  month: number;
}

export interface ReportPeriod extends ReportMonth {
  /** Inclusive UTC start of the month, ISO-8601. */
  startsAt: string;
  /** Exclusive UTC end of the month, ISO-8601. */
  endsAt: string;
}

export interface ValueMetrics {
  visits: number;
  calls: number;
  formSubmissions: number;
  bookings: number;
  paymentsProcessedCents: number;
}

/** Month-on-month change, this month minus last month, per metric. */
export type MomDelta = ValueMetrics;

export interface TrafficSources {
  direct: number;
  search: number;
  aiAssistants: number;
  referral: number;
}

export interface AiVisibility {
  /** How many tracked assistants surfaced the site this month. */
  appearsIn: number;
  /** How many assistants were probed. 0 when no probes ran. */
  tracked: number;
}

export interface ValueSuggestion {
  text: string;
  /** One word. The customer replies with it to trigger the action. */
  replyKeyword: string;
  /**
   * Whether acting on this costs the customer money. Never true in a down
   * month — enforced in `suggestFor` and asserted in the tests.
   */
  upsell: boolean;
}

export interface ValueReport {
  customerId: string;
  period: ReportPeriod;
  visits: number;
  calls: number;
  formSubmissions: number;
  bookings: number;
  paymentsProcessedCents: number;
  momDelta: MomDelta;
  /** The prior month's figures, so every delta on the report is checkable. */
  previous: ValueMetrics;
  sources: TrafficSources;
  topQueries: string[];
  aiVisibility: AiVisibility;
  /** Exactly one action, or none. Never more than one. */
  suggestion: ValueSuggestion | null;
}

const METRIC_KEYS = [
  "visits",
  "calls",
  "formSubmissions",
  "bookings",
  "paymentsProcessedCents",
] as const satisfies readonly (keyof ValueMetrics)[];

const ZERO_METRICS: ValueMetrics = {
  visits: 0,
  calls: 0,
  formSubmissions: 0,
  bookings: 0,
  paymentsProcessedCents: 0,
};

/** Postgres returns bigint/numeric aggregates as strings; coerce without inventing values. */
function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** UTC bounds of a calendar month: [start, end). */
export function periodBounds(m: ReportMonth): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(m.year, m.month - 1, 1)),
    end: new Date(Date.UTC(m.year, m.month, 1)),
  };
}

/** The calendar month before `m`. */
export function priorMonth(m: ReportMonth): ReportMonth {
  return m.month === 1 ? { year: m.year - 1, month: 12 } : { year: m.year, month: m.month - 1 };
}

// ---------------------------------------------------------------------------
// Queries. One function per figure; each is plain SQL over columns that exist.
// ---------------------------------------------------------------------------

/** Counts per event type for one customer in one window. Absent types are simply absent. */
async function eventCounts(db: Db, customerId: string, start: Date, end: Date): Promise<Map<string, number>> {
  const res = await db.query<{ event_type: string; n: string }>(
    `SELECT event_type, count(*) AS n
       FROM events
      WHERE subject_kind = 'customer'
        AND subject_id = $1
        AND occurred_at >= $2
        AND occurred_at < $3
      GROUP BY event_type`,
    [customerId, start, end],
  );
  return new Map(res.rows.map((r) => [r.event_type, num(r.n)]));
}

/**
 * Total cents captured through the site. Only digit-only payload values count —
 * a malformed amount contributes 0 rather than corrupting the total.
 */
async function paymentsCents(db: Db, customerId: string, start: Date, end: Date): Promise<number> {
  const row = await db.one<{ cents: string | null }>(
    `SELECT COALESCE(SUM(
              CASE WHEN payload->>'amount_cents' ~ '^[0-9]+$'
                   THEN (payload->>'amount_cents')::numeric
                   ELSE 0 END), 0) AS cents
       FROM events
      WHERE subject_kind = 'customer'
        AND subject_id = $1
        AND event_type = $2
        AND occurred_at >= $3
        AND occurred_at < $4`,
    [customerId, EVENT_TYPES.payment, start, end],
  );
  return num(row.cents);
}

/** Contact-form submissions, from the real `messages` table via the customer's conversations. */
async function formSubmissions(db: Db, customerId: string, start: Date, end: Date): Promise<number> {
  const row = await db.one<{ n: string }>(
    `SELECT count(*) AS n
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.customer_id = $1
        AND m.direction = 'inbound'
        AND m.channel = $2
        AND m.sent_at >= $3
        AND m.sent_at < $4`,
    [customerId, WEB_FORM_CHANNEL, start, end],
  );
  return num(row.n);
}

/** Traffic split. Unrecognised/absent sources bucket to direct, so the four sum to `visits`. */
async function trafficSources(db: Db, customerId: string, start: Date, end: Date): Promise<TrafficSources> {
  const res = await db.query<{ bucket: string; n: string }>(
    `SELECT CASE
              WHEN payload->>'source' IN ('search', 'ai_assistants', 'referral')
              THEN payload->>'source'
              ELSE 'direct'
            END AS bucket,
            count(*) AS n
       FROM events
      WHERE subject_kind = 'customer'
        AND subject_id = $1
        AND event_type = $2
        AND occurred_at >= $3
        AND occurred_at < $4
      GROUP BY 1
      ORDER BY 1`,
    [customerId, EVENT_TYPES.visit, start, end],
  );
  const out: TrafficSources = { direct: 0, search: 0, aiAssistants: 0, referral: 0 };
  for (const r of res.rows) {
    if (r.bucket === "search") out.search = num(r.n);
    else if (r.bucket === "ai_assistants") out.aiAssistants = num(r.n);
    else if (r.bucket === "referral") out.referral = num(r.n);
    else out.direct += num(r.n);
  }
  return out;
}

/** The five most common on-site queries. Ties break on the query text so the order is stable. */
async function topQueries(db: Db, customerId: string, start: Date, end: Date): Promise<string[]> {
  const res = await db.query<{ query: string }>(
    `SELECT payload->>'query' AS query, count(*) AS n
       FROM events
      WHERE subject_kind = 'customer'
        AND subject_id = $1
        AND event_type = $2
        AND occurred_at >= $3
        AND occurred_at < $4
        AND COALESCE(payload->>'query', '') <> ''
      GROUP BY 1
      ORDER BY count(*) DESC, 1 ASC
      LIMIT 5`,
    [customerId, EVENT_TYPES.searchQuery, start, end],
  );
  return res.rows.map((r) => r.query);
}

/** Probe results: how many tracked assistants surfaced this site. Zero probes => 0/0. */
async function aiVisibility(db: Db, customerId: string, start: Date, end: Date): Promise<AiVisibility> {
  const row = await db.one<{ tracked: string; appears_in: string }>(
    `SELECT count(*) AS tracked,
            count(*) FILTER (WHERE payload->>'appears' = 'true') AS appears_in
       FROM events
      WHERE subject_kind = 'customer'
        AND subject_id = $1
        AND event_type = $2
        AND occurred_at >= $3
        AND occurred_at < $4`,
    [customerId, EVENT_TYPES.aiProbe, start, end],
  );
  return { appearsIn: num(row.appears_in), tracked: num(row.tracked) };
}

/** Builds shipped in the window. Not a reported figure — it only informs the suggestion. */
async function buildCount(db: Db, customerId: string, start: Date, end: Date): Promise<number> {
  const row = await db.one<{ n: string }>(
    `SELECT count(*) AS n
       FROM builds
      WHERE customer_id = $1
        AND created_at >= $2
        AND created_at < $3`,
    [customerId, start, end],
  );
  return num(row.n);
}

/** Every headline figure for one customer in one month. */
async function metricsFor(db: Db, customerId: string, m: ReportMonth): Promise<ValueMetrics> {
  const { start, end } = periodBounds(m);
  const [counts, forms, cents] = await Promise.all([
    eventCounts(db, customerId, start, end),
    formSubmissions(db, customerId, start, end),
    paymentsCents(db, customerId, start, end),
  ]);
  return {
    visits: counts.get(EVENT_TYPES.visit) ?? 0,
    calls: counts.get(EVENT_TYPES.call) ?? 0,
    formSubmissions: forms,
    bookings: counts.get(EVENT_TYPES.booking) ?? 0,
    paymentsProcessedCents: cents,
  };
}

// ---------------------------------------------------------------------------
// The single suggested action.
// ---------------------------------------------------------------------------

/** Metrics that fell versus the prior month, in a fixed order so the text is deterministic. */
export function downMetrics(delta: MomDelta): (keyof ValueMetrics)[] {
  return METRIC_KEYS.filter((k) => delta[k] < 0);
}

const METRIC_LABELS: Record<keyof ValueMetrics, string> = {
  visits: "Visits",
  calls: "Calls",
  formSubmissions: "Form submissions",
  bookings: "Bookings",
  paymentsProcessedCents: "Payments",
};

/**
 * Choose the one suggested action.
 *
 * INVARIANT (spec §58): when any headline metric is down against the prior
 * month the result is never an upsell. The customer gets a free diagnostic
 * offer instead — a worse month is not a moment to sell them something.
 */
export function suggestFor(input: {
  current: ValueMetrics;
  previous: ValueMetrics;
  delta: MomDelta;
  sources: TrafficSources;
  topQueries: string[];
  aiVisibility: AiVisibility;
  buildsThisMonth: number;
}): ValueSuggestion | null {
  const { current, previous, delta, topQueries: queries, aiVisibility: ai } = input;

  const down = downMetrics(delta);
  if (down.length > 0) {
    const worst = down[0]!;
    return {
      text:
        `${METRIC_LABELS[worst]} went from ${previous[worst]} to ${current[worst]} this month. ` +
        `Reply REVIEW and we will go through what changed and fix what we can — no charge, nothing to buy.`,
      replyKeyword: "REVIEW",
      upsell: false,
    };
  }

  // Flat or better. One action, chosen from their own figures.
  if (ai.tracked > 0 && ai.appearsIn < ai.tracked) {
    const missing = ai.tracked - ai.appearsIn;
    return {
      text:
        `Your site was cited by ${ai.appearsIn} of the ${ai.tracked} AI assistants we check. ` +
        `Reply VISIBILITY and we will add the structured answers the other ${missing} look for.`,
      replyKeyword: "VISIBILITY",
      upsell: false,
    };
  }

  if (current.visits > 0 && current.bookings === 0) {
    return {
      text:
        `${current.visits} people visited and none booked online, because there is nothing to book with yet. ` +
        `Reply BOOKING to add online booking to your site.`,
      replyKeyword: "BOOKING",
      upsell: true,
    };
  }

  if (current.calls > 0 && current.formSubmissions === 0) {
    return {
      text:
        `${current.calls} people tapped your phone number and none used the contact form. ` +
        `Reply FORMS and we will move the form above the fold and test it end to end.`,
      replyKeyword: "FORMS",
      upsell: false,
    };
  }

  if (current.bookings > 0 && current.paymentsProcessedCents === 0) {
    return {
      text:
        `You took ${current.bookings} bookings and collected nothing up front. ` +
        `Reply PAYMENTS to start taking deposits at the time of booking.`,
      replyKeyword: "PAYMENTS",
      upsell: true,
    };
  }

  const topQuery = queries[0];
  if (topQuery) {
    return {
      text:
        `The most common search that reached you was "${topQuery}". ` +
        `Reply PAGE and we will add a page that answers it directly.`,
      replyKeyword: "PAGE",
      upsell: false,
    };
  }

  if (input.buildsThisMonth === 0 && current.visits > 0) {
    return {
      text:
        `Your site has not changed this month and ${current.visits} people saw it. ` +
        `Reply PHOTOS to send us new pictures and we will refresh the page.`,
      replyKeyword: "PHOTOS",
      upsell: false,
    };
  }

  // Nothing happened worth acting on. Say nothing rather than manufacture a pitch.
  return null;
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Build the monthly value report for one customer. Pure function of the
 * database contents and the month: the same rows produce byte-identical output,
 * because nothing here reads a clock or calls a model.
 */
export async function generateValueReport(
  db: Db,
  customerId: string,
  month: ReportMonth,
): Promise<ValueReport> {
  const { start, end } = periodBounds(month);
  const prev = priorMonth(month);

  const [current, previous, sources, queries, ai, builds] = await Promise.all([
    metricsFor(db, customerId, month),
    metricsFor(db, customerId, prev),
    trafficSources(db, customerId, start, end),
    topQueries(db, customerId, start, end),
    aiVisibility(db, customerId, start, end),
    buildCount(db, customerId, start, end),
  ]);

  const momDelta: MomDelta = { ...ZERO_METRICS };
  for (const k of METRIC_KEYS) momDelta[k] = current[k] - previous[k];

  const suggestion = suggestFor({
    current,
    previous,
    delta: momDelta,
    sources,
    topQueries: queries,
    aiVisibility: ai,
    buildsThisMonth: builds,
  });

  return {
    customerId,
    period: {
      year: month.year,
      month: month.month,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
    },
    visits: current.visits,
    calls: current.calls,
    formSubmissions: current.formSubmissions,
    bookings: current.bookings,
    paymentsProcessedCents: current.paymentsProcessedCents,
    momDelta,
    previous,
    sources,
    topQueries: queries,
    aiVisibility: ai,
    suggestion,
  };
}

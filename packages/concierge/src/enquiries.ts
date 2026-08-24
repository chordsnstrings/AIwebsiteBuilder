// The enquiry READ side.
//
// ⛔ `commitEnquiry` has always written these rows correctly — one per session,
// urgency and contact captured, idempotent against a mid-conversation
// correction. Nothing has ever read them. No SELECT in the repo, no route, no
// job, and the dashboard's Enquiries screen rendered a demo fixture. So the
// agent said "I've passed your details on" to a member of the public, wrote the
// row, and the owner never found out.
//
// Everything here is the other half of that: list them, close them, and find
// the ones the owner has not been told about yet.
import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";

export type Urgency = "emergency" | "urgent" | "normal";
export type EnquiryStatus = "open" | "contacted" | "closed";

export interface Enquiry {
  id: string;
  name: string | null;
  need: string;
  contact: string;
  urgency: Urgency;
  status: EnquiryStatus;
  createdAt: Date;
  notifiedAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  sessionId: string | null;
}

interface Row {
  id: string;
  name: string | null;
  need: string | null;
  contact: string | null;
  urgency: string;
  status: string;
  created_at: Date;
  notified_at: Date | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  session_id: string | null;
}

const SELECT = `SELECT id, name, need, contact, urgency, status, created_at,
                       notified_at, resolved_at, resolved_by, session_id
                  FROM enquiries`;

function toEnquiry(r: Row): Enquiry {
  return {
    id: r.id,
    name: r.name,
    need: r.need ?? "",
    contact: r.contact ?? "",
    urgency: (r.urgency === "emergency" || r.urgency === "urgent" ? r.urgency : "normal"),
    status: (r.status === "contacted" || r.status === "closed" ? r.status : "open"),
    createdAt: r.created_at,
    notifiedAt: r.notified_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    sessionId: r.session_id,
  };
}

/** Rank used by both the list and the notification subject line. */
const URGENCY_RANK: Record<string, number> = { emergency: 0, urgent: 1, normal: 2 };

export interface ListOptions {
  /** Include enquiries already closed. Default false. */
  includeClosed?: boolean;
  limit?: number;
}

/**
 * The owner's enquiries, most urgent first.
 *
 * ⛔ Urgency outranks recency. A flooding kitchen logged this morning has to sit
 * above a quote request from ten minutes ago, and a plain `ORDER BY created_at`
 * buries exactly the one that cannot wait. Time is the tiebreak within a band.
 */
export async function listEnquiries(db: Db, customerId: string, opts: ListOptions = {}): Promise<Enquiry[]> {
  const rows = await db.query<Row>(
    `${SELECT}
      WHERE customer_id = $1
        AND ($2::boolean OR status <> 'closed')
      ORDER BY CASE urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END ASC,
               created_at DESC
      LIMIT $3`,
    [customerId, opts.includeClosed === true, Math.min(500, Math.max(1, opts.limit ?? 100))],
  );
  return rows.rows.map(toEnquiry);
}

export async function getEnquiry(db: Db, id: string): Promise<Enquiry | null> {
  const row = await db.maybeOne<Row>(`${SELECT} WHERE id = $1`, [id]);
  return row === null ? null : toEnquiry(row);
}

/**
 * Move an enquiry along. `contacted` means the owner has called them back;
 * `closed` means it is finished either way.
 *
 * ⛔ `by` is required and stored. The migration's CHECK enforces it for a close,
 * because a resolution nobody's name is on cannot be questioned afterwards.
 */
export async function setEnquiryStatus(
  db: Db,
  id: string,
  status: Exclude<EnquiryStatus, "open">,
  by: string,
  now: Date = new Date(),
): Promise<boolean> {
  const res = await db.query(
    `UPDATE enquiries
        SET status = $2,
            resolved_at = CASE WHEN $2 = 'closed' THEN $3 ELSE resolved_at END,
            resolved_by = CASE WHEN $2 = 'closed' THEN $4 ELSE resolved_by END
      WHERE id = $1 AND status <> 'closed'`,
    [id, status, now, by],
  );
  if ((res.rowCount ?? 0) === 0) return false;
  await emit({ eventType: `enquiry.${status}`, subject: { kind: "enquiry", id }, payload: { by } });
  return true;
}

export interface PendingNotification {
  enquiryId: string;
  customerId: string;
  name: string | null;
  need: string;
  contact: string;
  urgency: Urgency;
  createdAt: Date;
  contactEmail: string;
  legalName: string;
  countryCode: string | null;
}

/**
 * How many times the notifier will try before giving up and leaving it to the
 * dashboard. Low, because the failures that repeat are permanent ones — a
 * suppressed address, a kill switch — and retrying those is an alert storm.
 */
export const MAX_NOTIFY_ATTEMPTS = 4;

/**
 * How long an enquiry settles before we mail about it.
 *
 * ⛔ `commitEnquiry` UPDATES the open row when a visitor corrects themselves
 * mid-conversation — "actually it's flooding" turns a `normal` into an
 * `emergency`. Notifying the instant the row appears would mail the owner the
 * draft version and never correct it, so the send waits for the conversation to
 * settle. Short, because the whole point is that an emergency reaches them.
 */
export const SETTLE_MS = 90_000;

/**
 * Enquiries whose owner has not been told yet.
 *
 * ⛔ Only enquiries that HAVE a customer. A speculative preview can capture one
 * too — the widget is live on it — and there is nobody to email about that: the
 * business has not bought anything and has not asked us to contact them. Mailing
 * them off the back of a visitor's enquiry would be a cold send wearing a
 * transactional hat, and the gate would deny it. They stay unnotified, visibly,
 * rather than being quietly consumed.
 */
export async function pendingNotifications(
  db: Db,
  limit = 100,
  now: Date = new Date(),
): Promise<PendingNotification[]> {
  const rows = await db.query<{
    id: string; customer_id: string; name: string | null; need: string | null;
    contact: string | null; urgency: string; created_at: Date;
    contact_email: string; legal_name: string; country_code: string | null;
  }>(
    `SELECT e.id, e.customer_id, e.name, e.need, e.contact, e.urgency, e.created_at,
            cu.contact_email::text AS contact_email, cu.legal_name, b.country_code
       FROM enquiries e
       JOIN customers cu ON cu.id = e.customer_id
       JOIN businesses b ON b.id = cu.business_id
      WHERE e.notified_at IS NULL
        AND e.notify_attempts < $2
        AND e.created_at <= $3
      ORDER BY CASE e.urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END ASC,
               e.created_at ASC
      LIMIT $1`,
    [Math.min(500, Math.max(1, limit)), MAX_NOTIFY_ATTEMPTS, new Date(now.getTime() - SETTLE_MS)],
  );
  return rows.rows.map((r) => ({
    enquiryId: r.id,
    customerId: r.customer_id,
    name: r.name,
    need: r.need ?? "",
    contact: r.contact ?? "",
    urgency: (r.urgency === "emergency" || r.urgency === "urgent" ? r.urgency : "normal") as Urgency,
    createdAt: r.created_at,
    contactEmail: r.contact_email,
    legalName: r.legal_name,
    countryCode: r.country_code,
  }));
}

/**
 * ⛔ Stamped only after the transport accepted the message, never before.
 *
 * Marking first and sending second means a send that the gate denies, or that
 * throws, is recorded as delivered and never retried — the enquiry is then lost
 * in a way that looks exactly like success. The notifier calls this last.
 */
export async function markNotified(db: Db, enquiryId: string, now: Date = new Date()): Promise<boolean> {
  const res = await db.query(
    "UPDATE enquiries SET notified_at = $2 WHERE id = $1 AND notified_at IS NULL",
    [enquiryId, now],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Record a notification that did not go out, and why.
 *
 * ⛔ The error text is stored rather than only logged. A denial the operator
 * cannot read back is a silent failure with extra steps, and "the owner was
 * never told and nobody knows why" is the exact outcome this whole change
 * exists to end.
 */
export async function recordNotifyFailure(db: Db, enquiryIds: string[], error: string): Promise<void> {
  if (enquiryIds.length === 0) return;
  await db.query(
    `UPDATE enquiries SET notify_attempts = notify_attempts + 1, notify_error = $2
      WHERE id = ANY($1::uuid[]) AND notified_at IS NULL`,
    [enquiryIds, error.slice(0, 500)],
  );
}

/** Counts for the dashboard header: how many are waiting, and how urgent. */
export async function enquirySummary(
  db: Db,
  customerId: string,
): Promise<{ open: number; emergency: number; unnotified: number }> {
  const row = await db.one<{ open: string; emergency: string; unnotified: string }>(
    `SELECT count(*) FILTER (WHERE status <> 'closed')                       AS open,
            count(*) FILTER (WHERE status <> 'closed' AND urgency = 'emergency') AS emergency,
            count(*) FILTER (WHERE notified_at IS NULL)                      AS unnotified
       FROM enquiries WHERE customer_id = $1`,
    [customerId],
  );
  return { open: Number(row.open), emergency: Number(row.emergency), unnotified: Number(row.unnotified) };
}

export { URGENCY_RANK };

// Telling the owner somebody asked for them.
//
// ⛔ THE ONLY PLACE THIS PRODUCT ACTIVELY MISLED A MEMBER OF THE PUBLIC.
//
// A visitor asks the agent on a customer's site for an emergency callout and
// leaves their number. `handleTurn` calls `commitEnquiry`, which writes the row
// correctly — one per session, urgency captured, idempotent against a
// mid-conversation correction. The agent then tells the visitor, in words, that
// it has passed their details on.
//
// Nothing read that table. No SELECT anywhere in the repository, no route, no
// job, and the dashboard's Enquiries screen rendered a demo fixture. The owner
// never found out, and the caller sat waiting for a call that was never coming.
//
// This is the send. It is deliberately the smaller half of the fix: the
// dashboard is the record and this is the nudge, so a denial here loses nothing
// — the enquiry is still sitting on the owner's screen either way.
import type { Db } from "@adw/db";
import { emailHash } from "@adw/db";
import { config } from "@adw/config";
import { gatedSend, type OutboundMessage } from "@adw/gate";
import {
  MAX_NOTIFY_ATTEMPTS,
  markNotified,
  pendingNotifications,
  recordNotifyFailure,
  type PendingNotification,
} from "@adw/concierge";

/** Most an owner is told about in one message before it stops being readable. */
const MAX_PER_EMAIL = 10;

export interface NotifyDeps {
  db: Db;
  /** The brand transport — resolved by the caller so this stays testable. */
  transport: Parameters<typeof gatedSend>[0]["transport"];
  from: string;
  now?: () => Date;
}

export interface NotifyOutcome {
  /** Owners we attempted to reach this run. */
  customers: number;
  /** Enquiries covered by a message the transport accepted. */
  notified: number;
  /** Enquiries whose notification was refused, with the reason kept on the row. */
  failed: number;
  /** Enquiries that have now exhausted their attempts and will not be retried. */
  abandoned: number;
  reasons: string[];
}

function legal(): { entity: string; postal_address: string; privacy_url: string } {
  return config.legalText().data.default as { entity: string; postal_address: string; privacy_url: string };
}

function dashboardUrl(customerId: string): string {
  const base = process.env["ADW_DASHBOARD_URL"] ?? "https://app.adwsites.com";
  return `${base}/#/enquiries?customer=${encodeURIComponent(customerId)}`;
}

const URGENCY_LABEL: Record<string, string> = {
  emergency: "EMERGENCY",
  urgent: "Urgent",
  normal: "New",
};

/** The subject carries the worst urgency in the batch, because it is what gets read. */
export function subjectFor(batch: PendingNotification[]): string {
  const worst = batch.some((e) => e.urgency === "emergency")
    ? "emergency"
    : batch.some((e) => e.urgency === "urgent")
      ? "urgent"
      : "normal";
  const n = batch.length;
  if (worst === "emergency") return n === 1 ? "Emergency enquiry from your website" : `${n} enquiries — one is an emergency`;
  if (n === 1) return "New enquiry from your website";
  return `${n} new enquiries from your website`;
}

/**
 * ⛔ The body carries a privacy link because the gate's required-elements rule
 * checks for one MATERIALLY, in every jurisdiction, for every class. The
 * delivery email shipped without one and was therefore denied on
 * rule_10_required_elements for every customer who ever bought — silently,
 * because the workflow ignored the return value. Same rule, same shape, so it
 * is asserted in the test rather than trusted here.
 */
export function bodyFor(batch: PendingNotification[], customerId: string): string {
  const lines: string[] = [];
  lines.push(
    batch.length === 1
      ? "Someone just asked for you on your website."
      : `${batch.length} people asked for you on your website.`,
  );
  lines.push("");
  for (const e of batch) {
    const who = e.name === null || e.name.trim() === "" ? "Someone" : e.name.trim();
    lines.push(`${URGENCY_LABEL[e.urgency] ?? "New"} — ${who}`);
    if (e.need.trim() !== "") lines.push(`  What they need: ${e.need.trim()}`);
    // ⛔ The contact detail is the whole point of the message. An enquiry
    // notification that makes the owner log in to find the phone number is a
    // notification that gets ignored at 22:00 on a Saturday.
    lines.push(`  Contact: ${e.contact}`);
    lines.push("");
  }
  lines.push(`All of them, with the full conversation: ${dashboardUrl(customerId)}`);
  lines.push("");
  lines.push(`${legal().entity}, ${legal().postal_address}`);
  lines.push(`Privacy: ${legal().privacy_url}`);
  return lines.join("\n");
}

/**
 * One pass. Groups by owner so five enquiries in five minutes are one email
 * rather than five, and marks each covered enquiry notified only AFTER the
 * transport accepted the message.
 */
export async function notifyPendingEnquiries(deps: NotifyDeps): Promise<NotifyOutcome> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const pending = await pendingNotifications(db, 200, now);

  const byCustomer = new Map<string, PendingNotification[]>();
  for (const e of pending) {
    const list = byCustomer.get(e.customerId) ?? [];
    if (list.length < MAX_PER_EMAIL) list.push(e);
    byCustomer.set(e.customerId, list);
  }

  const out: NotifyOutcome = { customers: 0, notified: 0, failed: 0, abandoned: 0, reasons: [] };

  for (const [customerId, batch] of byCustomer) {
    const first = batch[0];
    if (first === undefined) continue;
    out.customers++;
    const ids = batch.map((e) => e.enquiryId);

    const message: OutboundMessage = {
      emailHash: emailHash(first.contactEmail),
      countryCode: first.countryCode ?? "US",
      subscriberType: "corporate",
      channel: "email",
      // ⛔ Transactional. This is a message a paying customer is owed about
      // their own business, not marketing — and since rule 6 stopped applying
      // quiet hours to this class, a Saturday-night emergency actually reaches
      // them. Suppression and the kill switches still apply, as they do to
      // every class.
      messageClass: "transactional",
      domainClass: "brand",
      // One key per enquiry set, so a retry after a crash mid-send cannot
      // deliver the same batch twice.
      idempotencyKey: `enquiry-notify:${customerId}:${ids.slice().sort().join(",")}`,
      body: bodyFor(batch, customerId),
      headers: { From: deps.from },
    };

    let sent = false;
    let reason = "";
    try {
      const result = await gatedSend(
        {
          message,
          to: first.contactEmail,
          from: deps.from,
          subject: subjectFor(batch),
          transport: deps.transport,
          roleId: "customer_care",
        },
        { db },
      );
      sent = result.sent;
      reason = result.sent ? "" : (result.reason ?? "denied");
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }

    if (sent) {
      // ⛔ Stamped last. Marking first would record a denied or thrown send as
      // delivered, and the enquiry would never be retried or reported.
      for (const id of ids) if (await markNotified(db, id, now)) out.notified++;
      continue;
    }

    await recordNotifyFailure(db, ids, reason);
    out.failed += ids.length;
    if (!out.reasons.includes(reason)) out.reasons.push(reason);

    // The last attempt goes to the OWNER'S queue — the one the dashboard now
    // reads — rather than to ADW's, because the person who needs to know that
    // an enquiry never reached them is the owner.
    const exhausted = await db.one<{ n: string }>(
      `SELECT count(*) AS n FROM enquiries
        WHERE id = ANY($1::uuid[]) AND notified_at IS NULL AND notify_attempts >= $2`,
      [ids, MAX_NOTIFY_ATTEMPTS],
    );
    const abandoned = Number(exhausted.n);
    if (abandoned > 0) {
      out.abandoned += abandoned;
      await db.query(
        `INSERT INTO exceptions (customer_id, trigger, severity, context, system_action, recommendation)
         VALUES ($1,'enquiry_notification_undelivered',2,$2,
                 'the enquiry is on the dashboard; the email could not be sent',
                 'Check the contact address on the account, then call the enquiry back directly')`,
        [customerId, JSON.stringify({ enquiryIds: ids, reason, attempts: MAX_NOTIFY_ATTEMPTS })],
      );
    }
  }
  return out;
}

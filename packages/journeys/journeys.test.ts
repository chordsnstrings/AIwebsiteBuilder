// MF4 + MF5 — customer clocks and journeys.
//
// Before this package there was exactly ONE `ctx.sleep` in the whole repository
// (a 180-day lead cooldown belonging to ADW's own outreach), no date bound to
// any customer-facing event, and a sequencing engine that ran cold email for the
// seller. The durable-timer machinery was real; nothing pointed it at a
// customer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, emailHash, migrate, type Db } from "@adw/db";
import {
  activeRuns, cancelReminder, clocksFor, dueReminders, journeyEvent, journeysFor,
  runJourneys, runReminders, scheduleReminder, startJourney, stopJourney,
  upcomingReminders,
} from "./src/index.ts";

const URL = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
/** A clinical practice (archetype G) and a letting agent (archetype I). */
let clinic: string;
let agency: string;

const DAY = 86_400_000;
const uniq = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

async function makeCustomer(vertical: string, name: string): Promise<string> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id");
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical)
     VALUES ('d',$1,$2,'GB','R2','no_site',$3) RETURNING id`, [batch.id, name, vertical]);
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R2',$2,$3,'en-GB','Europe/London','active') RETURNING id`,
    [biz.id, name, `${name.replace(/\W/g, "").toLowerCase()}@example.com`]);
  return cust.id;
}

async function suppress(email: string): Promise<void> {
  await db.query("INSERT INTO suppression (email_hash, reason) VALUES ($1,'unsubscribe')", [emailHash(email)]);
}

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  clinic = await makeCustomer("dentist", `Clinic ${uniq()}`);
  agency = await makeCustomer("estate_agent", `Agency ${uniq()}`);
});
afterAll(async () => { await db?.close(); });

describe("the catalogue", () => {
  it("resolves clocks and journeys per archetype, so every trade has both", () => {
    expect(clocksFor("dentist").map((c) => c.id)).toContain("recall");
    expect(clocksFor("estate_agent").map((c) => c.id)).toContain("gas_safety_certificate");
    expect(clocksFor("plumber").length).toBeGreaterThan(0);
    expect(journeysFor("dentist").map((j) => j.id)).toContain("recall_sequence");
    expect(journeysFor("plumber").map((j) => j.id)).toContain("post_job_review");
  });

  it("⛔ a save journey has exactly one step", () => {
    // The retention rule, enforced at load rather than trusted in prose. A
    // second message to someone who has already said they are leaving is not
    // retention. The loader throws, so reaching this line at all means it held.
    for (const vertical of ["hair_salon", "it_msp", "lawyer"]) {
      const save = journeysFor(vertical).find((j) => j.kind === "save");
      if (save !== undefined) expect(save.steps.length).toBe(1);
    }
  });

  it("⛔ never marks a licence renewal non-statutory", () => {
    expect(clocksFor("estate_agent").find((c) => c.id === "gas_safety_certificate")!.statutory).toBe(true);
    expect(clocksFor("dentist").find((c) => c.id === "professional_registration")!.statutory).toBe(true);
    expect(clocksFor("dentist").find((c) => c.id === "recall")!.statutory).toBe(false);
  });
});

describe("clocks", () => {
  it("is an anchor plus a signed offset — after an event, before a deadline", async () => {
    const anchor = new Date("2026-01-01T09:00:00Z");
    const recall = await scheduleReminder(db, {
      customerId: clinic, vertical: "dentist", kind: "recall", subjectRef: `pt-${uniq()}`, anchorAt: anchor });
    expect(recall.ok).toBe(true);
    // +180 from the visit.
    expect(recall.ok && recall.dueAt.getTime()).toBe(anchor.getTime() + 180 * DAY);

    const gas = await scheduleReminder(db, {
      customerId: agency, vertical: "estate_agent", kind: "gas_safety_certificate",
      subjectRef: `12 Elm St ${uniq()}`, anchorAt: anchor });
    // -28 from the expiry: you are reminded BEFORE a deadline.
    expect(gas.ok && gas.dueAt.getTime()).toBe(anchor.getTime() - 28 * DAY);
  });

  it("⛔ takes `statutory` from config, never from the caller", async () => {
    const r = await scheduleReminder(db, {
      customerId: agency, vertical: "estate_agent", kind: "deposit_protection_deadline",
      subjectRef: `dep-${uniq()}`, anchorAt: new Date() });
    expect(r.ok && r.statutory).toBe(true);
  });

  it("refuses a clock the vertical does not have", async () => {
    const r = await scheduleReminder(db, {
      customerId: clinic, vertical: "dentist", kind: "gas_safety_certificate",
      subjectRef: uniq(), anchorAt: new Date() });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("unknown_clock");
  });

  it("re-anchoring a NON-statutory clock moves the one pending row", async () => {
    // A tenant told their certificate expires on two different days trusts
    // neither date, so the old row must not be left standing.
    const subject = `pt-${uniq()}`;
    const first = await scheduleReminder(db, {
      customerId: clinic, vertical: "dentist", kind: "recall", subjectRef: subject,
      anchorAt: new Date("2026-01-01T00:00:00Z") });
    const second = await scheduleReminder(db, {
      customerId: clinic, vertical: "dentist", kind: "recall", subjectRef: subject,
      anchorAt: new Date("2026-03-01T00:00:00Z") });
    expect(second.ok && second.moved).toBe(true);
    expect(second.ok && second.id).toBe(first.ok && first.id);
    const count = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM reminders WHERE customer_id = $1 AND subject_ref = $2 AND fired_at IS NULL AND cancelled_at IS NULL",
      [clinic, subject]);
    expect(Number(count.n)).toBe(1);
  });

  it("⛔ refuses to move a STATUTORY date automatically", async () => {
    // A recall can slip a fortnight. A licence renewal date is a fact about the
    // law and nothing automatic may quietly rewrite it.
    const subject = `flat-${uniq()}`;
    const first = await scheduleReminder(db, {
      customerId: agency, vertical: "estate_agent", kind: "gas_safety_certificate",
      subjectRef: subject, anchorAt: new Date("2026-06-01T00:00:00Z") });
    const auto = await scheduleReminder(db, {
      customerId: agency, vertical: "estate_agent", kind: "gas_safety_certificate",
      subjectRef: subject, anchorAt: new Date("2026-09-01T00:00:00Z") });
    expect(auto.ok).toBe(false);
    expect(!auto.ok && auto.reason).toBe("statutory_locked");

    const unchanged = await db.one<{ due_at: Date }>("SELECT due_at FROM reminders WHERE id = $1", [first.ok && first.id]);
    expect(new Date(unchanged.due_at).getTime()).toBe(first.ok && first.dueAt.getTime());
  });

  it("...and records who moved it when a human does", async () => {
    const subject = `flat-${uniq()}`;
    const first = await scheduleReminder(db, {
      customerId: agency, vertical: "estate_agent", kind: "gas_safety_certificate",
      subjectRef: subject, anchorAt: new Date("2026-06-01T00:00:00Z") });
    const moved = await scheduleReminder(db, {
      customerId: agency, vertical: "estate_agent", kind: "gas_safety_certificate",
      subjectRef: subject, anchorAt: new Date("2027-06-01T00:00:00Z"),
      override: { actor: "manager@agency.example", reason: "new certificate issued 2026-06-02" } });
    expect(moved.ok && moved.moved).toBe(true);
    const row = await db.one<{ moved_by: string; moved_reason: string }>(
      "SELECT moved_by, moved_reason FROM reminders WHERE id = $1", [first.ok && first.id]);
    expect(row.moved_by).toBe("manager@agency.example");
    expect(row.moved_reason).toMatch(/new certificate/);
  });

  it("fires what is due, and recurs only where the next date is knowable", async () => {
    const patient = `pt-${uniq()}`;
    const property = `flat-${uniq()}`;
    const past = new Date(Date.now() - 400 * DAY);
    await scheduleReminder(db, { customerId: clinic, vertical: "dentist", kind: "recall", subjectRef: patient, anchorAt: past });
    await scheduleReminder(db, {
      customerId: agency, vertical: "estate_agent", kind: "gas_safety_certificate",
      subjectRef: property, anchorAt: past });

    const seen: string[] = [];
    await runReminders(db, async (r) => { seen.push(`${r.kind}:${r.subjectRef}`); return { delivered: true }; });
    expect(seen).toContain(`recall:${patient}`);
    expect(seen).toContain(`gas_safety_certificate:${property}`);

    // gas_safety_certificate has recur_days: 365 — the next one exists.
    const gasPending = await db.query(
      "SELECT id FROM reminders WHERE subject_ref = $1 AND fired_at IS NULL AND cancelled_at IS NULL", [property]);
    expect(gasPending.rows.length).toBe(1);

    // ⛔ recall has no recur_days. The next recall is six months from a visit
    // that has not happened; recurring it mails a patient who stopped attending
    // twice a year forever.
    const recallPending = await db.query(
      "SELECT id FROM reminders WHERE subject_ref = $1 AND fired_at IS NULL AND cancelled_at IS NULL", [patient]);
    expect(recallPending.rows.length).toBe(0);
  });

  it("⛔ reports suppression but does not act on it", async () => {
    // An unsubscribe from a business's marketing must not suppress "your gas
    // safety certificate expires in 28 days" — that is a legal obligation, not
    // a newsletter.
    const tenant = `tenant-${uniq()}@example.com`;
    await suppress(tenant);
    await scheduleReminder(db, {
      customerId: agency, vertical: "estate_agent", kind: "deposit_protection_deadline",
      subjectRef: `dep-${uniq()}`, contact: tenant, anchorAt: new Date(Date.now() - 60 * DAY) });
    const due = await dueReminders(db);
    const mine = due.find((r) => r.contact === tenant)!;
    expect(mine).toBeDefined();
    expect(mine.contactSuppressed).toBe(true);
    expect(mine.statutory).toBe(true);
  });

  it("puts statutory dates at the top of the owner's list", async () => {
    // Seeded here rather than relied on from earlier tests: an ordering
    // assertion over a list with nothing to order is an assertion that passes
    // for the wrong reason.
    await scheduleReminder(db, {
      customerId: clinic, vertical: "dentist", kind: "recall",
      subjectRef: `order-lo-${uniq()}`, anchorAt: new Date(Date.now() - 400 * DAY) });
    await scheduleReminder(db, {
      customerId: agency, vertical: "estate_agent", kind: "gas_safety_certificate",
      subjectRef: `order-hi-${uniq()}`, anchorAt: new Date(Date.now() - 400 * DAY) });

    const due = await dueReminders(db);
    expect(due.filter((r) => r.statutory).length).toBeGreaterThan(0);
    expect(due.filter((r) => !r.statutory).length).toBeGreaterThan(0);
    let seenNonStatutory = false;
    for (const r of due) {
      if (!r.statutory) seenNonStatutory = true;
      else expect(seenNonStatutory, "a statutory reminder ranked below a non-statutory one").toBe(false);
    }
  });

  it("shows what is coming, and drops what was cancelled", async () => {
    const subject = `pt-${uniq()}`;
    const r = await scheduleReminder(db, {
      customerId: clinic, vertical: "dentist", kind: "prescription_review",
      subjectRef: subject, anchorAt: new Date() });
    expect((await upcomingReminders(db, clinic, 365)).map((u) => u.subjectRef)).toContain(subject);
    expect(await cancelReminder(db, (r.ok && r.id) as string, "patient discharged")).toBe(true);
    expect((await upcomingReminders(db, clinic, 365)).map((u) => u.subjectRef)).not.toContain(subject);
  });
});

describe("journeys", () => {
  it("enrols, and refuses a second concurrent run for the same subject", async () => {
    // Two overlapping sequences means the same person is messaged twice on the
    // same day by the same business.
    const subject = `job-${uniq()}`;
    const contact = `client-${uniq()}@example.com`;
    const a = await startJourney(db, {
      customerId: clinic, vertical: "dentist", journeyId: "recall_sequence", subjectRef: subject, contact });
    expect(a.started).toBe(true);
    const b = await startJourney(db, {
      customerId: clinic, vertical: "dentist", journeyId: "recall_sequence", subjectRef: subject, contact });
    expect(b.started).toBe(false);
    expect(!b.started && b.reason).toBe("already_running");
  });

  it("⛔ refuses to enrol a suppressed contact at all", async () => {
    // Enrolled-but-never-sent looks identical to working on every dashboard.
    const contact = `gone-${uniq()}@example.com`;
    await suppress(contact);
    const r = await startJourney(db, {
      customerId: clinic, vertical: "dentist", journeyId: "recall_sequence", subjectRef: uniq(), contact });
    expect(r.started).toBe(false);
    expect(!r.started && r.reason).toBe("suppressed");
  });

  it("refuses a journey the vertical does not run", async () => {
    const r = await startJourney(db, {
      customerId: clinic, vertical: "dentist", journeyId: "renewal_sequence",
      subjectRef: uniq(), contact: `x-${uniq()}@example.com` });
    expect(!r.started && r.reason).toBe("unknown_journey");
  });

  it("delivers step 1 at once and holds step 2 until its day", async () => {
    const contact = `pt-${uniq()}@example.com`;
    const subject = `recall-${uniq()}`;
    const t0 = new Date();
    await startJourney(db, {
      customerId: clinic, vertical: "dentist", journeyId: "recall_sequence", subjectRef: subject, contact }, t0);

    const sent: number[] = [];
    const collect = async (s: { subjectRef: string; stepIndex: number }) => {
      if (s.subjectRef === subject) sent.push(s.stepIndex);
      return { delivered: true };
    };
    // recall_sequence: after_days 0 then 21.
    await runJourneys(db, collect, t0);
    expect(sent).toEqual([0]);
    await runJourneys(db, collect, new Date(t0.getTime() + 5 * DAY));
    expect(sent, "step 2 fired five days early").toEqual([0]);
    await runJourneys(db, collect, new Date(t0.getTime() + 21 * DAY + 1000));
    expect(sent).toEqual([0, 1]);

    const run = await db.one<{ state: string }>(
      "SELECT state FROM journey_runs WHERE customer_id = $1 AND subject_ref = $2", [clinic, subject]);
    expect(run.state).toBe("completed");
  });

  it("⛔ re-checks suppression before EVERY step", async () => {
    // Consent at step 1 is not consent at step 3 twelve days later. A sequence
    // that only asks at enrolment keeps messaging people who left on day two.
    const contact = `leaver-${uniq()}@example.com`;
    const subject = `recall-${uniq()}`;
    const t0 = new Date();
    await startJourney(db, {
      customerId: clinic, vertical: "dentist", journeyId: "recall_sequence", subjectRef: subject, contact }, t0);

    const sent: number[] = [];
    const collect = async (s: { subjectRef: string; stepIndex: number }) => {
      if (s.subjectRef === subject) sent.push(s.stepIndex);
      return { delivered: true };
    };
    await runJourneys(db, collect, t0);
    expect(sent).toEqual([0]);

    await suppress(contact);
    await runJourneys(db, collect, new Date(t0.getTime() + 22 * DAY));
    expect(sent, "step 2 went to someone who had unsubscribed").toEqual([0]);
    const run = await db.one<{ state: string; stop_reason: string }>(
      "SELECT state, stop_reason FROM journey_runs WHERE customer_id = $1 AND subject_ref = $2", [clinic, subject]);
    expect(run.state).toBe("stopped");
    expect(run.stop_reason).toBe("suppressed");
  });

  it("⛔ measures every step from the run's start, so a retry cannot drag the tail", async () => {
    // Computing each step from "now" lets a one-hour delivery hiccup silently
    // rewrite a 21-day cadence.
    const contact = `retry-${uniq()}@example.com`;
    const subject = `recall-${uniq()}`;
    const t0 = new Date();
    await startJourney(db, {
      customerId: clinic, vertical: "dentist", journeyId: "recall_sequence", subjectRef: subject, contact }, t0);

    // Step 1 fails once, then succeeds an hour later.
    let attempt = 0;
    const flaky = async (s: { subjectRef: string }) => {
      if (s.subjectRef !== subject) return { delivered: true };
      attempt += 1;
      return attempt === 1 ? { delivered: false, detail: "smtp timeout" } : { delivered: true };
    };
    await runJourneys(db, flaky, t0);
    await runJourneys(db, flaky, new Date(t0.getTime() + 2 * 3_600_000));

    const run = await db.one<{ next_step_at: Date }>(
      "SELECT next_step_at FROM journey_runs WHERE customer_id = $1 AND subject_ref = $2", [clinic, subject]);
    // Step 2 is 21 days from the RUN START, not 21 days from the retry.
    const drift = Math.abs(new Date(run.next_step_at).getTime() - (t0.getTime() + 21 * DAY));
    expect(drift).toBeLessThan(60_000);
  });

  it("drops a contact that keeps failing rather than retrying forever", async () => {
    const contact = `dead-${uniq()}@example.com`;
    const subject = `recall-${uniq()}`;
    const t0 = new Date();
    await startJourney(db, {
      customerId: clinic, vertical: "dentist", journeyId: "recall_sequence", subjectRef: subject, contact }, t0);
    const fail = async (s: { subjectRef: string }) =>
      s.subjectRef === subject ? { delivered: false, detail: "550 no such user" } : { delivered: true };
    for (let i = 0; i < 3; i++) await runJourneys(db, fail, new Date(t0.getTime() + i * 2 * 3_600_000));
    const run = await db.one<{ state: string; stop_reason: string }>(
      "SELECT state, stop_reason FROM journey_runs WHERE customer_id = $1 AND subject_ref = $2", [clinic, subject]);
    expect(run.state).toBe("stopped");
    expect(run.stop_reason).toBe("undeliverable");
  });

  it("⛔ stops on the events the journey lists — the half that makes stop_on real", async () => {
    // A stop list nothing reports into is a comment: step 3 asks for a review
    // from someone who left one on day two.
    const contact = `happy-${uniq()}@example.com`;
    const subject = `recall-${uniq()}`;
    await startJourney(db, {
      customerId: clinic, vertical: "dentist", journeyId: "recall_sequence", subjectRef: subject, contact });
    expect(await journeyEvent(db, { customerId: clinic, subjectRef: subject, event: "booked" })).toBe(1);
    const run = await db.one<{ state: string; stop_reason: string }>(
      "SELECT state, stop_reason FROM journey_runs WHERE customer_id = $1 AND subject_ref = $2", [clinic, subject]);
    expect(run.state).toBe("stopped");
    expect(run.stop_reason).toBe("event:booked");

    // An event no journey lists stops nothing.
    expect(await journeyEvent(db, { customerId: clinic, subjectRef: subject, event: "sneezed" })).toBe(0);
  });

  it("stops by CONTACT too — a booking knows who booked, not an internal ref", async () => {
    const contact = `booker-${uniq()}@example.com`;
    await startJourney(db, {
      customerId: clinic, vertical: "dentist", journeyId: "recall_sequence",
      subjectRef: `recall-${uniq()}`, contact });
    expect(await journeyEvent(db, { customerId: clinic, contact, event: "booked" })).toBe(1);
  });

  it("⛔ refuses an event with neither a subject nor a contact", async () => {
    // With neither, the WHERE clause degenerates to "every running run for this
    // customer" and one stray booking ends every sequence the business has.
    await expect(journeyEvent(db, { customerId: clinic, event: "booked" })).rejects.toThrow(/subjectRef or a contact/);
  });

  it("re-enrolment is allowed once the previous run has ended", async () => {
    const contact = `again-${uniq()}@example.com`;
    const subject = `recall-${uniq()}`;
    const first = await startJourney(db, {
      customerId: clinic, vertical: "dentist", journeyId: "recall_sequence", subjectRef: subject, contact });
    await stopJourney(db, (first.started && first.runId) as string, "manual");
    const second = await startJourney(db, {
      customerId: clinic, vertical: "dentist", journeyId: "recall_sequence", subjectRef: subject, contact });
    expect(second.started).toBe(true);
  });

  it("shows the owner what is running", async () => {
    const subject = `recall-${uniq()}`;
    await startJourney(db, {
      customerId: clinic, vertical: "dentist", journeyId: "recall_sequence",
      subjectRef: subject, contact: `live-${uniq()}@example.com` });
    const runs = await activeRuns(db, clinic, "dentist");
    const mine = runs.find((r) => r.subjectRef === subject)!;
    expect(mine.journeyLabel).toBe("Recall sequence");
    expect(mine.stepCount).toBe(2);
  });
});

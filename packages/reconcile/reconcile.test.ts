// MF8 — reconciliation.
//
// Nothing in this system held two lists side by side on a customer's behalf.
// The assertions that matter are all about the matcher's willingness to say "I
// don't know": an ambiguous pairing reported as a match is worse than no match,
// because the difference it was concealing is now off the list.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import {
  closeRun, ingest, matchItems, normaliseReference, openDifferences, openRun,
  reconTypeById, reconTypesFor, resolveDifference, runReconciliation, runsFor,
  type ReconItem, type ReconType,
} from "./src/index.ts";

const URL_ = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
let plumber: string;
let lawyer: string;
const uniq = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

async function makeCustomer(vertical: string): Promise<string> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id");
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical)
     VALUES ('d',$1,$2,'GB','R2','no_site',$3) RETURNING id`, [batch.id, `Recon ${uniq()}`, vertical]);
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R2','Recon Co',$2,'en-GB','Europe/London','active') RETURNING id`,
    [biz.id, `r${uniq()}@example.com`]);
  return cust.id;
}

const item = (
  side: "ours" | "theirs", key: string, amountCents: number,
  over: { reference?: string | null; day?: number } = {},
): ReconItem => ({
  id: `${side}:${key}`,
  side,
  sourceKey: key,
  reference: over.reference ?? null,
  amountCents,
  occurredOn: over.day === undefined ? null : new Date(Date.UTC(2026, 4, over.day)),
});

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
  plumber = await makeCustomer("plumber");
  lawyer = await makeCustomer("lawyer");
});
afterAll(async () => { await db?.close(); });

describe("the catalogue", () => {
  it("resolves reconciliations per archetype", () => {
    expect(reconTypesFor("plumber").map((t) => t.id)).toContain("invoices_vs_bank");
    expect(reconTypesFor("lawyer").map((t) => t.id)).toContain("client_account");
    expect(reconTypesFor("estate_agent").map((t) => t.id)).toContain("deposit_register");
  });

  it("⛔ a client account tolerates nothing", () => {
    // A client account reconciliation that tolerates a penny is not a client
    // account reconciliation; in most jurisdictions it is a regulatory
    // obligation with a named responsible person.
    const t = reconTypeById("client_account")!;
    expect(t.toleranceCents).toBe(0);
    expect(t.statutory).toBe(true);
  });
});

describe("the matcher", () => {
  const type = (over: Partial<ReconType> = {}): ReconType => ({
    id: "t", label: "Test", oursLabel: "Ours", theirsLabel: "Theirs",
    matchBy: ["reference", "amount_date"], toleranceCents: 0, dateWindowDays: 5,
    sumMax: 0, statutory: false, ...over,
  });

  it("normalises references before comparing them", () => {
    expect(normaliseReference(" inv-1001 ")).toBe(INV1001);
    expect(normaliseReference("INV/1001")).toBe(INV1001);
    expect(normaliseReference("   ")).toBeNull();
  });

  it("matches on reference, and flags a real amount difference as a mismatch", () => {
    const out = matchItems(type(),
      [item("ours", "o1", 15000, { reference: "INV-1001" })],
      [item("theirs", "t1", 14500, { reference: "inv 1001" })]);
    expect(out.length).toBe(1);
    expect(out[0]!.status).toBe("mismatched");
    expect(out[0]!.deltaCents).toBe(-500);
  });

  it("⛔ refuses when one reference appears on more than one line", () => {
    // Two invoices given the same number, or a customer paying twice quoting
    // the same reference. Both need a person, and a matcher that picks one is
    // a matcher that conceals the other.
    const out = matchItems(type(),
      [item("ours", "o1", 10000, { reference: "REF9" }), item("ours", "o2", 10000, { reference: "REF9" })],
      [item("theirs", "t1", 10000, { reference: "REF9" })]);
    expect(out.length).toBe(1);
    expect(out[0]!.status).toBe("ambiguous");
    expect(out[0]!.oursIds.length).toBe(2);
  });

  it("⛔ will not pick a winner between two identical amounts", () => {
    // Two £150 invoices and one £150 payment must not resolve to whichever
    // invoice happened to sort first.
    const out = matchItems(type({ matchBy: ["amount_date"] }),
      [item("ours", "o1", 15000, { day: 1 }), item("ours", "o2", 15000, { day: 1 })],
      [item("theirs", "t1", 15000, { day: 2 })]);
    expect(out.every((r) => r.status !== "matched")).toBe(true);
    expect(out.filter((r) => r.status.startsWith("unmatched")).length).toBe(3);
  });

  it("matches a mutually unique amount-and-date pair", () => {
    const out = matchItems(type({ matchBy: ["amount_date"] }),
      [item("ours", "o1", 15000, { day: 1 }), item("ours", "o2", 22000, { day: 1 })],
      [item("theirs", "t1", 15000, { day: 3 })]);
    expect(out.filter((r) => r.status === "matched").length).toBe(1);
    expect(out.filter((r) => r.status === "unmatched_ours").length).toBe(1);
  });

  it("⛔ a missing date is not 'within the window'", () => {
    // Treating null as zero days apart makes every undated line a candidate
    // for everything.
    const out = matchItems(type({ matchBy: ["amount_date"] }),
      [item("ours", "o1", 15000)],
      [item("theirs", "t1", 15000, { day: 3 })]);
    expect(out.every((r) => r.status !== "matched")).toBe(true);
  });

  it("respects the date window", () => {
    const out = matchItems(type({ matchBy: ["amount_date"], dateWindowDays: 2 }),
      [item("ours", "o1", 15000, { day: 1 })],
      [item("theirs", "t1", 15000, { day: 9 })]);
    expect(out.every((r) => r.status !== "matched")).toBe(true);
  });

  it("matches a settlement against the day's takings behind it", () => {
    const out = matchItems(type({ matchBy: ["sum_to_one"], sumMax: 10, dateWindowDays: 2, toleranceCents: 0 }),
      [item("ours", "a", 1000, { day: 1 }), item("ours", "b", 2500, { day: 1 }), item("ours", "c", 400, { day: 2 })],
      [item("theirs", "s", 3900, { day: 2 })]);
    const matched = out.filter((r) => r.status === "matched");
    expect(matched.length).toBe(1);
    expect(matched[0]!.oursIds.length).toBe(3);
  });

  it("⛔ never hunts for a subset that happens to add up", () => {
    // Over a couple of hundred lines some subset almost always sums to the
    // payout by coincidence, and a coincidence presented as a reconciliation is
    // the worst output this family can produce. Here 1000 + 2500 = 3500 exactly,
    // but the day also contains a 400 that the payout does not cover — so the
    // natural grouping does not balance and nothing is matched.
    const out = matchItems(type({ matchBy: ["sum_to_one"], sumMax: 10, dateWindowDays: 2 }),
      [item("ours", "a", 1000, { day: 1 }), item("ours", "b", 2500, { day: 1 }), item("ours", "c", 400, { day: 1 })],
      [item("theirs", "s", 3500, { day: 2 })]);
    expect(out.every((r) => r.status !== "matched")).toBe(true);
  });

  it("honours a stated tolerance and nothing more", () => {
    const within = matchItems(type({ toleranceCents: 500 }),
      [item("ours", "o", 10000, { reference: "R1" })],
      [item("theirs", "t", 9600, { reference: "R1" })]);
    expect(within[0]!.status).toBe("matched");
    const beyond = matchItems(type({ toleranceCents: 500 }),
      [item("ours", "o", 10000, { reference: "R1" })],
      [item("theirs", "t", 9400, { reference: "R1" })]);
    expect(beyond[0]!.status).toBe("mismatched");
  });

  it("is deterministic — the same two files reconcile the same way twice", () => {
    const ours = [item("ours", "b", 100, { day: 2 }), item("ours", "a", 200, { day: 1 })];
    const theirs = [item("theirs", "y", 200, { day: 2 }), item("theirs", "x", 100, { day: 3 })];
    const once = JSON.stringify(matchItems(type({ matchBy: ["amount_date"] }), ours, theirs));
    const twice = JSON.stringify(matchItems(type({ matchBy: ["amount_date"] }), [...ours].reverse(), [...theirs].reverse()));
    expect(once).toBe(twice);
  });
});

const INV1001 = "INV1001";

describe("a run end to end", () => {
  const period = { periodStart: new Date("2026-05-01"), periodEnd: new Date("2026-05-31") };

  it("opens, ingests, matches and reports the difference", async () => {
    const customerId = await makeCustomer("plumber");
    const run = await openRun(db, { customerId, vertical: "plumber", reconType: "invoices_vs_bank", ...period });
    expect(run.ok).toBe(true);
    const runId = (run.ok && run.runId) as string;

    await ingest(db, runId, "ours", [
      { sourceKey: "inv-1", reference: "INV-1", amountCents: 12000, occurredOn: new Date("2026-05-04") },
      { sourceKey: "inv-2", reference: "INV-2", amountCents: 45000, occurredOn: new Date("2026-05-11") },
      { sourceKey: "inv-3", reference: "INV-3", amountCents: 9900, occurredOn: new Date("2026-05-20") },
    ]);
    await ingest(db, runId, "theirs", [
      { sourceKey: "bank-1", reference: "INV 1", amountCents: 12000, occurredOn: new Date("2026-05-06") },
      { sourceKey: "bank-2", reference: "inv/2", amountCents: 44000, occurredOn: new Date("2026-05-13") },
    ]);

    const summary = await runReconciliation(db, runId);
    expect(summary.matched).toBe(1);
    expect(summary.mismatched).toBe(1);
    expect(summary.unmatchedOurs).toBe(1);
    // ⛔ Stated even when small: 12000+44000 against 12000+45000+9900.
    expect(summary.differenceCents).toBe(56000 - 66900);
    expect(summary.balanced).toBe(false);
  });

  it("⛔ the same file twice does not double the balance", async () => {
    // The failure mode that makes a reconciliation report a discrepancy exactly
    // equal to one side of itself.
    const customerId = await makeCustomer("plumber");
    const run = await openRun(db, { customerId, vertical: "plumber", reconType: "invoices_vs_bank", ...period });
    const runId = (run.ok && run.runId) as string;
    const lines = [{ sourceKey: "inv-1", reference: "A1", amountCents: 5000, occurredOn: new Date("2026-05-04") }];
    const first = await ingest(db, runId, "ours", lines);
    const second = await ingest(db, runId, "ours", lines);
    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
    expect((await runReconciliation(db, runId)).ours.count).toBe(1);
  });

  it("⛔ refuses a non-integer amount rather than rounding it", async () => {
    // A line arriving as 12.34 pounds where the column expects 1234 pence is a
    // hundredfold error, and flooring it produces a plausible number.
    const customerId = await makeCustomer("plumber");
    const run = await openRun(db, { customerId, vertical: "plumber", reconType: "invoices_vs_bank", ...period });
    await expect(ingest(db, (run.ok && run.runId) as string, "ours", [
      { sourceKey: "x", amountCents: 12.34 },
    ])).rejects.toThrow(/minor units/);
  });

  it("⛔ will not close over an unexplained difference", async () => {
    // A signature against a question is not a sign-off, and for the statutory
    // ones it is the regulatory artefact.
    const customerId = await makeCustomer("lawyer");
    const run = await openRun(db, { customerId, vertical: "lawyer", reconType: "client_account", ...period });
    const runId = (run.ok && run.runId) as string;
    expect(run.ok && run.statutory).toBe(true);
    await ingest(db, runId, "ours", [{ sourceKey: "l1", reference: "M1", amountCents: 250000, occurredOn: new Date("2026-05-02") }]);
    await ingest(db, runId, "theirs", [{ sourceKey: "b1", reference: "M1", amountCents: 249900, occurredOn: new Date("2026-05-02") }]);
    await runReconciliation(db, runId);

    const blocked = await closeRun(db, runId, "partner@firm.example");
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.reason).toBe("unresolved");

    const [difference] = await openDifferences(db, runId);
    expect(difference!.deltaCents).toBe(-100);
    // ⛔ Resolving records a decision. It does not change the amount.
    expect(await resolveDifference(db, difference!.id, "partner@firm.example", "bank charge, posted separately")).toBe(true);
    expect(await resolveDifference(db, difference!.id, "partner@firm.example", "again")).toBe(false);
    const still = await db.one<{ delta_cents: string }>("SELECT delta_cents FROM recon_matches WHERE id = $1", [difference!.id]);
    expect(Number(still.delta_cents), "resolving a difference changed the amount").toBe(-100);

    const closed = await closeRun(db, runId, "partner@firm.example");
    expect(closed.ok).toBe(true);
  });

  it("⛔ a closed run is final — the database refuses, not just the code path", async () => {
    // Rewriting the differences under a signature makes the sign-off
    // meaningless, so the guard is a trigger rather than an if-statement.
    const customerId = await makeCustomer("plumber");
    const run = await openRun(db, { customerId, vertical: "plumber", reconType: "invoices_vs_bank", ...period });
    const runId = (run.ok && run.runId) as string;
    await ingest(db, runId, "ours", [{ sourceKey: "a", reference: "Z", amountCents: 100, occurredOn: new Date("2026-05-02") }]);
    await ingest(db, runId, "theirs", [{ sourceKey: "b", reference: "Z", amountCents: 100, occurredOn: new Date("2026-05-02") }]);
    await runReconciliation(db, runId);
    expect((await closeRun(db, runId, "owner@example.com")).ok).toBe(true);

    await expect(db.query("UPDATE recon_runs SET state = 'open' WHERE id = $1", [runId])).rejects.toThrow(/closed/);
    await expect(runReconciliation(db, runId)).rejects.toThrow(/closed/);
    await expect(ingest(db, runId, "ours", [{ sourceKey: "c", amountCents: 1 }])).rejects.toThrow(/closed/);
    const reopen = await openRun(db, { customerId, vertical: "plumber", reconType: "invoices_vs_bank", ...period });
    expect(reopen.ok).toBe(false);
    expect(!reopen.ok && reopen.reason).toBe("period_closed");
  });

  it("re-running while open discards the previous verdicts rather than stacking them", async () => {
    const customerId = await makeCustomer("plumber");
    const run = await openRun(db, { customerId, vertical: "plumber", reconType: "invoices_vs_bank", ...period });
    const runId = (run.ok && run.runId) as string;
    await ingest(db, runId, "ours", [{ sourceKey: "a", reference: "Q", amountCents: 100, occurredOn: new Date("2026-05-02") }]);
    await runReconciliation(db, runId);
    await ingest(db, runId, "theirs", [{ sourceKey: "b", reference: "Q", amountCents: 100, occurredOn: new Date("2026-05-02") }]);
    const second = await runReconciliation(db, runId);
    expect(second.matched).toBe(1);
    expect(second.unmatchedOurs).toBe(0);
    expect(second.balanced).toBe(true);
  });

  it("lists a customer's runs with the statutory ones first", async () => {
    const customerId = await makeCustomer("lawyer");
    await openRun(db, { customerId, vertical: "lawyer", reconType: "invoices_vs_bank", ...period });
    await openRun(db, { customerId, vertical: "lawyer", reconType: "client_account", ...period });
    const list = await runsFor(db, customerId);
    expect(list[0]!.statutory).toBe(true);
    expect(list.length).toBe(2);
  });

  it("refuses a reconciliation the vertical does not run", async () => {
    const out = await openRun(db, { customerId: plumber, vertical: "plumber", reconType: "client_account", ...period });
    expect(!out.ok && out.reason).toBe("unknown_type");
    expect((await runsFor(db, lawyer)).length).toBeGreaterThanOrEqual(0);
  });
});

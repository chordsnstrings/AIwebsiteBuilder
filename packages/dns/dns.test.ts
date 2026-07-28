// The cutover is ranked #1 of the five handovers that would end the company.
// 86% of these domains have live MX, and the failure is irreversible in
// perception even when technically reverted within minutes.
//
// So the tests are weighted accordingly: most of them are about mail-record
// detection, because a detector that is too narrow lets the disaster through
// and one that is too broad gets muted after the third false alarm.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, migrate, type Db } from "@adw/db";
import {
  CutoverPlanError,
  DohResolver,
  MAX_CHANGES,
  NoSnapshotError,
  NotApprovedError,
  StaticResolver,
  applyCutover,
  assertPlanSafe,
  changedMailKinds,
  detectProvider,
  diffDns,
  handleHold,
  isMailRecord,
  latestSnapshot,
  mailRecordsChanged,
  persistSnapshot,
  planCutover,
  snapshotDns,
  supportsDomainConnect,
  verifyCutover,
  type DnsRecord,
} from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

// A realistic zone: a live site, live Microsoft 365 mail, SPF, DKIM and DMARC.
// This shape is the 86% case.
const ZONE: DnsRecord[] = [
  { type: "A", name: "@", value: "203.0.113.10" },
  { type: "CNAME", name: "www", value: "oldhost.example.net" },
  { type: "MX", name: "@", value: "example-com.mail.protection.outlook.com", priority: 10 },
  { type: "TXT", name: "@", value: "v=spf1 include:spf.protection.outlook.com -all" },
  { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com" },
  { type: "TXT", name: "selector1._domainkey", value: "v=DKIM1; k=rsa; p=MIGfMA0GCSq" },
  { type: "TXT", name: "@", value: "google-site-verification=abc123" },
  { type: "NS", name: "@", value: "ns1.domaincontrol.com" },
  { type: "NS", name: "@", value: "ns2.domaincontrol.com" },
];

const target = { apexIp: "198.51.100.4", subdomain: "ridgeline.adwsites.com" };

async function makeCustomer(): Promise<string> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
     VALUES ('d',$1,'DNS Co','US','R1','no_site') RETURNING id`,
    [batch.id],
  );
  const row = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R1','DNS Co',$2,'en-US','UTC','active') RETURNING id`,
    [biz.id, `dns_${randomUUID()}@example.com`],
  );
  return row.id;
}

// ---------------------------------------------------------------------------

describe("mail-record detection — the whole risk lives here", () => {
  it("recognises MX", () => {
    expect(isMailRecord({ type: "MX", name: "@", value: "mail.example.com" })).toBe(true);
  });

  it("recognises SPF inside a TXT record", () => {
    // Checking only MX misses this, and destroying SPF sends a customer's
    // outbound mail to spam for weeks with nothing appearing broken.
    expect(isMailRecord({ type: "TXT", name: "@", value: "v=spf1 include:_spf.google.com ~all" })).toBe(true);
  });

  it("recognises DMARC by its label even with an unrecognisable value", () => {
    expect(isMailRecord({ type: "TXT", name: "_dmarc", value: "" })).toBe(true);
  });

  it("recognises DKIM by its _domainkey label even when the value was emptied", () => {
    // An emptied DKIM record has no recognisable value left — and an emptied
    // DKIM record is exactly the failure we are trying to catch.
    expect(isMailRecord({ type: "TXT", name: "selector1._domainkey", value: "" })).toBe(true);
  });

  it("does NOT treat an ordinary verification TXT as mail", () => {
    // Too broad is its own failure: verification TXT records churn constantly,
    // and an alarm that fires on them gets muted.
    expect(isMailRecord({ type: "TXT", name: "@", value: "google-site-verification=abc123" })).toBe(false);
    expect(isMailRecord({ type: "TXT", name: "@", value: "stripe-verification=xyz" })).toBe(false);
  });

  it("does not treat A, CNAME or NS as mail", () => {
    expect(isMailRecord({ type: "A", name: "@", value: "203.0.113.10" })).toBe(false);
    expect(isMailRecord({ type: "CNAME", name: "www", value: "x.example.net" })).toBe(false);
    expect(isMailRecord({ type: "NS", name: "@", value: "ns1.example.net" })).toBe(false);
  });

  it("names which protection was disturbed", () => {
    const after = ZONE.filter((r) => !(r.type === "TXT" && r.value.startsWith("v=spf1")));
    expect(changedMailKinds(diffDns(ZONE, after))).toEqual(["SPF"]);
  });
});

describe("diffing", () => {
  it("reports the two intended changes and nothing else", () => {
    const after = ZONE.map((r) =>
      r.type === "A" && r.name === "@"
        ? { ...r, value: target.apexIp }
        : r.type === "CNAME" && r.name === "www"
          ? { ...r, value: target.subdomain }
          : r,
    );
    const diff = diffDns(ZONE, after);
    expect(diff.changedCount).toBe(2);
    expect(mailRecordsChanged(diff)).toBe(false);
  });

  it("does not read record ORDER as a change", () => {
    // Order is not semantically meaningful in DNS, and a resolver is free to
    // return records in any sequence. A diff that flags reordering would fire
    // on every verification.
    const shuffled = [...ZONE].reverse();
    expect(diffDns(ZONE, shuffled).changedCount).toBe(0);
  });

  it("detects an MX record that changed", () => {
    const after = ZONE.map((r) => (r.type === "MX" ? { ...r, value: "mail.attacker.example" } : r));
    expect(mailRecordsChanged(diffDns(ZONE, after))).toBe(true);
  });

  it("detects an MX record that DISAPPEARED", () => {
    // The most damaging case of all, and the one with no `after` value to
    // inspect — which is why detection judges both sides.
    const after = ZONE.filter((r) => r.type !== "MX");
    expect(mailRecordsChanged(diffDns(ZONE, after))).toBe(true);
    expect(changedMailKinds(diffDns(ZONE, after))).toContain("MX");
  });

  it("detects a DKIM record that was emptied", () => {
    const after = ZONE.map((r) => (r.name === "selector1._domainkey" ? { ...r, value: "" } : r));
    expect(mailRecordsChanged(diffDns(ZONE, after))).toBe(true);
  });

  it("sees SPF destruction even when a verification TXT shares the same name", () => {
    // Regression. Grouping the apex TXT records into one joined string made
    // each individually unclassifiable, so removing SPF read as "some TXT at @
    // changed" and the mail check missed it. SPF sitting beside a search-console
    // token at the apex is the NORMAL zone shape, so this hid the failure in
    // essentially every real customer.
    const after = ZONE.filter((r) => !r.value.startsWith("v=spf1"));
    expect(after.some((r) => r.type === "TXT" && r.name === "@")).toBe(true); // the verification TXT is still there
    expect(mailRecordsChanged(diffDns(ZONE, after))).toBe(true);
    expect(changedMailKinds(diffDns(ZONE, after))).toEqual(["SPF"]);
  });

  it("does NOT fire when a verification TXT is ADDED beside an untouched SPF", () => {
    // The other direction. An alarm that fires when someone verifies a new SaaS
    // tool gets muted, and a muted alarm is not an alarm.
    const after = [...ZONE, { type: "TXT" as const, name: "@", value: "stripe-verification=xyz" }];
    const diff = diffDns(ZONE, after);
    expect(diff.changedCount).toBe(1);
    expect(mailRecordsChanged(diff)).toBe(false);
  });

  it("does NOT fire when only a verification TXT changed", () => {
    const after = ZONE.map((r) =>
      r.value.startsWith("google-site-verification") ? { ...r, value: "google-site-verification=new" } : r,
    );
    const diff = diffDns(ZONE, after);
    expect(diff.changedCount).toBe(1);
    expect(mailRecordsChanged(diff)).toBe(false);
  });
});

describe("snapshots", () => {
  it("captures every record type", async () => {
    const snap = await snapshotDns("example.com", StaticResolver.from("example.com", ZONE));
    expect(snap.records).toHaveLength(ZONE.length);
    for (const type of ["A", "CNAME", "MX", "TXT", "NS"]) {
      expect(snap.records.some((r) => r.type === type)).toBe(true);
    }
  });

  it("propagates a resolver failure rather than recording an absence", async () => {
    // A snapshot that silently omits MX because the lookup failed would later
    // "prove" the customer had no mail to break.
    const broken = {
      async resolve(_d: string, type: string) {
        if (type === "MX") throw new Error("SERVFAIL");
        return [];
      },
    };
    await expect(snapshotDns("example.com", broken as never)).rejects.toThrow(/SERVFAIL/);
  });

  it("is append-only in the database — the trigger rejects an update", async () => {
    const customerId = await makeCustomer();
    const snap = await snapshotDns("example.com", StaticResolver.from("example.com", ZONE));
    const id = await persistSnapshot(db, customerId, snap);
    // A snapshot is evidence. An editable before-state is not one.
    await expect(db.query("UPDATE dns_snapshots SET domain = 'other.com' WHERE id = $1", [id])).rejects.toThrow();
    await expect(db.query("DELETE FROM dns_snapshots WHERE id = $1", [id])).rejects.toThrow();
  });

  it("round-trips through the database", async () => {
    const customerId = await makeCustomer();
    const snap = await snapshotDns("example.com", StaticResolver.from("example.com", ZONE));
    await persistSnapshot(db, customerId, snap);
    const loaded = await latestSnapshot(db, customerId, "example.com");
    expect(loaded?.records).toHaveLength(ZONE.length);
    expect(loaded?.provider).toBe("godaddy");
  });
});

describe("provider detection", () => {
  it("maps nameservers to a known provider", () => {
    expect(detectProvider(["ns1.domaincontrol.com", "ns2.domaincontrol.com"])).toBe("godaddy");
    expect(detectProvider(["kim.ns.cloudflare.com"])).toBe("cloudflare");
    expect(detectProvider(["ns-1234.awsdns-56.org"])).toBe("route53");
    expect(detectProvider(["ns1.unknown-host.net"])).toBeNull();
  });

  it("knows which providers support one-click Domain Connect", () => {
    expect(supportsDomainConnect("godaddy")).toBe(true);
    expect(supportsDomainConnect("cloudflare")).toBe(false);
    expect(supportsDomainConnect(null)).toBe(false);
  });
});

describe("planning — a dangerous plan must not be constructible", () => {
  const snapshot = { id: "snap-1", domain: "example.com", records: ZONE, provider: "godaddy", takenAt: new Date() };

  it("produces exactly two changes", () => {
    const plan = planCutover(snapshot, target);
    expect(plan.changes).toHaveLength(MAX_CHANGES);
    expect(plan.changes.map((c) => `${c.type} ${c.name}`)).toEqual(["A @", "CNAME www"]);
  });

  it("refuses to plan without a persisted snapshot", () => {
    const { id: _drop, ...unsaved } = snapshot;
    expect(() => planCutover(unsaved, target)).toThrow(NoSnapshotError);
  });

  it("refuses an apex CNAME", () => {
    // Classic DNS cannot CNAME at the root, and most regional providers do not
    // support flattening. A record on apex is the universal path.
    expect(() => assertPlanSafe([{ op: "upsert", type: "CNAME", name: "@", value: "x.example" }, { op: "upsert", type: "CNAME", name: "www", value: "y.example" }])).toThrow(
      CutoverPlanError,
    );
  });

  it("refuses a plan that touches MX", () => {
    expect(() =>
      assertPlanSafe([
        { op: "upsert", type: "A", name: "@", value: "1.2.3.4" },
        { op: "upsert", type: "MX", name: "@", value: "mail.example" },
      ]),
    ).toThrow(/never touch MX/);
  });

  it("refuses a plan that touches TXT", () => {
    expect(() =>
      assertPlanSafe([
        { op: "upsert", type: "A", name: "@", value: "1.2.3.4" },
        { op: "upsert", type: "TXT", name: "@", value: "v=spf1 -all" },
      ]),
    ).toThrow(/never touch TXT/);
  });

  it("refuses to delegate nameservers", () => {
    expect(() =>
      assertPlanSafe([
        { op: "upsert", type: "A", name: "@", value: "1.2.3.4" },
        { op: "upsert", type: "NS", name: "@", value: "ns1.adwsites.com" },
      ]),
    ).toThrow(/never delegate/);
  });

  it("refuses a third change", () => {
    expect(() =>
      assertPlanSafe([
        { op: "upsert", type: "A", name: "@", value: "1.2.3.4" },
        { op: "upsert", type: "CNAME", name: "www", value: "x.example" },
        { op: "upsert", type: "A", name: "shop", value: "1.2.3.5" },
      ]),
    ).toThrow(/exactly 2 records/);
  });

  it("refuses a non-IPv4 apex value", () => {
    expect(() => planCutover(snapshot, { ...target, apexIp: "ridgeline.adwsites.com" })).toThrow(CutoverPlanError);
  });

  it("gives provider-specific instructions that warn off the mail records", () => {
    const plan = planCutover(snapshot, target);
    expect(plan.method).toBe("domain_connect");
    expect(plan.instructions.join(" ")).toMatch(/GoDaddy/);
    expect(plan.instructions.join(" ")).toMatch(/MX or TXT.*That is your email/is);
  });
});

describe("applying", () => {
  it("refuses without the customer's explicit approval", async () => {
    const customerId = await makeCustomer();
    const snap = await snapshotDns("example.com", StaticResolver.from("example.com", ZONE));
    const snapshotId = await persistSnapshot(db, customerId, snap);
    const plan = planCutover({ ...snap, id: snapshotId }, target);
    await expect(applyCutover(plan, { db, customerId }, null)).rejects.toThrow(NotApprovedError);
  });

  it("refuses when the named snapshot does not belong to this customer and domain", async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    const snap = await snapshotDns("example.com", StaticResolver.from("example.com", ZONE));
    const snapshotId = await persistSnapshot(db, a, snap);
    const plan = planCutover({ ...snap, id: snapshotId }, target);
    await expect(applyCutover(plan, { db, customerId: b }, new Date())).rejects.toThrow(NoSnapshotError);
  });

  it("records an approved cutover", async () => {
    const customerId = await makeCustomer();
    const snap = await snapshotDns("example.com", StaticResolver.from("example.com", ZONE));
    const snapshotId = await persistSnapshot(db, customerId, snap);
    const plan = planCutover({ ...snap, id: snapshotId }, target);
    const record = await applyCutover(plan, { db, customerId }, new Date());
    expect(record.status).toBe("applied");
    const row = await db.one<{ status: string; customer_approved_at: string | null }>(
      "SELECT status, customer_approved_at FROM dns_cutovers WHERE id = $1",
      [record.id],
    );
    expect(row.status).toBe("applied");
    expect(row.customer_approved_at).not.toBeNull();
  });
});

describe("verification — the alarm", () => {
  async function setup(after: DnsRecord[]) {
    const customerId = await makeCustomer();
    const resolver = StaticResolver.from("example.com", ZONE);
    const snap = await snapshotDns("example.com", resolver);
    const snapshotId = await persistSnapshot(db, customerId, snap);
    const plan = planCutover({ ...snap, id: snapshotId }, target);
    const cutover = await applyCutover(plan, { db, customerId }, new Date());
    // Propagation happened; re-resolve against the new state.
    return { customerId, cutoverId: cutover.id, resolver: StaticResolver.from("example.com", after) };
  }

  const correctlyApplied = ZONE.map((r) =>
    r.type === "A" && r.name === "@"
      ? { ...r, value: target.apexIp }
      : r.type === "CNAME" && r.name === "www"
        ? { ...r, value: target.subdomain }
        : r,
  );

  it("verifies a clean cutover", async () => {
    const { customerId, cutoverId, resolver } = await setup(correctlyApplied);
    const outcome = await verifyCutover(cutoverId, { db, customerId }, resolver);
    expect(outcome.status).toBe("verified");
    expect(outcome.mailRecordsChanged).toBe(false);
    expect(outcome.diff.changedCount).toBe(2);
  });

  it("reverts and raises SEV1 when an MX record moved — even though OUR two records were right", async () => {
    // A third party editing MX during our propagation window is still our
    // incident, because we are the change the customer will remember.
    const sabotaged = correctlyApplied.map((r) =>
      r.type === "MX" ? { ...r, value: "mail.somewhere-else.example" } : r,
    );
    const { customerId, cutoverId, resolver } = await setup(sabotaged);
    const outcome = await verifyCutover(cutoverId, { db, customerId }, resolver);

    expect(outcome.status).toBe("reverted");
    expect(outcome.mailRecordsChanged).toBe(true);
    expect(outcome.mailKinds).toContain("MX");
    expect(outcome.revertPlan?.some((c) => c.type === "MX")).toBe(true);

    const row = await db.one<{ status: string; mail_records_changed: boolean }>(
      "SELECT status, mail_records_changed FROM dns_cutovers WHERE id = $1",
      [cutoverId],
    );
    expect(row.status).toBe("reverted");
    expect(row.mail_records_changed).toBe(true);

    const exc = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM exceptions WHERE trigger = 'dns_mail_records_changed' AND severity = 1 AND context->>'cutoverId' = $1",
      [cutoverId],
    );
    expect(Number(exc.n)).toBe(1);
  });

  it("reverts when SPF was destroyed, which no MX-only check would see", async () => {
    const sabotaged = correctlyApplied.filter((r) => !r.value.startsWith("v=spf1"));
    const { customerId, cutoverId, resolver } = await setup(sabotaged);
    const outcome = await verifyCutover(cutoverId, { db, customerId }, resolver);
    expect(outcome.mailRecordsChanged).toBe(true);
    expect(outcome.mailKinds).toContain("SPF");
  });
});

describe("holds — outcomes, not failures", () => {
  it("leaves the subdomain live in every case", () => {
    const holds = [
      { kind: "no_registrar_access", touches: 1, parkAfterDays: 10 },
      { kind: "third_party_controls_dns", offerTransfer: true },
      { kind: "domain_expiring", expiresAt: new Date("2026-09-01") },
      { kind: "propagation_slow", elapsedHours: 50 },
      { kind: "declined" },
    ] as const;
    for (const h of holds) expect(handleHold(h).subdomainRemainsLive).toBe(true);
  });

  it("parks after four touches, not before", () => {
    expect(handleHold({ kind: "no_registrar_access", touches: 3, parkAfterDays: 10 }).halt).toBe(false);
    expect(handleHold({ kind: "no_registrar_access", touches: 4, parkAfterDays: 10 }).halt).toBe(true);
  });

  it("halts on an expiring domain and refuses to renew on the customer's behalf", () => {
    const d = handleHold({ kind: "domain_expiring", expiresAt: new Date("2026-09-01") });
    expect(d.halt).toBe(true);
    expect(d.message).toMatch(/do not renew for them/i);
  });

  it("treats slow propagation as not a failure", () => {
    const d = handleHold({ kind: "propagation_slow", elapsedHours: 50 });
    expect(d.halt).toBe(false);
    expect(d.message).toMatch(/not a failure/i);
  });

  it("accepts a declined cutover without pressure", () => {
    expect(handleHold({ kind: "declined" }).message).toMatch(/subdomain is the product/i);
  });
});

describe("DoH resolver", () => {
  const doh = (body: unknown, ok = true, status = 200): DohResolver =>
    new DohResolver({
      fetchImpl: (async () =>
        ({ ok, status, json: async () => body }) as unknown as Response) as unknown as typeof fetch,
    });

  it("parses MX priority out of the answer", async () => {
    const records = await doh({
      Status: 0,
      Answer: [{ name: "example.com.", type: 15, data: "10 mail.protection.outlook.com." }],
    }).resolve("example.com", "MX");
    expect(records[0]).toMatchObject({ type: "MX", name: "@", priority: 10, value: "mail.protection.outlook.com" });
  });

  it("relabels a subdomain answer relative to the zone", async () => {
    const records = await doh({
      Status: 0,
      Answer: [{ name: "www.example.com.", type: 5, data: "target.example.net." }],
    }).resolve("example.com", "CNAME");
    expect(records[0]?.name).toBe("www");
  });

  it("throws on a transport failure rather than reporting no records", async () => {
    await expect(doh({}, false, 502).resolve("example.com", "MX")).rejects.toThrow(/502/);
  });

  it("throws on a SERVFAIL status rather than reporting no records", async () => {
    // Status 2 is SERVFAIL. Reading it as "no MX" is how a snapshot ends up
    // claiming the customer had no mail to break.
    await expect(doh({ Status: 2 }).resolve("example.com", "MX")).rejects.toThrow(/status 2/);
  });

  it("treats NXDOMAIN as a genuine absence", async () => {
    await expect(doh({ Status: 3 }).resolve("example.com", "MX")).resolves.toEqual([]);
  });
});

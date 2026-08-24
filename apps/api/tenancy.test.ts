// ⛔ THE HOLE: every owner-facing route checked that SOMEBODY was signed in and
// none of them checked WHO.
//
// The whole of `/agent` was written as `if (user(c) === null) return 401`, forty
// times. A real customer with a real session on the dashboard we shipped them
// could read every other customer's enquiries, missed calls, uploaded documents,
// bookings and Q&A pack — and write to them — by editing one uuid in the URL.
// `/ops/opportunities` handed the same session the entire enterprise pipeline.
//
// These tests drive the real app through the real middleware. The pure
// `classify`/`decideForOwner` cases below cover the shapes a fixture cannot
// easily reach; the integration cases prove the wiring, because a guard that is
// correct and unmounted is the failure this codebase keeps finding.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, migrate, type Db } from "@adw/db";
import { LocalKeyWrapper, LocalPgBackend, type SecretsBackend } from "@adw/vault";
import type { SessionUser } from "@adw/auth";
import { createApp } from "./src/app.ts";
import { classify, decideForOwner, isVisitorRoute, mayActOn } from "./src/tenancy.ts";

const URL = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
let vault: SecretsBackend;

const customer = (customerId: string | null): SessionUser => ({
  id: `u_${customerId ?? "none"}`,
  email: "owner@example.com",
  role: "customer",
  customerId,
  totpEnabled: false,
});
const OPERATOR: SessionUser = {
  id: "u_ops", email: "ops@adw.example", role: "superadmin", customerId: null, totpEnabled: false,
};

const appAs = (user: SessionUser | null) => createApp({ db, vault, forceMock: true, authOverride: user });

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  vault = new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64)));
});
afterAll(async () => {
  await db?.close();
});

/** A customer with one enquiry and one queue item of their own. */
async function seedCustomer(): Promise<{ customerId: string; businessId: string; enquiryId: string; queueId: string }> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical, phone_e164, city)
     VALUES ('d',$1,'Tenancy Plumbing','GB','R1','no_site','plumber','+447700900000','Leeds') RETURNING id`,
    [batch.id],
  );
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R1','Tenancy Plumbing',$2,'en-GB','Europe/London','active') RETURNING id`,
    [biz.id, `tenancy_${randomUUID()}@example.com`],
  );
  const enq = await db.one<{ id: string }>(
    `INSERT INTO enquiries (customer_id, business_id, need, contact, urgency, status)
     VALUES ($1,$2,'leaking tap','07700900111','normal','open') RETURNING id`,
    [cust.id, biz.id],
  );
  const exc = await db.one<{ id: string }>(
    `INSERT INTO exceptions (customer_id, trigger, severity, context, system_action, recommendation)
     VALUES ($1,'reminder_due',2,'{}','raised','call them') RETURNING id`,
    [cust.id],
  );
  return { customerId: cust.id, businessId: biz.id, enquiryId: enq.id, queueId: exc.id };
}

// ---------------------------------------------------------------------------
describe("⛔ one customer cannot reach another customer's data", () => {
  it("refuses every /agent/:customerId route to a different customer", async () => {
    const mine = await seedCustomer();
    const theirs = await seedCustomer();
    const asMe = appAs(customer(mine.customerId));

    // Every collection route the dashboard calls, aimed at somebody else's id.
    for (const path of [
      "gaps", "reminders", "journeys", "watches", "findings",
      "reconciliations", "publications", "assets", "calls/missed",
      "enquiries", "queue", "bookings",
    ]) {
      const res = await asMe.request(`/agent/${theirs.customerId}/${path}`);
      expect(`${path}:${res.status}`).toBe(`${path}:403`);
    }
    // And my own id still works, so the guard is discriminating rather than
    // simply refusing everything — the failure mode that would look identical
    // from a test that only checked the denial.
    const ok = await asMe.request(`/agent/${mine.customerId}/enquiries`);
    expect(ok.status).toBe(200);
  });

  it("refuses an id-addressed row belonging to another customer", async () => {
    const mine = await seedCustomer();
    const theirs = await seedCustomer();
    const asMe = appAs(customer(mine.customerId));

    const resolveTheirs = await asMe.request(`/agent/enquiries/${theirs.enquiryId}/resolve`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json" },
    });
    expect(resolveTheirs.status).toBe(403);

    // The row is untouched: a 403 that still performed the write would pass a
    // status-code assertion and lose the data anyway.
    const after = await db.one<{ status: string }>("SELECT status FROM enquiries WHERE id = $1", [theirs.enquiryId]);
    expect(after.status).toBe("open");

    const mineOk = await asMe.request(`/agent/enquiries/${mine.enquiryId}/resolve`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json" },
    });
    expect(mineOk.status).toBe(200);
  });

  it("refuses the operator console to a signed-in customer", async () => {
    // ⛔ 403 for the anonymous caller too, matching `requireOperator` in
    // app.ts: a uniform refusal does not tell a prober whether the difference
    // is a missing cookie or the wrong role.
    const mine = await seedCustomer();
    expect((await appAs(customer(mine.customerId)).request("/ops/opportunities")).status).toBe(403);
    expect((await appAs(null).request("/ops/opportunities")).status).toBe(403);
    expect((await appAs(OPERATOR).request("/ops/opportunities")).status).toBe(200);
  });

  it("lets an operator through to any customer", async () => {
    const theirs = await seedCustomer();
    const res = await appAs(OPERATOR).request(`/agent/${theirs.customerId}/enquiries`);
    expect(res.status).toBe(200);
  });

  it("⛔ keeps the visitor surface open — the customer's own website calls it", async () => {
    // The cost of over-tightening here is a chat box that says "Could not reach
    // the agent just now." on every site we have ever deployed, so it is
    // asserted rather than assumed.
    const mine = await seedCustomer();
    const anon = appAs(null);
    const res = await anon.request("/agent/session", {
      method: "POST",
      body: JSON.stringify({ customerId: mine.customerId }),
      headers: { "content-type": "application/json" },
    });
    // 404 = no approved pack for this fixture, which is the route running. A
    // 401/403 would mean the middleware ate the visitor path.
    expect([200, 404]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
describe("the decision, without a database", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";

  it("a customer session naming no customer authorises nothing", () => {
    // Treating "no customer" as "any customer" is the exact shape of the bug.
    expect(mayActOn(customer(null), id)).toEqual({ status: 403, error: "forbidden" });
  });

  it("distinguishes not-signed-in from signed-in-as-someone-else", () => {
    expect(mayActOn(null, id)).toEqual({ status: 401, error: "unauthorised" });
    expect(mayActOn(customer(other), id)).toEqual({ status: 403, error: "forbidden" });
    expect(mayActOn(customer(id), id)).toBeNull();
    expect(mayActOn(OPERATOR, id)).toBeNull();
  });

  it("⛔ answers 401 rather than 404 to an anonymous prober", () => {
    // A 404 to a caller with no session turns the route into an oracle for
    // which ids exist.
    expect(decideForOwner(null, { kind: "missing" })).toEqual({ status: 401, error: "unauthorised" });
    expect(decideForOwner(customer(id), { kind: "missing" })).toEqual({ status: 404, error: "not found" });
  });

  it("⛔ a speculative row belongs to no customer, so only an operator may touch it", () => {
    expect(decideForOwner(customer(id), { kind: "unowned" })).toEqual({ status: 403, error: "forbidden" });
    expect(decideForOwner(OPERATOR, { kind: "unowned" })).toBeNull();
  });

  it("⛔ fails closed on a resource it does not recognise", () => {
    // The point of the middleware: a route added later is guarded before its
    // author thinks about it.
    expect(decideForOwner(customer(id), { kind: "unknown_resource" })).toEqual({ status: 403, error: "forbidden" });
    expect(decideForOwner(OPERATOR, { kind: "unknown_resource" })).toBeNull();
  });

  it("classifies the two path shapes and the compound one", () => {
    expect(classify("GET", `/agent/${id}/enquiries`)).toEqual({ kind: "customer", customerId: id });
    expect(classify("POST", `/agent/gaps/${id}/approve`)).toEqual({ kind: "resource", resource: "gaps", id });
    expect(classify("POST", `/agent/reconciliations/differences/${id}/resolve`)).toEqual({
      kind: "resource", resource: "reconciliations/differences", id,
    });
    expect(classify("GET", "/ops/opportunities")).toEqual({ kind: "operator" });
    expect(classify("POST", "/agent/ask")).toEqual({ kind: "open" });
  });

  it("⛔ the visitor list is closed by method as well as by path", () => {
    // GET /agent/uploads/:id serves the FILE. It shares a prefix with the
    // public POST that receives one, and reading is not writing.
    expect(isVisitorRoute("POST", "/agent/uploads")).toBe(true);
    expect(isVisitorRoute("GET", `/agent/uploads/${id}`)).toBe(false);
    expect(isVisitorRoute("POST", "/agent/bookings")).toBe(true);
    expect(isVisitorRoute("GET", `/agent/${id}/bookings`)).toBe(false);
  });
});

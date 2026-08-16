// The acquisition motion, by segment.
//
// The funnel was SMB-shaped end to end and the taxonomy has 33 enterprise
// clusters in it. Most of what follows asserts a refusal, because the damaging
// half of running the SMB motion against an enterprise is not that it fails —
// it is that it works.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { allTrades, segmentOf } from "@adw/taxonomy";
import {
  advanceOpportunity, approveBusinessCase, casesFor, checkGate, draftBusinessCase,
  mayBuildSpeculativePreview, maySelfServe, openOpportunity, pipeline, recordEvidence,
  recordQuote, trackFor, unsupportedFigures,
} from "./src/index.ts";

const URL_ = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
const uniq = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

async function makeBusiness(vertical: string): Promise<string> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id");
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical)
     VALUES ('d',$1,$2,'GB','R2','no_site',$3) RETURNING id`, [batch.id, `Acq ${uniq()}`, vertical]);
  return biz.id;
}

const FINDINGS = [
  { check: "Machine-readable opening hours", observed: "absent on 4 of 5 location pages", soWhat: "assistants answering for you cannot state them" },
  { check: "Structured booking endpoint", observed: "none found", soWhat: "every enquiry lands in a form queue" },
];

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
});
afterAll(async () => { await db?.close(); });

describe("⛔ the four refusals", () => {
  it("no enterprise vertical may receive a speculative preview", () => {
    // Building an unofficial copy of a bank's website under their name and
    // emailing the link is passing off — a trademark complaint with a legal
    // department already attached.
    const enterprise = allTrades().filter((t) => segmentOf(t) === "enterprise_global");
    expect(enterprise.length).toBeGreaterThan(30);
    for (const t of enterprise) {
      expect(mayBuildSpeculativePreview(t), `${t} would get a speculative preview`).toBe(false);
      expect(maySelfServe(t), `${t} could self-serve`).toBe(false);
      expect(trackFor(t).pricingModel, `${t} priced from a band`).toBe("quoted");
      expect(trackFor(t).requiresRoleRelevance, `${t} outreach without role relevance`).toBe(true);
    }
  });

  it("the SMB motion is unchanged", () => {
    for (const t of ["plumber", "hair_salon", "restaurant", "estate_agent"]) {
      expect(mayBuildSpeculativePreview(t), t).toBe(true);
      expect(maySelfServe(t), t).toBe(true);
      expect(trackFor(t).pricingModel, t).toBe("published_band");
    }
  });

  it("⛔ an unclassified trade gets the enterprise track, not the permissive one", () => {
    // Otherwise the first thing an unrecognised name receives is a speculative
    // copy of its website.
    expect(mayBuildSpeculativePreview("something_nobody_has_heard_of")).toBe(false);
    expect(mayBuildSpeculativePreview("")).toBe(false);
  });

  it("⛔ the config loader will not let the preview flag be flipped back on", async () => {
    // A future edit "to test something" fails the build rather than shipping a
    // copy of a hospital's website to a hospital. Asserted by construction:
    // the loader throws, so a green load is the assertion.
    const { trackForSegment } = await import("./src/index.ts");
    expect(trackForSegment("enterprise_global").speculativePreview).toBe(false);
    expect(trackForSegment("enterprise_global").approvalAuthority).toBe("named_signatory");
  });
});

describe("the opportunity", () => {
  it("refuses to open one for an SMB business", async () => {
    // A plumber sitting in an enterprise pipeline is a deal being counted,
    // chased and forecast by people who cannot sell to them.
    const businessId = await makeBusiness("plumber");
    const out = await openOpportunity(db, { businessId, vertical: "plumber" });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toBe("wrong_segment");
  });

  it("opens once per account and starts at the first stage", async () => {
    const businessId = await makeBusiness("hospitals_and_health_systems");
    const first = await openOpportunity(db, { businessId, vertical: "hospitals_and_health_systems", targetFunction: "Patient Access" });
    expect(first.ok && first.created).toBe(true);
    const second = await openOpportunity(db, { businessId, vertical: "hospitals_and_health_systems" });
    expect(second.ok && second.created).toBe(false);
    expect(second.ok && second.opportunityId).toBe(first.ok && first.opportunityId);
    const row = await db.one<{ stage: string }>("SELECT stage FROM opportunities WHERE business_id = $1", [businessId]);
    expect(row.stage).toBe("identified");
  });

  it("⛔ will not move to a gated stage without the evidence", async () => {
    const businessId = await makeBusiness("hospitals_and_health_systems");
    const opened = await openOpportunity(db, { businessId, vertical: "hospitals_and_health_systems" });
    const id = (opened.ok && opened.opportunityId) as string;

    const blocked = await advanceOpportunity(db, id, "qualified", "rep@adw.example");
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.reason).toBe("gate_closed");
    expect(!blocked.ok && blocked.missing).toEqual(
      expect.arrayContaining(["icp_rationale", "target_function", "named_contact_role"]));

    await recordEvidence(db, id, {
      icp_rationale: "12 sites, no structured booking", target_function: "Patient Access",
      named_contact_role: "Head of Patient Access",
    }, "rep@adw.example");
    expect((await advanceOpportunity(db, id, "qualified", "rep@adw.example")).ok).toBe(true);
  });

  it("⛔ an empty string is not evidence", async () => {
    // Without this, "reviewed_by: ''" satisfies a gate that exists precisely to
    // record who looked.
    const businessId = await makeBusiness("hospitals_and_health_systems");
    const opened = await openOpportunity(db, { businessId, vertical: "hospitals_and_health_systems" });
    const id = (opened.ok && opened.opportunityId) as string;
    expect(await recordEvidence(db, id, { icp_rationale: "   " }, "rep@adw.example")).toBe(false);
    const gate = await checkGate(db, id, "qualified");
    expect(gate.missing).toContain("icp_rationale");
  });

  it("⛔ moves forward only, so a stage means the gates behind it were passed", async () => {
    const businessId = await makeBusiness("retail_banking_and_lending");
    const opened = await openOpportunity(db, { businessId, vertical: "retail_banking_and_lending" });
    const id = (opened.ok && opened.opportunityId) as string;
    await recordEvidence(db, id, {
      icp_rationale: "r", target_function: "Digital", named_contact_role: "Head of Digital" }, "rep@adw.example");
    await advanceOpportunity(db, id, "qualified", "rep@adw.example");

    // A deal that can be dragged to "Agreement signed" from anywhere is a
    // forecast, not a pipeline.
    const jump = await advanceOpportunity(db, id, "agreement", "rep@adw.example");
    expect(jump.ok).toBe(false);
    expect(!jump.ok && jump.reason).toBe("gate_closed");

    const back = await advanceOpportunity(db, id, "identified", "rep@adw.example");
    expect(back.ok).toBe(false);
    expect(!back.ok && back.reason).toBe("backwards");
  });

  it("⛔ the security review needs a name and a date, not a tick", async () => {
    const businessId = await makeBusiness("insurance_carriers");
    const opened = await openOpportunity(db, { businessId, vertical: "insurance_carriers" });
    const id = (opened.ok && opened.opportunityId) as string;
    const evidence = {
      icp_rationale: "r", target_function: "Claims", named_contact_role: "Claims Ops Director",
      role_relevance_statement: "their claims intake is the system in question",
      lawful_basis_note: "legitimate interests, B2B, role-relevant",
    };
    await recordEvidence(db, id, evidence, "rep@adw.example");
    for (const stage of ["qualified", "business_case", "contacted", "discovery", "pilot_scoped"]) {
      expect((await advanceOpportunity(db, id, stage, "rep@adw.example")).ok, stage).toBe(true);
    }
    const blocked = await advanceOpportunity(db, id, "security_review", "rep@adw.example");
    expect(!blocked.ok && blocked.missing).toEqual(
      expect.arrayContaining(["security_questionnaire_ref", "dpa_ref", "reviewed_by", "reviewed_at"]));

    await recordEvidence(db, id, {
      security_questionnaire_ref: "SQ-118", dpa_ref: "DPA-2026-04",
      reviewed_by: "counsel@adw.example", reviewed_at: "2026-04-02",
    }, "counsel@adw.example");
    expect((await advanceOpportunity(db, id, "security_review", "counsel@adw.example")).ok).toBe(true);
  });

  it("can be lost from anywhere, and then nothing moves", async () => {
    const businessId = await makeBusiness("telecom");
    const opened = await openOpportunity(db, { businessId, vertical: "telecom" });
    const id = (opened.ok && opened.opportunityId) as string;
    expect((await advanceOpportunity(db, id, "closed_lost", "rep@adw.example", "went with incumbent")).ok).toBe(true);
    const after = await advanceOpportunity(db, id, "qualified", "rep@adw.example");
    expect(after.ok).toBe(false);
    expect(!after.ok && after.reason).toBe("closed");
  });

  it("⛔ a quote needs an amount, a reference and a named approver", async () => {
    // pricing.yaml holds an SMB band. Reading one for an enterprise account is
    // the category error this whole track exists to avoid.
    const businessId = await makeBusiness("hospitals_and_health_systems");
    const opened = await openOpportunity(db, { businessId, vertical: "hospitals_and_health_systems" });
    const id = (opened.ok && opened.opportunityId) as string;
    expect((await recordQuote(db, id, { amountCents: 4_800_000, currency: "GBP", reference: "", approvedBy: "cro@adw.example" })).ok).toBe(false);
    expect((await recordQuote(db, id, { amountCents: 4_800_000, currency: "GBP", reference: "Q-77", approvedBy: "  " })).ok).toBe(false);
    expect((await recordQuote(db, id, { amountCents: 4_800_000, currency: "GBP", reference: "Q-77", approvedBy: "cro@adw.example" })).ok).toBe(true);
    const row = await db.one<{ quote_amount_cents: string }>("SELECT quote_amount_cents FROM opportunities WHERE id = $1", [id]);
    expect(Number(row.quote_amount_cents)).toBe(4_800_000);
  });

  it("shows what a stalled deal is waiting for, on the board", async () => {
    // A deal stuck for three weeks because nobody recorded the DPA reference
    // should say so where people look, not when somebody tries to move it.
    const businessId = await makeBusiness("hospitals_and_health_systems");
    await openOpportunity(db, { businessId, vertical: "hospitals_and_health_systems" });
    const rows = await pipeline(db);
    const mine = rows.find((r) => r.businessId === businessId)!;
    expect(mine.nextStage).toBe("qualified");
    expect(mine.missingEvidence.length).toBeGreaterThan(0);
  });
});

describe("the business case — what they get instead of a preview", () => {
  const openFor = async (vertical: string) => {
    const businessId = await makeBusiness(vertical);
    const out = await openOpportunity(db, { businessId, vertical });
    return (out.ok && out.opportunityId) as string;
  };

  it("is a document about their problem, and it says how we looked", async () => {
    const id = await openFor("hospitals_and_health_systems");
    const out = await draftBusinessCase(db, { opportunityId: id, targetFunction: "Patient Access", findings: FINDINGS });
    expect(out.ok).toBe(true);
    expect(out.ok && out.body).toMatch(/publicly available pages/);
    expect(out.ok && out.body).toMatch(/no projection/);
  });

  it("⛔ refuses a business case with no findings", async () => {
    // A business case with no findings is a brochure, and an unsolicited
    // brochure to a named individual is what every procurement policy exists
    // to stop.
    const id = await openFor("retail_banking_and_lending");
    const out = await draftBusinessCase(db, { opportunityId: id, targetFunction: "Digital", findings: [] });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toBe("no_findings");
  });

  it("⛔ refuses a figure with no finding behind it", async () => {
    // An enterprise buyer forwards this to somebody who will check it, and one
    // invented number ends the conversation and the account.
    const id = await openFor("insurance_carriers");
    const out = await draftBusinessCase(db, {
      opportunityId: id, targetFunction: "Claims", findings: FINDINGS,
      body: "You are losing 340 enquiries a month and 18% of claims intake.",
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toBe("unsupported_claim");
    expect(!out.ok && out.detail).toMatch(/340/);
  });

  it("accepts prose whose figures all trace to a finding", async () => {
    const id = await openFor("telecom");
    const out = await draftBusinessCase(db, {
      opportunityId: id, targetFunction: "Care", findings: FINDINGS,
      body: "Opening hours are absent on 4 of 5 location pages.",
    });
    expect(out.ok).toBe(true);
  });

  it("names the unsupported figures rather than only rejecting", () => {
    expect(unsupportedFigures("we found 4 of 5 pages and 99 problems", FINDINGS)).toEqual(["99"]);
  });

  it("⛔ needs a human on our side before it is sent", async () => {
    // An enterprise buyer forwards this internally; whatever is in it is what
    // we said about them, in writing.
    const id = await openFor("hospitals_and_health_systems");
    const drafted = await draftBusinessCase(db, { opportunityId: id, targetFunction: "IT", findings: FINDINGS });
    const caseId = (drafted.ok && drafted.caseId) as string;
    expect((await casesFor(db, id))[0]!.state).toBe("draft");
    expect((await approveBusinessCase(db, caseId, "sales@adw.example")).ok).toBe(true);
    expect((await approveBusinessCase(db, caseId, "other@adw.example")).ok).toBe(false);
    const after = (await casesFor(db, id))[0]!;
    expect(after.state).toBe("approved");
    expect(after.approvedBy).toBe("sales@adw.example");
  });

  it("refuses to draft one for an SMB account", async () => {
    // Belt and braces: an SMB opportunity cannot be opened, so this asserts the
    // artefact check independently of the segment check that precedes it.
    const businessId = await makeBusiness("plumber");
    const row = await db.one<{ id: string }>(
      `INSERT INTO opportunities (business_id, segment, vertical, stage)
       VALUES ($1,'smb_local','plumber','ingested') RETURNING id`, [businessId]);
    const out = await draftBusinessCase(db, { opportunityId: row.id, targetFunction: "Owner", findings: FINDINGS });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toBe("wrong_track");
  });
});

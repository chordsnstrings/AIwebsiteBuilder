// The Architect decides what a business receives. Two failure modes matter and
// they pull in opposite directions: guessing a vertical produces a bad preview
// that costs a complaint, and escalating too readily makes the system need a
// human per customer. So most of these tests are about the escalation boundary.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, migrate, type Db } from "@adw/db";
import {
  ManifestCatalogueError,
  assertInCatalogue,
  bookingCoverageTooHigh,
  buildManifest,
  catalogue,
  classify,
  classifyDeterministic,
  detectModifiers,
  isProhibited,
  loadManifest,
  persistManifest,
  verticalPlaybook,
  type ArchitectInput,
  type SiteAudit,
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

const audit = (over: Partial<SiteAudit> = {}): SiteAudit => ({
  hasWebsite: true,
  pricingFound: false,
  bookingFound: false,
  hasServiceSchema: false,
  pageCount: 8,
  wordCount: 900,
  transactabilityGap: true,
  topDefects: ["no_service_schema"],
  ...over,
});

const input = (over: Partial<ArchitectInput> = {}): ArchitectInput => ({
  businessId: randomUUID(),
  name: "Ridgeline Roofing",
  category: "roofer",
  city: "Boise",
  siteAudit: audit(),
  ...over,
});

async function makeBusiness(): Promise<string> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
     VALUES ('d',$1,'Arch Co','US','R1','no_site') RETURNING id`,
    [batch.id],
  );
  return biz.id;
}

// ---------------------------------------------------------------------------

describe("classification", () => {
  it("maps a known category to its vertical with high confidence", () => {
    const c = classifyDeterministic(input());
    expect(c.vertical).toBe("roofing");
    expect(c.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it("is less confident when there is no site to corroborate the category", () => {
    // The category is all we have, and vendor categories are wrong often enough
    // that "plumber with no web presence" is a weaker signal than it looks.
    const withSite = classifyDeterministic(input());
    const without = classifyDeterministic(input({ siteAudit: audit({ hasWebsite: false }) }));
    expect(without.confidence).toBeLessThan(withSite.confidence);
  });

  it("lands an unmappable category below the escalation floor by construction", () => {
    const c = classifyDeterministic(input({ category: "miscellaneous services" }));
    expect(c.confidence).toBeLessThan(0.75);
  });

  it("maps prohibited categories explicitly rather than dropping them", async () => {
    // Falling through to "unclassifiable" would give an operator the wrong
    // reason, and the right reason here is a measured one.
    const out = await classify(input({ category: "dentist" }));
    expect(out.escalate).toBe(true);
    if (out.escalate) {
      expect(out.reason).toBe("prohibited_vertical");
      expect(out.detail).toMatch(/practice-management/i);
    }
  });
});

describe("escalates rather than guessing", () => {
  it("escalates below the confidence floor", async () => {
    const out = await classify(input({ category: "general services" }));
    expect(out.escalate).toBe(true);
    if (out.escalate) expect(out.reason).toBe("low_confidence");
  });

  it("escalates a franchise — brand assets are centrally controlled", async () => {
    const out = await classify(input({ franchiseMatch: true }));
    expect(out.escalate).toBe(true);
    if (out.escalate) expect(out.reason).toBe("franchise");
  });

  it("escalates when signals point at two verticals with no dominant one", async () => {
    const out = await classify(
      input({
        siteText: "We handle plumbing emergencies, full rewires and electrical inspections across the county.",
        reviews: { texts: ["Came out for a boiler fault", "Did our electrical rewire too"] },
      }),
    );
    expect(out.escalate).toBe(true);
    if (out.escalate) expect(out.reason).toBe("conflicting_signals");
  });

  it("escalates a regulated trade whose registration could not be verified", async () => {
    const out = await classify(input({ category: "electrician", registrationVerified: false }));
    expect(out.escalate).toBe(true);
    if (out.escalate) expect(out.reason).toBe("regulated_trade_unverified");
  });

  it("does NOT escalate a regulated trade whose registration was verified", async () => {
    const out = await classify(input({ category: "electrician", registrationVerified: true }));
    expect(out.escalate).toBe(false);
  });

  it("halts a business that is already machine-readable and bookable", async () => {
    // They are the 11.6%. There is nothing to sell them, and arriving here means
    // upstream scoring let through something it should have excluded.
    const out = await classify(
      input({ siteAudit: audit({ transactabilityGap: false, hasServiceSchema: true, bookingFound: true }) }),
    );
    expect(out.escalate).toBe(true);
    if (out.escalate) expect(out.reason).toBe("already_transactable");
  });

  it("never builds a vertical whose booking coverage exceeds the cap", () => {
    // Cleaning measures 41.7%, just over the 40% ceiling. It stays in the
    // playbook so the refusal is EXPLICIT and carries its measured reason,
    // rather than falling through to "unclassifiable" — but it is never built.
    expect(bookingCoverageTooHigh("cleaning")).toBe(true);
    expect(bookingCoverageTooHigh("auto_repair")).toBe(false); // 27.8%
    expect(bookingCoverageTooHigh("roofing")).toBe(false); // 0.0%
    expect(isProhibited("hair_salon").prohibited).toBe(true);
    expect(isProhibited("roofing").prohibited).toBe(false);
  });

  it("escalates a business in a vertical that is over the cap", async () => {
    const out = await classify(input({ category: "cleaning_service" }));
    expect(out.escalate).toBe(true);
    if (out.escalate) {
      expect(out.reason).toBe("booking_coverage_too_high");
      expect(out.detail).toMatch(/vertical SaaS already owns it/i);
    }
  });
});

describe("modifier detection is deterministic", () => {
  it("produces the same modifiers for the same input, every time", () => {
    const i = input({ siteText: "24/7 emergency call out for commercial contracts" });
    expect(detectModifiers(i)).toEqual(detectModifiers(i));
  });

  it("detects emergency service from the copy", () => {
    expect(detectModifiers(input({ siteText: "24/7 emergency call out" }))).toContain("emergency_service");
  });

  it("detects no_published_pricing from the AUDIT, not from prose", () => {
    // Field-driven modifiers read measurements. That is why they are the
    // reliable ones — prose lies about prices constantly.
    expect(detectModifiers(input({ siteAudit: audit({ pricingFound: false }) }))).toContain("no_published_pricing");
    expect(detectModifiers(input({ siteAudit: audit({ pricingFound: true }) }))).not.toContain("no_published_pricing");
  });

  it("detects thin content below either threshold", () => {
    expect(detectModifiers(input({ siteAudit: audit({ pageCount: 3 }) }))).toContain("thin_content");
    expect(detectModifiers(input({ siteAudit: audit({ wordCount: 200 }) }))).toContain("thin_content");
    expect(detectModifiers(input())).not.toContain("thin_content");
  });

  it("detects multi-location from the GBP record", () => {
    expect(detectModifiers(input({ gbp: { locationCount: 3 } }))).toContain("multi_location");
  });

  it("detects seasonality from review volume variance", () => {
    const seasonal = input({ reviews: { texts: [], monthlyVolume: [2, 3, 12, 18, 20, 4] } });
    expect(detectModifiers(seasonal)).toContain("seasonal");
    const steady = input({ reviews: { texts: [], monthlyVolume: [10, 11, 12, 11, 10, 12] } });
    expect(detectModifiers(steady)).not.toContain("seasonal");
  });

  it("treats a zero-volume month as seasonal rather than dividing by zero", () => {
    const out = detectModifiers(input({ reviews: { texts: [], monthlyVolume: [0, 3, 12, 18, 20, 4] } }));
    expect(out).toContain("seasonal");
  });

  it("detects b2b serving from the copy", () => {
    expect(detectModifiers(input({ siteText: "We serve commercial contracts and offices" }))).toContain("b2b_serving");
  });
});

describe("manifest assembly", () => {
  it("takes its baseline from the vertical's playbook", () => {
    const m = buildManifest("biz-1", "roofing", 0.92, []);
    const playbook = verticalPlaybook("roofing")!;
    expect(m.siteModules).toEqual(expect.arrayContaining(playbook.site_modules));
    expect(m.integrations).toEqual(playbook.integrations);
  });

  it("REMOVES the pricing module when no prices are published", () => {
    // Not merely left empty. An empty pricing page is an invitation for the
    // agent to fill it, and it may never estimate a price they do not publish.
    const m = buildManifest("biz-1", "electrician", 0.9, ["no_published_pricing"]);
    expect(m.siteModules).not.toContain("pricing");
    expect(m.excluded.some((e) => e.feature === "pricing")).toBe(true);
  });

  it("adds emergency handling when the modifier is present", () => {
    const m = buildManifest("biz-1", "roofing", 0.9, ["emergency_service"]);
    expect(m.siteModules).toContain("emergency");
    expect(m.agentCapabilities).toContain("urgency_triage");
  });

  it("adds a location picker for multi-location businesses", () => {
    expect(buildManifest("biz-1", "roofing", 0.9, ["multi_location"]).siteModules).toContain("location_picker");
  });

  it("records onboarding questions and the pack fallback for thin content", () => {
    const m = buildManifest("biz-1", "roofing", 0.9, ["thin_content"]);
    expect(m.unresolved.length).toBeGreaterThan(0);
    expect(m.excluded.some((e) => e.feature === "extracted_qa_pack")).toBe(true);
  });

  it("records what was excluded and why, not only what was included", () => {
    // A manifest that lists only inclusions cannot be reviewed.
    const m = buildManifest("biz-1", "accountant", 0.9, []);
    expect(m.excluded.some((e) => e.feature === "photo_triage")).toBe(true);
  });

  it("stamps the playbook version so a stored manifest can be read back", () => {
    expect(buildManifest("biz-1", "roofing", 0.9, []).playbookVersion).toMatch(/^playbooks@/);
  });

  it("adds the b2b panel when the modifier is present", () => {
    expect(buildManifest("biz-1", "auto_repair", 0.9, ["b2b_serving"]).dashboardPanels).toContain("b2b_leads");
  });
});

describe("the catalogue check fails the build, not a warning", () => {
  it("rejects a module that is not in any playbook", () => {
    expect(() =>
      assertInCatalogue({
        siteModules: ["hero", "crypto_casino"],
        agentCapabilities: [],
        integrations: [],
        dashboardPanels: [],
      }),
    ).toThrow(ManifestCatalogueError);
  });

  it("rejects an invented agent capability", () => {
    expect(() =>
      assertInCatalogue({ siteModules: [], agentCapabilities: ["take_payment"], integrations: [], dashboardPanels: [] }),
    ).toThrow(/agent_capability:take_payment/);
  });

  it("says adding one is a config PR", () => {
    expect(() =>
      assertInCatalogue({ siteModules: ["nope"], agentCapabilities: [], integrations: [], dashboardPanels: [] }),
    ).toThrow(/pull request/i);
  });

  it("accepts everything a real playbook offers", () => {
    const cat = catalogue();
    expect(cat.modules.size).toBeGreaterThan(5);
    for (const vertical of ["roofing", "lawyer", "auto_repair"]) {
      expect(() => buildManifest("b", vertical, 0.9, [])).not.toThrow();
    }
  });
});

describe("persistence", () => {
  it("round-trips a manifest", async () => {
    const businessId = await makeBusiness();
    const m = buildManifest(businessId, "roofing", 0.92, ["emergency_service"]);
    const id = await persistManifest(db, m);
    const loaded = await loadManifest(db, id);
    expect(loaded?.vertical).toBe("roofing");
    expect(loaded?.modifiers).toContain("emergency_service");
    expect(loaded?.siteModules).toContain("emergency");
    expect(loaded?.confidence).toBeCloseTo(0.92, 2);
  });

  it("is IMMUTABLE — the trigger rejects an update", async () => {
    // A change is a new manifest and a new build. Editing the record a build was
    // reviewed against would make the review meaningless.
    const businessId = await makeBusiness();
    const id = await persistManifest(db, buildManifest(businessId, "roofing", 0.9, []));
    await expect(db.query("UPDATE delivery_manifests SET vertical = 'plumber' WHERE id = $1", [id])).rejects.toThrow();
    await expect(db.query("DELETE FROM delivery_manifests WHERE id = $1", [id])).rejects.toThrow();
  });

  it("re-asserts the catalogue on the way to storage", async () => {
    const businessId = await makeBusiness();
    const m = buildManifest(businessId, "roofing", 0.9, []);
    // A manifest is data and could have been assembled anywhere; persist is the
    // last point before a build reads it.
    m.siteModules.push("smuggled_module");
    await expect(persistManifest(db, m)).rejects.toThrow(ManifestCatalogueError);
  });
});

describe("classify end to end", () => {
  it("produces a manifest for a clean roofing business", async () => {
    const out = await classify(input());
    expect(out.escalate).toBe(false);
    if (!out.escalate) {
      expect(out.manifest.vertical).toBe("roofing");
      expect(out.manifest.modifiers).toContain("no_published_pricing");
      expect(out.manifest.siteModules).not.toContain("pricing");
      expect(out.manifest.agentCapabilities).toContain("photo_triage");
    }
  });

  it("accepts an injected classifier without losing any of the guards", async () => {
    // Model assistance is an optional seam. It cannot talk its way past the
    // prohibited list.
    const out = await classify(input(), { classify: async () => ({ vertical: "dentist", confidence: 0.99 }) });
    expect(out.escalate).toBe(true);
    if (out.escalate) expect(out.reason).toBe("prohibited_vertical");
  });
});

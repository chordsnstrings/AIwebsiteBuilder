// The vertical taxonomy — 60 clusters, 145 trades, 10 archetypes.
//
// Before this package the taxonomy lived in FIVE places: config/playbooks.yaml,
// config/design-catalogue.yaml, SITE_VERTICALS, the Architect's category map,
// and (newly) config/protocols.yaml. Each carried a different subset of the same
// nine SMB trades, so adding a vertical meant editing five files and the failure
// mode for missing one was silent — a business would classify, then fail to
// find a design register, or find one and have no refusal set.
//
// The assertions here are mostly about that: everything that names a vertical
// must resolve for EVERY trade, not for the nine somebody remembered.
import { describe, expect, it } from "vitest";
import {
  allClusters,
  allTrades,
  archetypesOf,
  clusterOf,
  isKnownTrade,
  loadTaxonomy,
  primaryArchetype,
  resolveTrade,
  segmentOf,
  tradesInSegment,
  tradesWithArchetype,
} from "./src/index.ts";

describe("the taxonomy", () => {
  it("carries all 60 clusters from the master catalogue", () => {
    const clusters = allClusters();
    expect(clusters.length).toBe(60);
    expect(new Set(clusters.map((c) => c.n)).size).toBe(60);
  });

  it("⛔ serves every segment — enterprise is not a later phase", () => {
    expect(tradesInSegment("smb_local").length).toBeGreaterThan(0);
    expect(tradesInSegment("enterprise_global").length).toBeGreaterThan(0);
    expect(allClusters().filter((c) => c.segment === "enterprise_global").length).toBe(33);
    expect(allClusters().filter((c) => c.segment === "smb_local").length).toBe(27);
  });

  it("gives every trade exactly one cluster", () => {
    const trades = allTrades();
    expect(new Set(trades).size, "no trade in two clusters").toBe(trades.length);
    for (const t of trades) expect(clusterOf(t), t).toBeDefined();
  });

  it("⛔ gives every cluster at least one archetype", () => {
    // The archetype is what design, register and playbook defaults key off. A
    // cluster without one resolves to nothing and fails at build time for a
    // real customer.
    for (const c of allClusters()) {
      expect(c.archetypes.length, c.id).toBeGreaterThan(0);
      for (const a of c.archetypes) expect(Object.keys(loadTaxonomy().archetypes), `${c.id}:${a}`).toContain(a);
    }
  });

  it("⛔ keeps the nine ids that predate it, unchanged", () => {
    // These are in live config, in migrations, and in customer records. A
    // rename would orphan every one of them.
    for (const t of [
      "roofing", "plumber", "electrician", "hvac", "pest_control",
      "landscaping", "accountant", "lawyer", "auto_repair",
    ]) {
      expect(isKnownTrade(t), t).toBe(true);
      expect(primaryArchetype(t), t).toBeDefined();
    }
  });

  it("reaches every archetype from A to J", () => {
    for (const code of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const) {
      expect(tradesWithArchetype(code).length, code).toBeGreaterThan(0);
    }
  });
});

describe("resolving what a vendor called the business", () => {
  it("matches an exact trade id and a slugged label", () => {
    expect(resolveTrade("plumber")).toBe("plumber");
    expect(resolveTrade("Pest Control")).toBe("pest_control");
    expect(resolveTrade("auto repair")).toBe("auto_repair");
  });

  it("matches a trade named inside a longer phrase", () => {
    expect(resolveTrade("emergency plumber")).toBe("plumber");
    expect(resolveTrade("commercial roofing contractor")).toBe("roofing");
  });

  it("reaches enterprise categories, which used to classify as unknown", () => {
    expect(segmentOf(resolveTrade("telecom")!)).toBe("enterprise_global");
    expect(resolveTrade("manufacturing")).toBeDefined();
    expect(resolveTrade("gaming")).toBeDefined();
  });

  it("⛔ returns undefined rather than the nearest guess", () => {
    // The Architect escalates below its confidence floor precisely because an
    // unclassifiable business produces a bad preview, and a bad preview is
    // worse than no contact. This has to be able to say "I don't know".
    expect(resolveTrade("")).toBeUndefined();
    expect(resolveTrade("zzzz nonsense trade")).toBeUndefined();
  });
});

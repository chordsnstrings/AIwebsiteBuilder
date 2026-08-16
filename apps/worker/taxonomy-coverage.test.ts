// Does every vertical actually work?
//
// ⛔ These live here, not in packages/taxonomy, because taxonomy cannot depend
// on the packages that depend on IT — designer, site-templates and protocol all
// import it, and a dev-dependency back the other way is a cycle turbo refuses
// to build. The worker is the composition root and already has all three.
//
// The point of the assertions is the thing five scattered vertical lists could
// never state: EVERY trade resolves, not the nine somebody remembered.
import { describe, expect, it } from "vitest";
import { allTrades } from "@adw/taxonomy";

describe("⛔ everything that names a vertical resolves for ALL of them", () => {
  // This is the assertion the five scattered lists could never make. Each
  // import is lazy so a failure names the subsystem that broke.

  it("the design catalogue has rules for every trade", async () => {
    const { verticalRules } = await import("@adw/designer");
    for (const t of allTrades()) {
      expect(() => verticalRules(t), `design rules for ${t}`).not.toThrow();
    }
  });

  it("every trade can reach an open design combination", async () => {
    const { openOptions } = await import("@adw/designer");
    for (const t of allTrades()) {
      const open = openOptions(t, [], { hasPhotography: true });
      expect(open.archetypes.length, `${t} archetypes`).toBeGreaterThan(0);
      expect(open.pairings.length, `${t} pairings`).toBeGreaterThan(0);
    }
  });

  it("⛔ every trade has a design register to build from", async () => {
    // Nine trades have hand-written prose; 145 exist. The archetype fallback is
    // what makes the other 136 buildable, and a missing one throws at build
    // time for a paying customer rather than here.
    const { buildSitePrompt } = await import("@adw/site-templates");
    const fixture = {
      business: { name: "Test Co", city: "London", phone: "+44 20 7946 0000", email: "a@b.example", areaServed: ["London"] },
      services: [{ name: "A service", description: "Something they do" }],
      facts: [], qa: [{ question: "Q?", answer: "A." }], refusalText: "I can't answer that.",
      images: [], brand: { extracted: false }, pages: ["index.html"],
    };
    for (const t of allTrades()) {
      expect(() => buildSitePrompt({ ...fixture, vertical: t }), `register for ${t}`).not.toThrow();
    }
  });

  it("⛔ every trade gets the universal safety protocols", async () => {
    // Generated from the catalogue, safeguarding reached two verticals. A
    // disclosure happens to whoever is in front of the person.
    const { protocolsFor } = await import("@adw/protocol");
    for (const t of allTrades()) {
      const ids = protocolsFor(t).map((p) => p.id);
      expect(ids, `${t} safeguarding`).toContain("safeguarding_disclosure");
      expect(ids, `${t} data breach`).toContain("suspected_data_breach");
    }
  });

  it("⛔ no protocol is left inactive", async () => {
    // `verticals: []` meant "catalogued but not served". Every one of the 141
    // now belongs to a trade, because every vertical is served.
    const { loadProtocols } = await import("@adw/protocol");
    const orphans = loadProtocols().protocols.filter((p) => p.verticals.length === 0);
    expect(orphans.map((p) => p.id)).toEqual([]);
  });
});

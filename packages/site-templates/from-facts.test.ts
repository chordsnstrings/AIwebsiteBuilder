// ⛔ `renderSite` has accepted a `machine` input since the machine surface was
// written, and its own comment says supplying it "upgrades the page from 'has
// schema' to 'is transactable'" while omitting it falls back to "the bare
// LocalBusiness node, which is what the market already has". Both callers
// omitted it. Every preview and every paid build shipped the fallback — the
// exact thing the product is sold as fixing — while a knowledge base of the
// business's own published services sat in the database unused.
import { describe, expect, it } from "vitest";
import { machineSurfaceFromFacts, mayPublish, serviceNamesFromFacts, type PublishedFact } from "./src/from-facts.ts";

const base = { name: "Halloran Roofing", category: "roofer", city: "Leeds", phone: "+441130000000" };
const fact = (type: string, value: string, status = "verified"): PublishedFact => ({ type, value, status });

describe("services", () => {
  it("carries one offering per published service", () => {
    const out = machineSurfaceFromFacts(base, [
      fact("service", "Flat roof repair"),
      fact("service", "Gutter replacement"),
    ]);
    expect(out.services.map((s) => s.name)).toEqual(["Flat roof repair", "Gutter replacement"]);
  });

  it("attaches a published price as a real figure", () => {
    const out = machineSurfaceFromFacts(base, [fact("service", "Gutter clean"), fact("price", "£85")]);
    expect(out.services[0]).toMatchObject({ priceCents: 8500, currency: "GBP" });
  });

  it("⛔ never invents an Offer for a business that publishes no price", () => {
    // An invented Offer is a claim we made on their behalf, and it is the claim
    // they would be held to.
    const out = machineSurfaceFromFacts(base, [fact("service", "Roof survey")]);
    expect(out.services[0]!.priceCents).toBeUndefined();
    expect(out.services[0]!.priceNote).toBeUndefined();
  });

  it("keeps a quoting convention as prose, not as a figure", () => {
    const out = machineSurfaceFromFacts(base, [fact("service", "Full re-roof"), fact("price", "Call for a quote")]);
    expect(out.services[0]!.priceCents).toBeUndefined();
    expect(out.services[0]!.priceNote).toContain("quote");
  });
});

describe("⛔ credentials", () => {
  it("publishes a verified credential", () => {
    const out = machineSurfaceFromFacts(base, [fact("credential", "NFRC member", "verified")]);
    expect(out.verifiedCredentials).toEqual(["NFRC member"]);
  });

  it("⛔ refuses a claimed-but-unverified one", () => {
    // A certification printed on their own site that we could not check against
    // a register. Repeating it in structured data is US asserting it — the most
    // damaging false claim in this market, and a regulatory problem for the
    // customer we are supposed to be helping.
    const out = machineSurfaceFromFacts(base, [
      fact("credential", "Gas Safe registered", "claimed_unverified"),
      fact("credential", "Checkatrade approved", "inferred"),
      fact("credential", "TrustMark", "stale"),
    ]);
    expect(out.verifiedCredentials).toBeUndefined();
  });
});

describe("hours and coverage", () => {
  it("parses a weekday range into structured hours", () => {
    const out = machineSurfaceFromFacts(base, [fact("hours", "Mon-Fri 8:00-17:00")]);
    expect(out.hours).toEqual([{ dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "08:00", closes: "17:00" }]);
  });

  it("reads a trades listing's '8-5' as an afternoon close, not a 5am one", () => {
    const out = machineSurfaceFromFacts(base, [fact("hours", "Mon-Sat 8-5")]);
    expect(out.hours![0]!.closes).toBe("17:00");
  });

  it("drops hours it cannot parse rather than guessing a schedule", () => {
    const out = machineSurfaceFromFacts(base, [fact("hours", "by appointment")]);
    expect(out.hours).toBeUndefined();
  });

  it("carries coverage as places", () => {
    const out = machineSurfaceFromFacts(base, [fact("area", "Leeds"), fact("area", "Bradford")]);
    expect(out.areaServed).toEqual(["Leeds", "Bradford"]);
  });
});

describe("⛔ copy services come from the business, not a lookup table", () => {
  it("returns what they published", () => {
    expect(serviceNamesFromFacts([fact("service", "Flat roof repair"), fact("service", "Chimney flashing")]))
      .toEqual(["Flat roof repair", "Chimney flashing"]);
  });

  it("de-duplicates rather than repeating a service twice on the page", () => {
    expect(serviceNamesFromFacts([fact("service", "Roof repair"), fact("service", "roof repair")]))
      .toEqual(["Roof repair"]);
  });

  it("⛔ returns nothing rather than a guess", () => {
    // The caller substituted a three-entry table keyed on category: every roofer
    // got "Roof repair, Roof replacement, Inspections" whether or not they do
    // any of them. A page describing services a business does not offer is a
    // page they cannot approve.
    expect(serviceNamesFromFacts([fact("hours", "Mon-Fri 9-5")])).toEqual([]);
  });
});

describe("an empty knowledge base", () => {
  it("produces a surface with no claims in it", () => {
    const out = machineSurfaceFromFacts(base, []);
    expect(out.services).toEqual([]);
    expect(out.hours).toBeUndefined();
    expect(out.areaServed).toBeUndefined();
    expect(out.verifiedCredentials).toBeUndefined();
    // …but still identifies the business, which is not a claim about it.
    expect(out.name).toBe("Halloran Roofing");
  });
});

describe("⛔ mayPublish — the one rule both surfaces consult", () => {
  it("refuses a credential we could not check, and allows one we did", () => {
    expect(mayPublish({ type: "credential", status: "verified" })).toBe(true);
    for (const status of ["claimed_unverified", "stale", "inferred"]) {
      expect(mayPublish({ type: "credential", status })).toBe(false);
    }
  });

  it("⛔ refuses a price from a page that looks abandoned", () => {
    // Publishing it as a current Offer is a figure the business would be held
    // to, quoted from a page they stopped maintaining.
    expect(mayPublish({ type: "price", status: "stale" })).toBe(false);
    expect(mayPublish({ type: "price", status: "verified" })).toBe(true);
    expect(mayPublish({ type: "price", status: "claimed_unverified" })).toBe(true);
  });

  it("⛔ refuses anything inferred from reviews", () => {
    // `inferred` never comes from the business. Publishing it as their offering
    // invents an offering, on a surface an assistant relays as fact.
    for (const type of ["service", "area", "hours", "price", "credential"]) {
      expect(mayPublish({ type, status: "inferred" })).toBe(false);
    }
  });

  it("allows the business's own words about itself", () => {
    // This is the product: repeating what a business published. Refusing
    // `claimed_unverified` everywhere would leave nothing to publish.
    expect(mayPublish({ type: "service", status: "claimed_unverified" })).toBe(true);
    expect(mayPublish({ type: "area", status: "stale" })).toBe(true);
  });
});

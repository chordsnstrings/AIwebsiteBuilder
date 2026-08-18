// ⛔ The classification that blocked a third of the database.
//
// PECR admits only "corporate" for GB/IE, and every production path passed a
// stub returning "unknown". So every GB and IE contact was classified unmailable
// at ingest and the gate denied it forever — 1,465 businesses, permanently
// undeliverable, with nothing anywhere reporting the cause.
import { describe, expect, it } from "vitest";
import { SuffixCompanyRegistry, suffixEvidence } from "./src/registry-lookup/suffix.ts";

const registry = new SuffixCompanyRegistry();

describe("⛔ corporate only on positive evidence", () => {
  const corporate: [string, string][] = [
    ["Halloran Roofing Ltd", "GB"],
    ["Halloran Roofing Ltd.", "GB"],
    ["Beckwith Plumbing Limited", "GB"],
    ["Ferris Electrical PLC", "GB"],
    ["Okonjo Consulting LLP", "GB"],
    ["Northgate Community Interest Company", "GB"],
    ["Whitfield Trades CIC", "GB"],
    ["Cwmni Adeiladu Cyfyngedig", "GB"],
    ["Brennan Landscaping Teoranta", "IE"],
    ["Delgado Services Teo", "IE"],
    ["Novak Dental DAC", "IE"],
    ["Ashworth Housing CLG", "IE"],
    ["Kowalski Motors Limited", "IE"],
  ];
  for (const [name, country] of corporate) {
    it(`${country}: ${name}`, async () => {
      expect((await registry.classify(name, country)).subscriberType).toBe("corporate");
      expect(suffixEvidence(name, country)).not.toBeNull();
    });
  }

  it("⛔ carries the evidence, not just the verdict", async () => {
    // "corporate" is the answer that unlocks mailing a person. A row asserting
    // it with nothing recording why is a claim nobody can defend — to the ICO,
    // to the recipient, or to the next engineer reading the table.
    const yes = await registry.classify("Halloran Roofing Ltd", "GB");
    expect(yes.ref).toBe("suffix:ltd");
    const no = await registry.classify("Halloran Roofing", "GB");
    expect(no.ref, "an unresolved classification must not carry a reference").toBeNull();
  });

  it("is case- and spacing-insensitive", async () => {
    expect((await registry.classify("  HALLORAN   ROOFING   LTD  ", "GB")).subscriberType).toBe("corporate");
    expect((await registry.classify("Beckwith Plumbing limited,", "GB")).subscriberType).toBe("corporate");
  });
});

describe("⛔ everything else is unknown, never sole_trader", () => {
  // Absence of a suffix is not evidence of anything — plenty of registered
  // companies trade under a name that omits it. Both answers deny at the gate,
  // but only one of them is true, and a database of confident "sole_trader"
  // rows would be a database of assertions nobody can defend.
  const unknown: [string, string][] = [
    ["Halloran Roofing", "GB"],
    ["Bob the Builder", "GB"],
    ["Brennan Landscaping", "IE"],
    ["Ashworth & Sons", "GB"],
    ["Delgado & Co", "GB"],
    ["Whitfield Group", "GB"],
    ["Novak Trades", "GB"],
  ];
  for (const [name, country] of unknown) {
    it(`${country}: ${name}`, async () => {
      expect((await registry.classify(name, country)).subscriberType).toBe("unknown");
    });
  }

  it("⛔ does not match a suffix buried inside a word", async () => {
    // The failure a careless `includes` would produce: mailing a sole trader
    // because their trading name happens to contain the letters.
    expect((await registry.classify("Limitless Roofing", "GB")).subscriberType).toBe("unknown");
    expect((await registry.classify("Ultimate Plumbing", "GB")).subscriberType).toBe("unknown");
    expect((await registry.classify("Splcorp Heating", "GB")).subscriberType).toBe("unknown");
    expect((await registry.classify("Ltdesign Studio", "GB")).subscriberType).toBe("unknown");
    // …and not at the start or middle either.
    expect((await registry.classify("Ltd Brothers Paving", "GB")).subscriberType).toBe("unknown");
    expect((await registry.classify("Beckwith Limited Editions Framing", "GB")).subscriberType).toBe("unknown");
  });

  it("⛔ never classifies outside the jurisdictions that use the concept", async () => {
    // CAN-SPAM has no corporate/sole-trader distinction. Returning "corporate"
    // for a US business would be inventing a classification for a jurisdiction
    // that does not have one.
    expect((await registry.classify("Austin Roofing Ltd", "US")).subscriberType).toBe("unknown");
    expect((await registry.classify("Toronto Plumbing Limited", "CA")).subscriberType).toBe("unknown");
    expect(suffixEvidence("Austin Roofing Ltd", "US")).toBeNull();
  });

  it("handles empty and degenerate names without throwing", async () => {
    expect((await registry.classify("", "GB")).subscriberType).toBe("unknown");
    expect((await registry.classify("   ", "GB")).subscriberType).toBe("unknown");
    expect((await registry.classify("Ltd", "GB")).subscriberType).toBe("corporate");
  });
});

describe("⛔ country-specific evidence does not leak across jurisdictions", () => {
  it("Welsh and Irish forms apply only where they are legal", async () => {
    // "Teoranta" is meaningless in Great Britain and "CIC" is meaningless in
    // Ireland. A pooled suffix list would classify on evidence that does not
    // apply in the jurisdiction being tested.
    expect((await registry.classify("Brennan Landscaping Teoranta", "GB")).subscriberType).toBe("unknown");
    expect((await registry.classify("Whitfield Trades CIC", "IE")).subscriberType).toBe("unknown");
    expect((await registry.classify("Cwmni Adeiladu Cyfyngedig", "IE")).subscriberType).toBe("unknown");
  });
});

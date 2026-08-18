// The MCP surface's whole job is to be no more privileged than the chat agent.
// If the two could diverge, the machine surface would become the way around the
// guardrails — so most of these tests are about the two answering identically,
// and about what a machine is NOT allowed to see.
import { describe, expect, it } from "vitest";
import {
  MCP_PATH,
  MCP_TOOLS,
  businessInfo,
  handleMcpCall,
  mcpManifest,
  publishedServices,
  validateManifest,
  type McpContext,
  type RefusalChecker,
} from "./src/index.ts";

/** Stands in for the concierge's refusal logic. Deliberately shared shape. */
const refusals = (refuse: string | null = null): RefusalChecker => ({ check: () => refuse });

const ctx = (over: Partial<McpContext> = {}): McpContext => ({
  vertical: "roofing",
  business: {
    name: "Ridgeline Roofing",
    phone: "+12085550143",
    addressLocality: "Boise",
    hours: [{ dayOfWeek: ["Monday", "Tuesday"], opens: "08:00", closes: "17:00" }],
  },
  services: [
    { name: "Roof repair", description: "Leak tracing and repair." },
    { name: "Roof replacement", description: "Full tear-off and replacement." },
  ],
  facts: [
    { factKey: "credential:en:nrca-member", type: "credential", value: "NRCA member", status: "verified" },
    { factKey: "credential:en:fully-insured", type: "credential", value: "Fully insured", status: "claimed_unverified" },
    { factKey: "hours:en:mon", type: "hours", value: "Mon-Fri 8-5", status: "verified" },
  ],
  areaServed: ["Boise", "Meridian"],
  calendarConnected: false,
  refusals: refusals(),
  ...over,
});

describe("the manifest advertises only what this business can actually do", () => {
  it("always exposes info, services and coverage", () => {
    const names = mcpManifest(ctx()).tools.map((t) => t.name);
    expect(names).toContain("get_business_info");
    expect(names).toContain("get_services");
    expect(names).toContain("get_coverage_area");
  });

  it("does NOT advertise booking when no calendar is connected", () => {
    // Advertising a tool that always fails is worse than not having it — an
    // assistant builds a plan around it and dead-ends the customer.
    const names = mcpManifest(ctx({ vertical: "accountant", calendarConnected: false })).tools.map((t) => t.name);
    expect(names).not.toContain("book_appointment");
    expect(names).not.toContain("check_availability");
  });

  it("advertises booking once a calendar is connected for a vertical that books", () => {
    const names = mcpManifest(ctx({ vertical: "accountant", calendarConnected: true })).tools.map((t) => t.name);
    expect(names).toContain("book_appointment");
    expect(names).toContain("check_availability");
  });

  it("never advertises booking for a vertical whose playbook has no book capability", () => {
    // Roofing is quote-request; a calendar being connected does not change that.
    const names = mcpManifest(ctx({ vertical: "roofing", calendarConnected: true })).tools.map((t) => t.name);
    expect(names).not.toContain("book_appointment");
  });

  it("is served from a fixed path", () => {
    expect(mcpManifest(ctx()).path).toBe(MCP_PATH);
  });
});

describe("manifest validation — the Reviewer gate calls this", () => {
  it("accepts a manifest we generated", () => {
    expect(validateManifest(mcpManifest(ctx()))).toEqual({ valid: true, errors: [] });
  });

  it("rejects a manifest with no tools", () => {
    const doc = { ...mcpManifest(ctx()), tools: [] };
    expect(validateManifest(doc).valid).toBe(false);
  });

  it("rejects an unknown tool name", () => {
    const doc = { ...mcpManifest(ctx()), tools: [{ name: "drop_database", description: "x", inputSchema: {} }] };
    expect(validateManifest(doc).valid).toBe(false);
  });

  it("rejects a wrong path", () => {
    expect(validateManifest({ ...mcpManifest(ctx()), path: "/mcp" }).valid).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(validateManifest(null).valid).toBe(false);
    expect(validateManifest("mcp").valid).toBe(false);
  });
});

describe("an MCP client is not a privileged caller", () => {
  it("applies the IDENTICAL refusal the chat agent would give", async () => {
    // The same checker instance both surfaces use. If this could diverge, the
    // machine surface would be the documented way around the guardrails.
    const checker = refusals("Not in the knowledge base as a verified fact");
    const res = await handleMcpCall("get_business_info", {}, ctx({ refusals: checker }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("refused");
      expect(res.error).toBe(checker.check("anything", { vertical: "roofing" }));
    }
  });

  it("refuses every tool when the checker refuses, not just the obvious ones", async () => {
    const refusing = ctx({ refusals: refusals("refused"), calendarConnected: true, vertical: "accountant" });
    for (const tool of MCP_TOOLS) {
      const res = await handleMcpCall(tool, {}, refusing);
      expect(res.ok).toBe(false);
    }
  });

  it("rejects an unknown tool rather than ignoring it", async () => {
    const res = await handleMcpCall("exfiltrate_customers", {}, ctx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unknown_tool");
  });
});

describe("what a machine is allowed to see", () => {
  it("omits a claimed_unverified credential", async () => {
    // Repeating an unchecked certification to an assistant is the same
    // regulatory problem as saying it to a person, with wider reach — the
    // assistant relays it as fact.
    const info = businessInfo(ctx());
    expect(info["credentials"]).toEqual(["NRCA member"]);
    expect(JSON.stringify(info)).not.toContain("Fully insured");
  });

  it("returns no credentials at all when none are verified", () => {
    const info = businessInfo(ctx({ facts: [{ factKey: "credential:en:gas-safe", type: "credential", value: "Gas Safe", status: "claimed_unverified" }] }));
    expect(info["credentials"]).toEqual([]);
  });

  it("omits price where the business publishes none, and says so explicitly", () => {
    // An assistant that simply sees no price field will estimate, and an
    // estimate it attributes to the business is a quote they never gave.
    const services = publishedServices(ctx());
    expect(services[0]!["price"]).toBeUndefined();
    expect(services[0]!["priceUnpublished"]).toBe(true);
    expect(String(services[0]!["note"])).toMatch(/Request a quote/);
  });

  it("returns a published price when there is one", () => {
    const services = publishedServices(
      ctx({ services: [{ name: "Callout", description: "Attend.", priceCents: 8900, currency: "USD" }] }),
    );
    expect(services[0]!["price"]).toEqual({ amount: "89.00", currency: "USD" });
    expect(services[0]!["priceUnpublished"]).toBeUndefined();
  });

  it("returns published price TERMS as terms, never as a number", () => {
    const services = publishedServices(
      ctx({ services: [{ name: "Emergency", description: "Out of hours.", priceNote: "Callout fee plus hourly" }] }),
    );
    expect(services[0]!["price"]).toBeUndefined();
    expect(services[0]!["priceTerms"]).toBe("Callout fee plus hourly");
    expect(services[0]!["priceUnpublished"]).toBe(true);
  });

  it("returns coverage as resolvable places", async () => {
    const res = await handleMcpCall("get_coverage_area", {}, ctx());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ areaServed: [{ type: "Place", name: "Boise" }, { type: "Place", name: "Meridian" }] });
    }
  });
});

describe("side effects", () => {
  it("creates a quote request and returns a reference", async () => {
    const res = await handleMcpCall(
      "request_quote",
      { name: "Dana", contact: "dana@example.com", need: "Leak over the bedroom" },
      ctx({ createQuoteRequest: async () => ({ reference: "Q-123" }) }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ reference: "Q-123" });
  });

  it("rejects an incomplete quote request rather than inventing the missing field", async () => {
    const res = await handleMcpCall(
      "request_quote",
      { name: "Dana" },
      ctx({ createQuoteRequest: async () => ({ reference: "Q-123" }) }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_input");
  });

  it("reports not-available rather than silently succeeding when booking is unwired", async () => {
    // A success-shaped response for something that did not happen is this
    // system's worst failure class.
    const res = await handleMcpCall(
      "book_appointment",
      { start: "2026-08-14T09:00:00Z", end: "2026-08-14T10:00:00Z", contact: "dana@example.com" },
      ctx({ vertical: "accountant", calendarConnected: true }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_available");
  });

  it("refuses a tool the manifest does not advertise", async () => {
    const res = await handleMcpCall("book_appointment", {}, ctx({ vertical: "roofing", calendarConnected: true }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_available");
  });
});

// ---------------------------------------------------------------------------
// ⛔ The credential filter enforced nothing for the system's whole history.
//
// It read `f.factKey === "credential"`, and a real key is
// `credential:en:nrca-member` — so it matched no row, ever. The manifest
// carried no credentials at all, and a customer whose accreditation we HAD
// confirmed never had it relayed to an assistant. A filter that removes
// everything is indistinguishable from a filter that works, and the fixtures in
// this file used a key shape production never produces, which is how it
// survived.
// ---------------------------------------------------------------------------
describe("⛔ what reaches an assistant", () => {
  const fact = (type: string, value: string, status: string) => ({
    // The shape the extractor actually writes: `${type}:${lang}:${slug}`.
    factKey: `${type}:en:${value.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    type,
    value,
    status: status as "verified" | "claimed_unverified" | "stale" | "inferred",
  });

  it("⛔ relays a credential we actually verified", async () => {
    // The vacuity check. Asserting only that unverified ones are absent passes
    // just as well when NOTHING is present, which is the state this shipped in.
    const info = businessInfo(ctx({ facts: [fact("credential", "NRCA member", "verified")] }));
    expect(info["credentials"]).toEqual(["NRCA member"]);
  });

  it("⛔ still refuses one we could not check", async () => {
    const info = businessInfo(ctx({ facts: [fact("credential", "Gas Safe registered", "claimed_unverified")] }));
    expect(info["credentials"]).toEqual([]);
  });

  it("does not mistake a service for a credential, or the reverse", async () => {
    const info = businessInfo(
      ctx({ facts: [fact("service", "Credential checks", "verified"), fact("credential", "NRCA member", "verified")] }),
    );
    expect(info["credentials"]).toEqual(["NRCA member"]);
  });
});

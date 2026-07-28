// The machine surface is the product. 72.7% of the market carries some JSON-LD
// and 9.6% publishes Service — the difference between those two numbers is a
// theme's generic markup versus a statement of what a business actually does.
//
// Every test here is about not lying to a machine. An invented price is a claim
// we made on the customer's behalf; an unverified credential in schema is the
// regulatory problem §21.2 exists to prevent.
import { describe, expect, it } from "vitest";
import {
  MACHINE_PATHS,
  buildJsonLd,
  machineSurfaceHead,
  renderLlmsTxtV3,
  type MachineSurfaceInput,
} from "./src/machine-surface.ts";
import { renderSite } from "./src/render.ts";

const base = (over: Partial<MachineSurfaceInput> = {}): MachineSurfaceInput => ({
  name: "Ridgeline Roofing",
  category: "roofer",
  city: "Boise",
  phone: "+12085550143",
  services: [
    { name: "Roof repair", description: "Leak tracing and repair on tile, shingle and flat roofs." },
    { name: "Roof replacement", description: "Full tear-off and replacement with a written scope." },
  ],
  ...over,
});

const graph = (input: MachineSurfaceInput): Record<string, unknown>[] =>
  buildJsonLd(input)["@graph"] as Record<string, unknown>[];

const nodesOfType = (input: MachineSurfaceInput, type: string): Record<string, unknown>[] =>
  graph(input).filter((n) => n["@type"] === type);

describe("Service schema — the 9.6% gap", () => {
  it("emits one Service node per offering", () => {
    const services = nodesOfType(base(), "Service");
    expect(services).toHaveLength(2);
    expect(services.map((s) => s["name"])).toEqual(["Roof repair", "Roof replacement"]);
  });

  it("links every Service to the business by id rather than repeating it", () => {
    // Three disconnected blobs do not tell an assistant they describe one entity.
    const g = graph(base());
    const businessId = g[0]!["@id"];
    for (const s of g.slice(1)) {
      expect((s["provider"] as Record<string, unknown>)["@id"]).toBe(businessId);
    }
  });

  it("carries no Service nodes when the business has no offerings", () => {
    expect(nodesOfType(base({ services: [] }), "Service")).toHaveLength(0);
  });
});

describe("Offer — a price only where one is published", () => {
  it("omits Offer entirely when no price is published", () => {
    // Absent is the CORRECT rendering. An invented Offer is a claim we made for
    // them, and roofing publishes prices essentially never.
    for (const s of nodesOfType(base(), "Service")) {
      expect(s["offers"]).toBeUndefined();
    }
  });

  it("emits Offer with the published figure when there is one", () => {
    const input = base({
      services: [{ name: "Callout", description: "Attend and diagnose.", priceCents: 8900, currency: "USD" }],
    });
    const offer = nodesOfType(input, "Service")[0]!["offers"] as Record<string, unknown>;
    expect(offer["price"]).toBe("89.00");
    expect(offer["priceCurrency"]).toBe("USD");
  });

  it("renders a published price SHAPE when the business publishes terms not a figure", () => {
    // "Callout fee plus hourly" is a real published price and a machine should
    // see it — but it is not a number and must not be rendered as one.
    const input = base({
      services: [{ name: "Emergency", description: "Out of hours.", priceNote: "Callout fee plus hourly rate" }],
    });
    const offer = nodesOfType(input, "Service")[0]!["offers"] as Record<string, unknown>;
    expect(offer["price"]).toBeUndefined();
    expect((offer["priceSpecification"] as Record<string, unknown>)["description"]).toBe(
      "Callout fee plus hourly rate",
    );
  });
});

describe("hours, coverage and rating", () => {
  it("emits OpeningHoursSpecification when hours are known", () => {
    const input = base({
      hours: [{ dayOfWeek: ["Monday", "Tuesday"], opens: "08:00", closes: "17:00" }],
    });
    const spec = graph(input)[0]!["openingHoursSpecification"] as Record<string, unknown>[];
    expect(spec[0]).toMatchObject({ "@type": "OpeningHoursSpecification", opens: "08:00", closes: "17:00" });
  });

  it("emits areaServed as Places, not prose", () => {
    // An assistant has to resolve coverage geographically; "the greater Boise
    // area" is unresolvable.
    const input = base({ areaServed: ["Boise", "Meridian", "Nampa"] });
    const areas = graph(input)[0]!["areaServed"] as Record<string, unknown>[];
    expect(areas.map((a) => a["name"])).toEqual(["Boise", "Meridian", "Nampa"]);
    expect(areas.every((a) => a["@type"] === "Place")).toBe(true);
  });

  it("omits areaServed rather than guessing from the city", () => {
    expect(graph(base())[0]!["areaServed"]).toBeUndefined();
  });

  it("refuses to emit a rating with no reviews behind it", () => {
    expect(graph(base({ rating: 4.9, reviewCount: 0 }))[0]!["aggregateRating"]).toBeUndefined();
    expect(graph(base({ rating: 4.9, reviewCount: 12 }))[0]!["aggregateRating"]).toMatchObject({
      ratingValue: 4.9,
      reviewCount: 12,
    });
  });

  it("uses the vertical's LocalBusiness subtype when one is known", () => {
    expect(graph(base({ schemaType: "Plumber" }))[0]!["@type"]).toBe("Plumber");
    expect(graph(base())[0]!["@type"]).toBe("LocalBusiness");
  });
});

describe("credentials", () => {
  it("emits only the credentials it was given, and nothing when given none", () => {
    // The caller passes VERIFIED facts only — a claimed_unverified certification
    // never reaches here (§21.2). This asserts the renderer invents nothing.
    expect(graph(base())[0]!["hasCredential"]).toBeUndefined();
    const creds = graph(base({ verifiedCredentials: ["NRCA member"] }))[0]!["hasCredential"] as Record<
      string,
      unknown
    >[];
    expect(creds).toHaveLength(1);
    expect(creds[0]!["name"]).toBe("NRCA member");
  });
});

describe("llms.txt", () => {
  it("states services with prices only where published", () => {
    const txt = renderLlmsTxtV3(
      base({
        services: [
          { name: "Callout", description: "Attend and diagnose.", priceCents: 8900, currency: "USD" },
          { name: "Roof repair", description: "Leak tracing." },
        ],
      }),
    );
    expect(txt).toContain("- Callout — 89.00 USD: Attend and diagnose.");
    expect(txt).toContain("- Roof repair: Leak tracing.");
  });

  it("tells a reader what to do when a price is absent", () => {
    // Otherwise an assistant fills the gap with an estimate, which is the exact
    // failure the whole grounding architecture exists to prevent.
    expect(renderLlmsTxtV3(base())).toMatch(/request a quote rather than assuming one/);
  });

  it("advertises the enquiry endpoint and the MCP surface", () => {
    const txt = renderLlmsTxtV3(base());
    expect(txt).toContain(MACHINE_PATHS.enquiry);
    expect(txt).toContain(MACHINE_PATHS.mcp);
  });
});

describe("the rendered document", () => {
  const copy = {
    headline: "Ridgeline Roofing — dependable roofing across the Boise valley",
    services: [
      { title: "Roof repair", blurb: "Leak tracing and repair on tile, shingle and flat roofs, done right." },
      { title: "Roof replacement", blurb: "Full tear-off and replacement with a written scope and timeline." },
    ],
    about:
      "Ridgeline Roofing has served the Boise valley for two decades. We show up when we say we will, quote clearly, and stand behind the work long after the invoice is settled.",
    cta: "Request a quote",
  };

  const render = (machine?: MachineSurfaceInput): string =>
    renderSite({
      family: "trades",
      business: { name: "Ridgeline Roofing", category: "roofer", city: "Boise", phone: "+12085550143" },
      copy,
      locale: "en-US",
      mode: "full",
      legalEntity: "ADW Foundry Ltd",
      legalAddress: "123 Example St",
      labelVersion: "label-v1",
      formAction: "https://app.adwsites.com/f",
      ...(machine === undefined ? {} : { machine }),
    });

  it("links llms.txt, the MCP surface and the enquiry endpoint", () => {
    const html = render();
    expect(html).toContain(`href="${MACHINE_PATHS.llmsTxt}"`);
    expect(html).toContain(`href="${MACHINE_PATHS.mcp}"`);
    expect(html).toContain(MACHINE_PATHS.enquiry);
  });

  it("upgrades to the full graph when machine facts are supplied", () => {
    const html = render(base({ areaServed: ["Boise"] }));
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const parsed = JSON.parse(ld) as { "@graph": Record<string, unknown>[] };
    expect(parsed["@graph"].filter((n) => n["@type"] === "Service")).toHaveLength(2);
  });

  it("still renders a bare LocalBusiness when no machine facts exist", () => {
    // A caller that has not run KB extraction yet must still produce a valid
    // page — the Reviewer's machine-surface gates are what flag it as thin.
    const html = render();
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(JSON.parse(ld)["@type"]).toBe("LocalBusiness");
  });

  it("keeps the schema readable without executing JavaScript", () => {
    // AI visibility is the product claim; a site that needs JS to be read is
    // invisible to most crawlers no matter how good its schema is.
    const html = render(base());
    const withoutScripts = html.replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/gi, "");
    expect(withoutScripts).toContain("application/ld+json");
    expect(withoutScripts).toContain("Ridgeline Roofing");
  });
});

describe("machineSurfaceHead", () => {
  it("is a fixed set of paths — an assistant must not have to guess", () => {
    const head = machineSurfaceHead();
    for (const path of Object.values(MACHINE_PATHS)) expect(head).toContain(path);
  });
});

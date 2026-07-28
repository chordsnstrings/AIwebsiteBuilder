// The machine surface (spec §38.3).
//
// This is the product. We measured 3,559 businesses: 72.7% carry some JSON-LD,
// but only 9.6% publish `Service` and only 24.7% publish a price — 11.6% clear
// both machine-readability and bookability. Almost every site has generic schema
// inherited from a theme, which says a business exists and nothing about what it
// does or what it costs.
//
// So the human surface here is table stakes and this file is the differentiator:
// one `Service` per offering, `Offer` wherever a price is genuinely published,
// hours and coverage as structured data, an enquiry endpoint an agent can POST
// to, and an MCP descriptor an assistant can call.
//
// Two rules shape everything below and both are about not lying to a machine:
//   • A price appears in `Offer` only when the business published one. Absent is
//     the correct rendering for a business that does not publish prices — an
//     invented `Offer` is a claim we made on their behalf.
//   • A credential appears only when its knowledge-base fact is `verified`. A
//     `claimed_unverified` certification is exactly the assertion that creates a
//     regulatory problem for the customer (§21.2).

/** One offering, as the knowledge base recorded it. */
export interface ServiceOffering {
  name: string;
  description: string;
  /** Published price in minor units. Omitted — not zero — when none is published. */
  priceCents?: number;
  currency?: string;
  /** How the price is quoted, when the business publishes that instead of a figure. */
  priceNote?: string;
}

export interface OpeningHours {
  /** Schema.org day names: Monday, Tuesday, … */
  dayOfWeek: string[];
  opens: string; // "08:00"
  closes: string; // "17:00"
}

export interface MachineSurfaceInput {
  name: string;
  category: string;
  city: string;
  phone: string;
  url?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry?: string;
  rating?: number;
  reviewCount?: number;
  services: ServiceOffering[];
  hours?: OpeningHours[];
  /** Structured coverage. Places, not prose — an assistant has to resolve it. */
  areaServed?: string[];
  /** Only facts whose KB status is `verified` reach this list. */
  verifiedCredentials?: string[];
  /** Schema.org LocalBusiness subtype for the vertical, e.g. "Plumber". */
  schemaType?: string;
}

/** Where the machine surface lives. Fixed paths — an assistant must not guess. */
export const MACHINE_PATHS = {
  llmsTxt: "/llms.txt",
  enquiry: "/api/enquiry",
  mcp: "/.well-known/mcp",
} as const;

/**
 * The JSON-LD graph. Emitted as a single `@graph` rather than several script
 * tags so the `Service` nodes can reference the business by id — an assistant
 * reading three disconnected blobs cannot tell they describe one entity.
 */
export function buildJsonLd(input: MachineSurfaceInput): Record<string, unknown> {
  const businessId = "#business";
  const nodes: Record<string, unknown>[] = [];

  const business: Record<string, unknown> = {
    "@type": input.schemaType ?? "LocalBusiness",
    "@id": businessId,
    name: input.name,
    telephone: input.phone,
    address: {
      "@type": "PostalAddress",
      addressLocality: input.addressLocality ?? input.city,
      ...(input.addressRegion === undefined ? {} : { addressRegion: input.addressRegion }),
      ...(input.postalCode === undefined ? {} : { postalCode: input.postalCode }),
      ...(input.addressCountry === undefined ? {} : { addressCountry: input.addressCountry }),
    },
    ...(input.url === undefined ? {} : { url: input.url }),
  };

  if (input.hours && input.hours.length > 0) {
    business["openingHoursSpecification"] = input.hours.map((h) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: h.dayOfWeek,
      opens: h.opens,
      closes: h.closes,
    }));
  }

  if (input.areaServed && input.areaServed.length > 0) {
    business["areaServed"] = input.areaServed.map((a) => ({ "@type": "Place", name: a }));
  }

  // A rating with no reviews behind it is not a rating.
  if (input.rating !== undefined && (input.reviewCount ?? 0) > 0) {
    business["aggregateRating"] = {
      "@type": "AggregateRating",
      ratingValue: input.rating,
      reviewCount: input.reviewCount,
    };
  }

  if (input.verifiedCredentials && input.verifiedCredentials.length > 0) {
    business["hasCredential"] = input.verifiedCredentials.map((c) => ({
      "@type": "EducationalOccupationalCredential",
      name: c,
    }));
  }

  nodes.push(business);

  for (const [i, service] of input.services.entries()) {
    const node: Record<string, unknown> = {
      "@type": "Service",
      "@id": `#service-${i + 1}`,
      name: service.name,
      description: service.description,
      provider: { "@id": businessId },
      ...(input.areaServed && input.areaServed.length > 0
        ? { areaServed: input.areaServed.map((a) => ({ "@type": "Place", name: a })) }
        : {}),
    };
    // Offer only where a price was actually published. `priceNote` carries the
    // "callout fee plus hourly" case, which is a real published price shape and
    // not a figure.
    if (service.priceCents !== undefined) {
      node["offers"] = {
        "@type": "Offer",
        price: (service.priceCents / 100).toFixed(2),
        priceCurrency: service.currency ?? "USD",
        availability: "https://schema.org/InStock",
      };
    } else if (service.priceNote !== undefined) {
      node["offers"] = {
        "@type": "Offer",
        priceSpecification: {
          "@type": "PriceSpecification",
          description: service.priceNote,
        },
      };
    }
    nodes.push(node);
  }

  return { "@context": "https://schema.org", "@graph": nodes };
}

/**
 * `/llms.txt` — the plain-language summary. Deliberately not marketing copy: an
 * assistant reading this is deciding whether this business can do a job, and
 * "trusted local experts" answers nothing.
 */
export function renderLlmsTxtV3(input: MachineSurfaceInput): string {
  const lines: string[] = [
    `# ${input.name}`,
    "",
    `${input.category} in ${input.city}.`,
    "",
    "## Services",
  ];
  for (const s of input.services) {
    const price =
      s.priceCents !== undefined
        ? ` — ${(s.priceCents / 100).toFixed(2)} ${s.currency ?? "USD"}`
        : s.priceNote !== undefined
          ? ` — ${s.priceNote}`
          : "";
    lines.push(`- ${s.name}${price}: ${s.description}`);
  }
  if (input.areaServed && input.areaServed.length > 0) {
    lines.push("", "## Coverage", input.areaServed.join(", "));
  }
  if (input.hours && input.hours.length > 0) {
    lines.push("", "## Hours");
    for (const h of input.hours) lines.push(`- ${h.dayOfWeek.join(", ")}: ${h.opens}–${h.closes}`);
  }
  if (input.verifiedCredentials && input.verifiedCredentials.length > 0) {
    lines.push("", "## Credentials", input.verifiedCredentials.join(", "));
  }
  lines.push(
    "",
    "## Contact",
    `Phone: ${input.phone}`,
    `Enquiries: POST ${MACHINE_PATHS.enquiry} with {name, contact, need, urgency}`,
    `Agent tools: ${MACHINE_PATHS.mcp}`,
    "",
    "## Notes",
    "Prices are listed only where this business publishes them. Where a price is",
    "absent, request a quote rather than assuming one.",
  );
  return lines.join("\n") + "\n";
}

/**
 * The `<head>` fragment linking the machine surface. Separate from the JSON-LD
 * so the Reviewer can assert each independently — a site that carries schema but
 * advertises no enquiry endpoint is readable and still not transactable, which
 * is precisely the market's existing failure.
 */
export function machineSurfaceHead(): string {
  return [
    `<link rel="alternate" type="text/plain" href="${MACHINE_PATHS.llmsTxt}">`,
    `<link rel="service" type="application/json" href="${MACHINE_PATHS.mcp}">`,
    `<meta name="adw-enquiry-endpoint" content="${MACHINE_PATHS.enquiry}">`,
  ].join("\n");
}

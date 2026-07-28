// @adw/mcp — the customer's MCP surface (spec §37.5, §38.3).
//
// Near-zero marginal cost: it wraps capabilities the retrieval architecture
// already has, in a different transport. That is also why it is the single most
// defensible line in the deliverable — our installed base is agent-transactable
// against a market baseline of 11.6%, and that gap is measurable from public
// data by us, by a customer, or by an investor.
//
// ⛔ THE RULE THAT MATTERS: an MCP client is NOT a privileged caller. An AI
// assistant asking for a price the business does not publish gets exactly the
// refusal a human gets. If the two surfaces could diverge, the machine one
// would become the way around the guardrails — so the refusal decision is made
// once, by an injected checker, and both surfaces call it.
import { config } from "@adw/config";

/** The six tools. Fixed names — an assistant must not have to guess. */
export const MCP_TOOLS = [
  "get_business_info",
  "get_services",
  "check_availability",
  "request_quote",
  "book_appointment",
  "get_coverage_area",
] as const;
export type McpTool = (typeof MCP_TOOLS)[number];

export const MCP_PATH = "/.well-known/mcp";

export interface McpToolDescriptor {
  name: McpTool;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpManifest {
  protocol: "mcp";
  version: string;
  path: string;
  business: { name: string; vertical: string };
  tools: McpToolDescriptor[];
}

/** A fact as the knowledge base stores it. Status is what gates disclosure. */
export interface KbFactLike {
  factKey: string;
  value: string;
  status: "verified" | "claimed_unverified" | "stale" | "inferred";
}

export interface ServiceLike {
  name: string;
  description: string;
  /** Absent when the business publishes no price. Absent is not zero. */
  priceCents?: number;
  currency?: string;
  priceNote?: string;
}

/**
 * The same refusal decision the chat agent makes.
 *
 * Injected rather than reimplemented. KEEP IN SYNC is not good enough here —
 * two copies of a refusal rule drift, and the drift is invisible until an
 * assistant gets an answer a human would have been refused.
 */
export interface RefusalChecker {
  /** Returns a refusal reason, or null when the question may be answered. */
  check(question: string, context: { vertical: string }): string | null;
}

export interface McpContext {
  vertical: string;
  business: {
    name: string;
    phone?: string;
    addressLocality?: string;
    hours?: { dayOfWeek: string[]; opens: string; closes: string }[];
  };
  services: ServiceLike[];
  facts: KbFactLike[];
  areaServed: string[];
  /** Null when no calendar is connected — booking is then not advertised. */
  calendarConnected: boolean;
  refusals: RefusalChecker;
  /** Deterministic side effects, injected so this package stays pure. */
  createQuoteRequest?: (input: QuoteRequestInput) => Promise<{ reference: string }>;
  createBooking?: (input: BookingInput) => Promise<{ reference: string; start: string; end: string }>;
  availableSlots?: () => Promise<{ start: string; end: string }[]>;
}

export interface QuoteRequestInput {
  name: string;
  contact: string;
  need: string;
  urgency?: "emergency" | "urgent" | "normal";
}

export interface BookingInput {
  start: string;
  end: string;
  contact: string;
}

export type McpResult =
  | { ok: true; tool: McpTool; data: unknown }
  | { ok: false; tool: string; error: string; reason: "unknown_tool" | "not_available" | "refused" | "bad_input" };

export class UnknownToolError extends Error {}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const DESCRIPTORS: Record<McpTool, McpToolDescriptor> = {
  get_business_info: {
    name: "get_business_info",
    description: "Name, address, opening hours, coverage and verified credentials.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  get_services: {
    name: "get_services",
    description: "Services offered, with prices only where the business publishes them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  check_availability: {
    name: "check_availability",
    description: "Open appointment slots from the connected calendar.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  request_quote: {
    name: "request_quote",
    description: "Submit a structured quote request. Returns a reference.",
    inputSchema: {
      type: "object",
      required: ["name", "contact", "need"],
      properties: {
        name: { type: "string" },
        contact: { type: "string" },
        need: { type: "string" },
        urgency: { type: "string", enum: ["emergency", "urgent", "normal"] },
      },
      additionalProperties: false,
    },
  },
  book_appointment: {
    name: "book_appointment",
    description: "Book a slot from check_availability. Returns a reference.",
    inputSchema: {
      type: "object",
      required: ["start", "end", "contact"],
      properties: { start: { type: "string" }, end: { type: "string" }, contact: { type: "string" } },
      additionalProperties: false,
    },
  },
  get_coverage_area: {
    name: "get_coverage_area",
    description: "Areas this business covers, as named places.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
};

interface PlaybookVertical {
  agent_capabilities?: string[];
  booking_model?: string;
}

/**
 * Which tools this business actually advertises.
 *
 * A lawyer whose vertical offers a consultation slot but has no calendar
 * connected does not advertise `book_appointment` — advertising a tool that
 * always fails is worse than not having it, because an assistant will build a
 * plan around it and then dead-end the customer.
 */
export function mcpManifest(ctx: Pick<McpContext, "vertical" | "business" | "calendarConnected">): McpManifest {
  const playbooks = config.playbooks().data as { verticals: Record<string, PlaybookVertical> };
  const vertical = playbooks.verticals[ctx.vertical];
  const capabilities = new Set(vertical?.agent_capabilities ?? []);

  const tools: McpToolDescriptor[] = [DESCRIPTORS.get_business_info, DESCRIPTORS.get_services, DESCRIPTORS.get_coverage_area];
  if (capabilities.has("capture_enquiry")) tools.push(DESCRIPTORS.request_quote);
  if (capabilities.has("book") && ctx.calendarConnected) {
    tools.push(DESCRIPTORS.check_availability, DESCRIPTORS.book_appointment);
  }

  return {
    protocol: "mcp",
    version: "2026-07-28",
    path: MCP_PATH,
    business: { name: ctx.business.name, vertical: ctx.vertical },
    tools,
  };
}

/** Deterministic structural validation. The Reviewer gate calls this. */
export function validateManifest(doc: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof doc !== "object" || doc === null) return { valid: false, errors: ["not an object"] };
  const m = doc as Record<string, unknown>;
  if (m["protocol"] !== "mcp") errors.push("protocol must be 'mcp'");
  if (typeof m["version"] !== "string") errors.push("version missing");
  if (m["path"] !== MCP_PATH) errors.push(`path must be ${MCP_PATH}`);
  const tools = m["tools"];
  if (!Array.isArray(tools) || tools.length === 0) {
    errors.push("tools must be a non-empty array");
  } else {
    for (const t of tools) {
      const tool = t as Record<string, unknown>;
      if (!MCP_TOOLS.includes(tool["name"] as McpTool)) errors.push(`unknown tool ${String(tool["name"])}`);
      if (typeof tool["description"] !== "string") errors.push(`tool ${String(tool["name"])} has no description`);
      if (typeof tool["inputSchema"] !== "object") errors.push(`tool ${String(tool["name"])} has no inputSchema`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** The question each tool is effectively asking, for the refusal check. */
const TOOL_QUESTION: Record<McpTool, string> = {
  get_business_info: "What are your opening hours and credentials?",
  get_services: "What services do you offer and what do they cost?",
  check_availability: "When are you available?",
  request_quote: "Can I request a quote?",
  book_appointment: "Can I book an appointment?",
  get_coverage_area: "Which areas do you cover?",
};

export async function handleMcpCall(tool: string, args: unknown, ctx: McpContext): Promise<McpResult> {
  if (!MCP_TOOLS.includes(tool as McpTool)) {
    // Rejected, not ignored. Silently returning empty would let an assistant
    // believe it asked something meaningful and got nothing back.
    return { ok: false, tool, error: `unknown tool: ${tool}`, reason: "unknown_tool" };
  }
  const name = tool as McpTool;

  // The identical refusal set. This is the line that stops the machine surface
  // becoming the way around the guardrails.
  const refusal = ctx.refusals.check(TOOL_QUESTION[name], { vertical: ctx.vertical });
  if (refusal !== null) {
    return { ok: false, tool: name, error: refusal, reason: "refused" };
  }

  const advertised = new Set(mcpManifest(ctx).tools.map((t) => t.name));
  if (!advertised.has(name)) {
    return { ok: false, tool: name, error: `${name} is not available for this business`, reason: "not_available" };
  }

  switch (name) {
    case "get_business_info":
      return { ok: true, tool: name, data: businessInfo(ctx) };
    case "get_services":
      return { ok: true, tool: name, data: { services: publishedServices(ctx) } };
    case "get_coverage_area":
      return { ok: true, tool: name, data: { areaServed: ctx.areaServed.map((a) => ({ type: "Place", name: a })) } };
    case "check_availability": {
      const slots = (await ctx.availableSlots?.()) ?? [];
      return { ok: true, tool: name, data: { slots } };
    }
    case "request_quote": {
      const input = args as QuoteRequestInput;
      if (!input?.name || !input?.contact || !input?.need) {
        return { ok: false, tool: name, error: "name, contact and need are required", reason: "bad_input" };
      }
      const created = await ctx.createQuoteRequest?.(input);
      if (!created) return { ok: false, tool: name, error: "quote requests are not enabled", reason: "not_available" };
      return { ok: true, tool: name, data: created };
    }
    case "book_appointment": {
      const input = args as BookingInput;
      if (!input?.start || !input?.end || !input?.contact) {
        return { ok: false, tool: name, error: "start, end and contact are required", reason: "bad_input" };
      }
      const created = await ctx.createBooking?.(input);
      if (!created) return { ok: false, tool: name, error: "booking is not enabled", reason: "not_available" };
      return { ok: true, tool: name, data: created };
    }
  }
}

// ---------------------------------------------------------------------------
// Projections — what a machine is allowed to see
// ---------------------------------------------------------------------------

/**
 * ⛔ Only `verified` credentials. A certification claimed on the business's own
 * site but never checked is `claimed_unverified`, and repeating it to an AI
 * assistant is the same regulatory problem as saying it to a person — with
 * wider reach, because the assistant will relay it as fact.
 */
export function businessInfo(ctx: McpContext): Record<string, unknown> {
  const credentials = ctx.facts
    .filter((f) => f.factKey === "credential" && f.status === "verified")
    .map((f) => f.value);
  return {
    name: ctx.business.name,
    ...(ctx.business.phone === undefined ? {} : { phone: ctx.business.phone }),
    ...(ctx.business.addressLocality === undefined ? {} : { addressLocality: ctx.business.addressLocality }),
    ...(ctx.business.hours === undefined ? {} : { openingHours: ctx.business.hours }),
    areaServed: ctx.areaServed,
    credentials,
  };
}

/**
 * ⛔ A price appears only where the business published one. Absent is the
 * correct answer, and it is why `priceUnpublished: true` is stated explicitly —
 * an assistant that sees no price field will estimate, and an estimate it
 * attributes to the business is a quote the business never gave.
 */
export function publishedServices(ctx: McpContext): Record<string, unknown>[] {
  return ctx.services.map((s) => ({
    name: s.name,
    description: s.description,
    ...(s.priceCents !== undefined
      ? { price: { amount: (s.priceCents / 100).toFixed(2), currency: s.currency ?? "USD" } }
      : s.priceNote !== undefined
        ? { priceTerms: s.priceNote, priceUnpublished: true }
        : { priceUnpublished: true, note: "This business does not publish a price for this service. Request a quote." }),
  }));
}

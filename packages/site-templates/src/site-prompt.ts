// Assembling the site-generation brief.
//
// One brief is three things concatenated in a fixed order:
//
//   design-contract.md      invariant. Every clause traces to an observed
//                           failure, and it is identical for every customer.
//   verticals/<id>.md       the register, imagery brief, refusals and the
//                           notes that change the build for this trade.
//   the business block      assembled here from the knowledge base.
//
// ⛔ The contract comes FIRST and the business facts LAST. Rounds 1 and 2 of the
// GLM trials showed the model reverting to a conventional headline-over-photo
// hero unless the structural rules are stated before it has any business facts
// to get excited about. Order is load-bearing, not cosmetic.
//
// Nothing model-specific lives here. The brief is prose plus a file protocol,
// which is what makes it portable across the registry's candidates.

import { renderDesignBrief, type DesignManifest } from "@adw/designer";
import { allTrades, isKnownTrade, primaryArchetype } from "@adw/taxonomy";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "@adw/config";

const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

/**
 * The verticals a site can be generated for.
 *
 * ⛔ Derived, not listed. This was a hand-written array of nine SMB trades, one
 * of five places the taxonomy lived — so adding a vertical meant editing five
 * files and missing one. It now comes from config/verticals.yaml: 60 clusters,
 * 145 trades, every segment.
 *
 * A vertical without its own prompt file falls back to its ARCHETYPE's register
 * (see `verticalBrief`), which is the whole reason the archetype layer exists.
 */
export const SITE_VERTICALS = allTrades();
export type SiteVertical = string;

export function isSiteVertical(value: string): value is SiteVertical {
  return isKnownTrade(value);
}

/**
 * Colours lifted off the business's existing site — logo, headings, buttons —
 * in descending order of how much surface they cover.
 *
 * ⛔ `primary` is used as a SEED, never as a surface. Most extracted brand
 * colours are saturated enough that using one large is what makes a site look
 * cheap; the contract caps the accent at under 5% of any screen. Absent brand
 * colours are honest — the contract has a neutral fallback — and inventing one
 * would put a brand decision in a place nobody reviews.
 */
export interface BrandSeed {
  primary?: string;
  secondary?: string;
  /** Where the colours came from, so a reviewer can check them. */
  sourceUrl?: string;
  /** Set when extraction found nothing usable. */
  extracted: boolean;
}

export interface SiteImage {
  path: string;
  width: number;
  height: number;
  /** What is actually in the frame. The model places images by content, so a
   *  vague description produces a photograph in the wrong slot. */
  description: string;
  /** ⛔ Defaults to "photograph". An AI-generated image listed among the
   *  photographs will be placed among the photographs — in a gallery, beside
   *  "our recent work" — and that is a false statement about a job the business
   *  did. Generated images are described in their own section with their own
   *  instruction. */
  provenance?: "photograph" | "ai_generated";
  /** Required for a generated image: the decorative slot it belongs in. */
  slot?: string;
}

export interface SiteQAPair {
  question: string;
  answer: string;
}

export interface SitePromptInput {
  vertical: SiteVertical;
  business: {
    name: string;
    tagline?: string;
    city: string;
    region?: string;
    postalCode?: string;
    country?: string;
    street?: string;
    phone: string;
    email: string;
    since?: number;
    teamSize?: number;
    areaServed: string[];
    hours?: string;
  };
  /** Published services. `price` is omitted — not zeroed — when none is published. */
  services: { name: string; description: string; price?: string }[];
  facts: string[];
  qa: SiteQAPair[];
  refusalText: string;
  images: SiteImage[];
  brand: BrandSeed;
  pages: string[];
  /** Restrict the round to a subset of files, for iteration. */
  deliverable?: string[];
  /**
   * The Designer's decision, made before this brief was assembled.
   *
   * Absent means the builder chooses within the contract's archetypes — which
   * is how nine trades produced four identical typefaces. Present is the
   * intended path.
   */
  design?: DesignManifest;
}

export const SITE_SYSTEM_PROMPT = `You are a senior front-end designer building marketing sites for
small service businesses. You write hand-crafted semantic HTML and modern CSS by hand. You do not
use frameworks, CSS libraries, utility-class systems, or build tooling.

You follow a written design contract exactly. Where the contract and your instincts disagree, the
contract wins — it exists because those instincts have been measured and found to produce the wrong
page for this product.

Output complete, runnable files. Never abbreviate markup with a comment.`;

function readPart(relative: string): string {
  return readFileSync(join(PROMPT_DIR, relative), "utf8").trim();
}

/**
 * The register for a vertical.
 *
 * ⛔ Falls back to the archetype rather than throwing. Nine trades have a
 * hand-written register; 145 exist. A missing file must degrade to the shared
 * register for that archetype — a roofer and a solar installer are both
 * archetype D and want the same voice — not fail the build for a customer whose
 * trade nobody has written prose for yet.
 */
function verticalBrief(vertical: string): string {
  const own = join(PROMPT_DIR, "verticals", `${vertical}.md`);
  if (existsSync(own)) return readFileSync(own, "utf8").trim();
  const code = primaryArchetype(vertical);
  const shared = code === undefined ? null : join(PROMPT_DIR, "archetypes", `${code}.md`);
  if (shared !== null && existsSync(shared)) return readFileSync(shared, "utf8").trim();
  throw new Error(
    `No register for vertical "${vertical}" and no archetype fallback. Add ` +
      `prompts/verticals/${vertical}.md, or an archetype register for ${code ?? "(unknown archetype)"}.`,
  );
}

function brandBlock(brand: BrandSeed): string {
  if (!brand.extracted || (brand.primary === undefined && brand.secondary === undefined)) {
    return [
      "No usable brand colour could be extracted from the business's existing site.",
      "",
      "Choose a palette from the vertical's design register instead, and say in a CSS",
      "comment that the palette is a register default rather than a brand derivation.",
      "⛔ Do not invent a brand colour and present it as theirs.",
    ].join("\n");
  }
  const rows = [
    brand.primary === undefined ? null : `- Primary:   \`${brand.primary}\``,
    brand.secondary === undefined ? null : `- Secondary: \`${brand.secondary}\``,
    brand.sourceUrl === undefined ? null : `- Source:    ${brand.sourceUrl}`,
  ].filter((r): r is string => r !== null);
  return [
    "Extracted from the business's existing site, most-used first:",
    "",
    ...rows,
    "",
    "Derive the full palette from these using the rules in §3 of the contract.",
    "⛔ The extracted colour is a SEED. It does not become a background.",
  ].join("\n");
}

function businessBlock(input: SitePromptInput): string {
  const b = input.business;
  const lines: string[] = [];

  lines.push("## The business", "");
  lines.push(`**${b.name}**${b.tagline === undefined ? "" : ` — ${b.tagline}`}`);
  const address = [b.street, b.city, b.region, b.postalCode].filter(Boolean).join(", ");
  if (address) lines.push(address);
  lines.push(`${b.phone} · ${b.email}`);
  if (b.since !== undefined) lines.push(`Trading since ${b.since}.`);
  if (b.teamSize !== undefined) lines.push(`${b.teamSize} people.`);
  if (b.hours !== undefined) lines.push(`Hours: ${b.hours}`);
  lines.push(`Areas served: ${b.areaServed.join(", ")}`);

  lines.push("", "## Published services", "");
  for (const s of input.services) {
    // ⛔ A service with no published price is written WITHOUT a price line, not
    // with an empty one. An empty price field is the thing a model fills in.
    lines.push(`- **${s.name}** — ${s.description}${s.price === undefined ? "" : ` · ${s.price}`}`);
  }

  if (input.facts.length > 0) {
    lines.push("", "## Other published facts", "");
    for (const f of input.facts) lines.push(`- ${f}`);
  }

  lines.push(
    "",
    "## The Q&A set the hero answers from",
    "",
    "Implement keyword matching over exactly these in `assets/site.js`. Anything",
    "unmatched returns the refusal. ⛔ Do not add pairs, and do not reword answers —",
    "these are the business's published words and the refusal rule depends on the set",
    "being closed.",
    "",
  );
  for (const [i, pair] of input.qa.entries()) {
    lines.push(`${i + 1}. **${pair.question}**`, `   ${pair.answer}`, "");
  }
  lines.push(`Refusal text, verbatim: "${input.refusalText}"`);

  const photographs = input.images.filter((i) => (i.provenance ?? "photograph") === "photograph");
  const generated = input.images.filter((i) => i.provenance === "ai_generated");

  lines.push("", "## Photographs on disk — use these exact paths", "");
  if (photographs.length === 0) {
    lines.push(
      "None. Build the page on typography, rule and space alone. That is a legitimate",
      "answer, not a degraded one — do not reference image files that do not exist.",
    );
  } else {
    for (const img of photographs) {
      const shape = img.height > img.width ? " PORTRAIT" : "";
      lines.push(`- \`${img.path}\` ${img.width}x${img.height}${shape} — ${img.description}`);
    }
  }

  // ⛔ Its own section, with its own instruction. Listed among the photographs
  // these would be placed among the photographs, and an AI render beside "our
  // recent work" is a false statement about a job the business did.
  if (generated.length > 0) {
    lines.push("", "## AI-generated decoration — NOT photographs of this business", "");
    lines.push(
      "These images were generated. They show nothing that exists and nobody who exists.",
      "",
      "- Use them ONLY in the decorative slot named beside each one.",
      "- NEVER place one in a gallery, a case study, a before-and-after, a testimonial,",
      "  an about-the-team section, or anywhere a reader would take it as evidence of",
      "  work this business did or people who work here.",
      "- Never write a caption that describes one as a photograph, a project, a job,",
      "  a customer, or a member of staff.",
      "",
    );
    for (const img of generated) {
      lines.push(`- \`${img.path}\` ${img.width}x${img.height} — slot: ${img.slot ?? "unspecified"} — ${img.description}`);
    }
  }

  lines.push("", "## Brand colour", "", brandBlock(input.brand));

  lines.push("", "## Pages", "");
  lines.push(input.pages.join(", "));
  if (input.deliverable !== undefined) {
    lines.push(
      "",
      `**This round: produce only ${input.deliverable.join(", ")}.**`,
      "The remaining pages share this stylesheet, so write the CSS as a reusable",
      "system rather than one-off rules for this page.",
    );
  }

  return lines.join("\n");
}

/**
 * Decorative slots, read from the same config the asset catalogue reads.
 *
 * ⛔ One file, two readers. A local copy of this list here would be a second
 * place to add a slot and a first place to forget one, and the failure mode of
 * forgetting is an AI render in a gallery.
 */
function decorativeSlots(): Set<string> {
  const data = config.assetKinds().data as { decorative_slots?: string[] };
  return new Set(data.decorative_slots ?? []);
}

export function buildSitePrompt(input: SitePromptInput): { system: string; user: string } {
  // ⛔ Refuses the build rather than rendering the page. A generated image whose
  // slot is not decorative is the exact thing the whole provenance apparatus
  // exists to prevent, and by the time a page has shipped it is on the internet
  // under a real business's name.
  const decorative = decorativeSlots();
  for (const img of input.images) {
    if (img.provenance !== "ai_generated") continue;
    if (img.slot === undefined || !decorative.has(img.slot)) {
      throw new Error(
        `buildSitePrompt: generated image ${img.path} targets slot "${img.slot ?? "none"}", which is not decorative. ` +
          `An AI render placed where a reader takes it as evidence of work done is a false claim about this business.`,
      );
    }
  }
  return {
    system: SITE_SYSTEM_PROMPT,
    // ⛔ Order is load-bearing. Contract, then vertical register, then the
    // design decision, then the facts. Rounds 1 and 2 showed the model
    // reverting to a conventional hero whenever it met business facts before
    // the rules — every rule has to land first.
    user: [
      readPart("design-contract.md"),
      "\n\n---\n\n",
      verticalBrief(input.vertical),
      "\n\n---\n\n",
      ...(input.design === undefined ? [] : [renderDesignBrief(input.design), "\n\n---\n\n"]),
      businessBlock(input),
    ].join(""),
  };
}

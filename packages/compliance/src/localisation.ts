// Localisation layer (spec §60). Four layers of text ship to a recipient, and
// they are NOT equivalent. Two are model-generated and reviewed by gates; two
// are never model-generated under any circumstance, because a model that
// paraphrases an unsubscribe notice or a jurisdiction's disclosure has produced
// a legal defect, not a translation.
//
// Everything here fails closed. A missing locale or key throws — it never falls
// back to English, and it never asks a model to fill the gap. A silent English
// fallback for a legal string is the exact failure this module exists to stop.
import { config } from "@adw/config";

// ---------------------------------------------------------------------------
// The four layers.
// ---------------------------------------------------------------------------

export type LegalLayerId = "site_copy" | "conversation" | "legal_text" | "ui_strings";

export interface LegalLayer {
  id: LegalLayerId;
  label: string;
  /** True only where a model may author the words. */
  modelGenerated: boolean;
  /** Where the text actually comes from. */
  source: string;
  /** What goes wrong if this layer is generated the wrong way. */
  rationale: string;
}

export const LEGAL_LAYERS: readonly LegalLayer[] = [
  {
    id: "site_copy",
    label: "Generated site copy",
    modelGenerated: true,
    source: "model, constrained to the copy slots in config/templates.yaml",
    rationale:
      "Marketing prose about a business. Wrong wording is a quality defect the reviewer gate catches and patches.",
  },
  {
    id: "conversation",
    label: "Conversational replies",
    modelGenerated: true,
    source: "model, post-gate, with required elements injected by the transport",
    rationale:
      "Replies to a prospect or customer. Model-authored, but every obligation on the message is injected deterministically around it.",
  },
  {
    id: "legal_text",
    label: "Legal and regulatory text",
    modelGenerated: false,
    source: "config/legal_text.yaml, per jurisdiction, PR-gated and counsel-reviewed",
    rationale:
      "Unsubscribe notices, AI disclosure, preview disclaimers, the guarantee. A paraphrase is a compliance breach, so these are never generated and never machine-translated.",
  },
  {
    id: "ui_strings",
    label: "Product UI strings",
    modelGenerated: false,
    source: "checked-in string catalogues, translated by humans",
    rationale:
      "Buttons and labels a customer acts on. A drifting label changes what the customer believes they consented to.",
  },
] as const;

/** The layers a model may write. Anything not in here is never model-generated. */
export const MODEL_GENERATED_LAYERS: readonly LegalLayerId[] = LEGAL_LAYERS.filter(
  (l) => l.modelGenerated,
).map((l) => l.id);

/** The layers a model may never write. */
export const NEVER_MODEL_GENERATED_LAYERS: readonly LegalLayerId[] = LEGAL_LAYERS.filter(
  (l) => !l.modelGenerated,
).map((l) => l.id);

export function legalLayer(id: LegalLayerId): LegalLayer {
  const layer = LEGAL_LAYERS.find((l) => l.id === id);
  if (!layer) throw new MissingLegalTextError(`unknown legal layer: ${id}`);
  return layer;
}

// ---------------------------------------------------------------------------
// Legal blocks. Never generated, never silently substituted.
// ---------------------------------------------------------------------------

export const LEGAL_BLOCK_KEYS = [
  "unsubscribe",
  "ai_disclosure",
  "preview_disclaimer",
  "guarantee",
] as const;

export type LegalBlockKey = (typeof LEGAL_BLOCK_KEYS)[number];

/** Raised when a legal string cannot be produced. Callers must not paper over it. */
export class MissingLegalTextError extends Error {}

interface LegalTextShape {
  default?: { entity?: string; postal_address?: string; privacy_url?: string };
  blocks?: Record<string, Partial<Record<LegalBlockKey, string>>>;
}

/** Locales that have a reviewed legal-text block, sorted for stable output. */
export function legalLocales(): string[] {
  const data = config.legalText().data as LegalTextShape;
  return Object.keys(data.blocks ?? {}).sort();
}

/**
 * Render one legal block for one locale.
 *
 * Substitutes `{entity}`, `{address}`, `{unsub_url}` and `{privacy_url}` from
 * `vars`, falling back only to the reviewed defaults in config/legal_text.yaml.
 *
 * Throws when the locale is unknown, the key is missing for that locale, or any
 * placeholder is left unfilled. There is deliberately no English fallback and no
 * model in this path: shipping the wrong jurisdiction's notice is worse than
 * failing the send.
 */
export function legalBlock(
  locale: string,
  key: LegalBlockKey,
  vars: Record<string, string> = {},
): string {
  const { data, version } = config.legalText();
  const shape = data as LegalTextShape;

  const blocks = shape.blocks ?? {};
  const localeBlocks = blocks[locale];
  if (!localeBlocks) {
    throw new MissingLegalTextError(
      `no legal text for locale ${locale} (${version}); refusing to fall back to another jurisdiction`,
    );
  }

  const template = localeBlocks[key];
  if (typeof template !== "string" || template.length === 0) {
    throw new MissingLegalTextError(`no '${key}' legal block for locale ${locale} (${version})`);
  }

  const defaults = shape.default ?? {};
  const values: Record<string, string | undefined> = {
    entity: vars.entity ?? defaults.entity,
    address: vars.address ?? defaults.postal_address,
    privacy_url: vars.privacy_url ?? defaults.privacy_url,
    unsub_url: vars.unsub_url,
    ...vars,
  };

  const rendered = template.replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
    const value = values[name];
    return typeof value === "string" && value.length > 0 ? value : whole;
  });

  // Fail closed: an unfilled placeholder must never reach a recipient.
  const leftover = rendered.match(/\{[a-z_]+\}/g);
  if (leftover) {
    throw new MissingLegalTextError(
      `legal block ${locale}/${key} has unsubstituted placeholders: ${leftover.join(", ")}`,
    );
  }
  return rendered;
}

// ---------------------------------------------------------------------------
// Bidirectional text. Genuine RTL script is content; bidi controls are an
// injection vector (spec §13.6) — they let displayed text differ from stored
// text, so a link or an unsubscribe line can be made to read as its opposite.
// ---------------------------------------------------------------------------

/**
 * Right-to-left language subtags. Matched against a locale's primary subtag, so
 * `ar`, `ar-AE` and `AR-ae` all resolve the same way.
 */
export const RTL_LOCALES: readonly string[] = [
  "ar", // Arabic
  "arc", // Aramaic
  "ckb", // Central Kurdish
  "dv", // Dhivehi
  "fa", // Persian
  "he", // Hebrew
  "ks", // Kashmiri
  "ku", // Kurdish (Sorani orthography)
  "nqo", // N'Ko
  "ps", // Pashto
  "sd", // Sindhi
  "ug", // Uyghur
  "ur", // Urdu
  "yi", // Yiddish
] as const;

/** True when a locale is written right-to-left. */
export function isRtlLocale(locale: string): boolean {
  const primary = locale.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return RTL_LOCALES.includes(primary);
}

/**
 * Bidi and zero-width control characters, by codepoint:
 *   U+061C  ARABIC LETTER MARK
 *   U+200B..U+200D  zero-width space / non-joiner / joiner
 *   U+200E, U+200F  LTR / RTL mark
 *   U+202A..U+202E  embedding and OVERRIDE controls
 *   U+2066..U+2069  isolate controls
 *   U+FEFF  zero-width no-break space (BOM)
 * Letters are untouched — U+061C is a control that happens to live in the Arabic
 * block, which is exactly why it is listed individually rather than by range.
 */
const BIDI_CONTROL_CLASS = "\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF";

/**
 * Strip bidi/zero-width controls while leaving genuine RTL script intact. Run on
 * any text that crosses a trust boundary before it is displayed or stored.
 * Arabic, Hebrew and Persian letters pass through untouched — only the controls
 * that decouple display order from stored order are removed.
 */
export function normalizeBidi(text: string): string {
  return text.replace(new RegExp(`[${BIDI_CONTROL_CLASS}]`, "g"), "");
}

/** True when the text carries a bidi/zero-width control character. */
export function hasBidiControls(text: string): boolean {
  return new RegExp(`[${BIDI_CONTROL_CLASS}]`).test(text);
}

// ---------------------------------------------------------------------------
// Template-family locale coverage.
// ---------------------------------------------------------------------------

interface TemplatesShape {
  families?: Record<string, { locales?: string[] }>;
}

/**
 * The locales a template family ships. Sourced from config/templates.yaml, so a
 * new locale is a reviewed config change, not a runtime decision.
 */
export function localeVariants(family: string): string[] {
  const data = config.templates().data as TemplatesShape;
  const row = (data.families ?? {})[family];
  if (!row) throw new MissingLegalTextError(`unknown template family: ${family}`);
  return [...(row.locales ?? [])];
}

/**
 * A family locale is only shippable when the jurisdiction's legal text exists
 * for it. Returns the locales that would fail closed at send time.
 */
export function localesMissingLegalText(family: string): string[] {
  const covered = new Set(legalLocales());
  return localeVariants(family).filter((l) => !covered.has(l));
}

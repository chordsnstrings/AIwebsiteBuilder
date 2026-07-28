// Deterministic text utilities shared by the extractor and the pipeline. No
// model, no network — everything here must produce the same answer on the same
// input forever, because fact ids are derived from its output.
import { createHash } from "node:crypto";

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

export function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/** Comparison form for "is this the same claim?". Not a display form. */
export function normalizeValue(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/[. ]+$/, "").trim();
}

export function slugify(value: string): string {
  const slug = normalizeValue(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  // A value that slugs to nothing (pure punctuation, non-Latin script) still
  // needs a stable distinct key, so fall back to a hash of the original.
  return slug.length > 0 ? slug : sha256Hex(value).slice(0, 16);
}

export function sha256Hex(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * A UUID derived from content rather than randomness. Side effects in this
 * system are keyed on workflow state (§ idempotency), so re-running extraction
 * on an unchanged crawl must produce the same row ids and write nothing new.
 */
export function deterministicUuid(...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("|")).digest();
  const b = Uint8Array.from(digest.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80; // RFC 9562 version 8: custom/name-derived
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // variant 10x
  const hex = Buffer.from(b).toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

const LANG_MARKERS: Record<string, string[]> = {
  en: ["the", "and", "our", "we", "with", "opening", "services", "call"],
  fr: ["nous", "vous", "votre", "horaires", "ouvert", "notre", "sur"],
  es: ["nosotros", "nuestro", "horario", "abierto", "servicios", "desde"],
  de: ["wir", "unsere", "öffnungszeiten", "geöffnet", "und", "für"],
  pt: ["nós", "nosso", "horário", "aberto", "serviços", "atendimento"],
  nl: ["wij", "onze", "openingstijden", "geopend", "voor"],
};

/**
 * Coarse language detection over a fixed marker set. Deliberately abstains
 * rather than guessing: a wrongly tagged fact ends up answering a customer in
 * the wrong language, and the caller has a market default that is better than
 * a coin flip.
 */
export function detectLanguage(text: string): string | undefined {
  const tokens = new Set(normalizeValue(text).split(/[^\p{L}]+/u).filter(Boolean));
  let best: { lang: string; hits: number } | undefined;
  let runnerUp = 0;
  for (const [lang, markers] of Object.entries(LANG_MARKERS)) {
    const hits = markers.filter((m) => tokens.has(m)).length;
    if (best === undefined || hits > best.hits) {
      runnerUp = best?.hits ?? 0;
      best = { lang, hits };
    } else if (hits > runnerUp) {
      runnerUp = hits;
    }
  }
  if (best === undefined || best.hits < 2 || best.hits === runnerUp) return undefined;
  return best.lang;
}

const COPYRIGHT_RE = /(?:©|\(c\)|copyright)\s*(?:19|20)\d{2}(?:\s*[-–—]\s*((?:19|20)\d{2}))?/gi;
const YEAR_RE = /(19|20)\d{2}/g;

/** The most recent year the page claims for itself, if any. */
export function copyrightYear(text: string): number | undefined {
  let latest: number | undefined;
  for (const match of text.matchAll(COPYRIGHT_RE)) {
    for (const year of match[0].matchAll(YEAR_RE)) {
      const n = Number(year[0]);
      if (latest === undefined || n > latest) latest = n;
    }
  }
  return latest;
}

function normalizeTime(raw: string, meridiem?: string): { text: string; hour: number; explicit: boolean } | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i.exec(raw.trim());
  if (!m) return null;
  const rawHour = Number(m[1]);
  if (!Number.isFinite(rawHour) || rawHour > 24) return null;
  const minutes = m[2] ?? "00";
  const mer = (m[3] ?? meridiem ?? "").toLowerCase();
  let hour = rawHour;
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  return { text: `${String(hour).padStart(2, "0")}:${minutes}`, hour, explicit: mer.length > 0 };
}

/**
 * Canonical 'HH:MM-HH:MM'. Both sides must be comparable across sources or the
 * conflict check degrades into "9-5 differs from 9:00am-5:00pm", which would
 * put a question in front of an owner for no reason.
 */
export function normalizeTimeRange(open: string, close: string): string | null {
  const a = normalizeTime(open);
  const b = normalizeTime(close);
  if (a === null || b === null) return null;
  // "9-5" on a shop sign means 09:00–17:00. Only applied when neither side
  // stated a meridiem, so an explicit "9pm-5am" night line is left alone.
  if (!a.explicit && !b.explicit && b.hour < a.hour) {
    const shifted = normalizeTime(close, "pm");
    if (shifted !== null) return `${a.text}-${shifted.text}`;
  }
  return `${a.text}-${b.text}`;
}

export function expandDayRange(from: string, to?: string): Day[] {
  const start = DAYS.indexOf(from.slice(0, 3).toLowerCase() as Day);
  if (start < 0) return [];
  if (to === undefined) return [DAYS[start] as Day];
  const end = DAYS.indexOf(to.slice(0, 3).toLowerCase() as Day);
  if (end < 0) return [DAYS[start] as Day];
  const out: Day[] = [];
  for (let i = start; ; i = (i + 1) % DAYS.length) {
    out.push(DAYS[i] as Day);
    if (i === end || out.length >= DAYS.length) break;
  }
  return out;
}

/** Paragraph-sized blocks, long enough that duplication means something. A
 *  three-word block ("Contact us") is duplicated across every site on earth. */
export function contentBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter((b) => words(b).length >= 8);
}

export function blockHash(block: string): string {
  return sha256Hex(normalizeValue(block));
}

export function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim());
}

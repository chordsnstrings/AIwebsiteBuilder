// The default extractor: regex and heuristics, no model, no API key. It exists
// so the KB pipeline is testable and runnable on its own — the ExtractorFn seam
// lets an agent-backed extractor replace it, but nothing downstream may assume
// one is available.
//
// Every rule here reads something the business PUBLISHED. There is no branch
// that fills a blank from world knowledge; a pattern that does not match
// produces no fact, which becomes a gap, which becomes an onboarding question.
import type { CrawledPage, ExtractorFn, GbpRecord, RawFact, ReviewSample } from "./types.ts";
import {
  detectLanguage,
  expandDayRange,
  lines,
  normalizeTimeRange,
  normalizeValue,
  slugify,
} from "./text.ts";

const DAY_TOKEN = "mon|tues?|weds?|thurs?|thu|fri|sat|sun";
const TIME_TOKEN = "\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm)?";
const DASH = "-|–|—|to|until|till|through";

const HOURS_RE = new RegExp(
  `\\b(${DAY_TOKEN})[a-z]*\\.?\\s*(?:(?:${DASH})\\s*(${DAY_TOKEN})[a-z]*\\.?)?\\s*[:\\s]\\s*(${TIME_TOKEN})\\s*(?:${DASH})\\s*(${TIME_TOKEN})`,
  "gi",
);
const CLOSED_RE = new RegExp(
  `\\b(${DAY_TOKEN})[a-z]*\\.?\\s*(?:(?:${DASH})\\s*(${DAY_TOKEN})[a-z]*\\.?)?\\s*[:\\s]\\s*(closed|geschlossen|fermé|cerrado|gesloten)\\b`,
  "gi",
);
const BARE_RANGE_RE = new RegExp(`(${TIME_TOKEN})\\s*(?:${DASH})\\s*(${TIME_TOKEN})`, "i");
const HOURS_LABEL_RE =
  /\b(opening hours|hours|horaires|öffnungszeiten|horario|hor[áa]rio|openingstijden|orari)\b/i;

const SERVICE_HEADING_RE =
  /^(?:our\s+)?(?:services|what we do|treatments|nos services|prestations|servicios|serviços|dienstleistungen|diensten)\b[:\s]*$/i;
const TEAM_HEADING_RE = /^(?:our\s+|the\s+|meet the\s+)?(?:team|staff|people|equipe|équipe|equipo)\b[:\s]*$/i;
const AREA_LEAD_RE =
  /\b(?:we (?:cover|serve|work (?:in|across))|areas? (?:we cover|served|covered)|service areas?|serving|coverage area|zone d'intervention|zona de servicio)\b\s*[:\-–]?\s*/i;

const PRICE_RE =
  /(?:from\s+)?(?:£|\$|€|R\$|A\$|C\$|CHF\s|NZ\$)\s?\d[\d,]*(?:\.\d{2})?(?:\s*(?:per|\/)\s*[a-z]+)?/i;
const PRICE_CONTEXT_RE = /\b(price|pricing|cost|costs|fee|fees|from|per|charge|rate|rates|tarif|precio)\b/i;

// Claims about competence and legal standing. Matching one of these does NOT
// make it true — everything here leaves the extractor as claimed_unverified and
// only a register lookup can promote it (§21.2).
const CREDENTIAL_RES: RegExp[] = [
  /\bgas safe(?:\s+registered)?(?:\s+(?:no\.?|number)\s*\d+)?/i,
  /\bniceic(?:\s+approved(?:\s+contractor)?)?/i,
  /\bpart\s?p\b(?:\s+(?:certified|registered))?/i,
  /\bcity\s*(?:&|and)\s*guilds\b/i,
  /\biso\s?9001\b/i,
  /\bchartered\s+[a-z]+/i,
  /\b(?:fully\s+)?(?:insured|licen[cs]ed)\b/i,
  /\b(?:certified|accredited|approved)\s+[a-z]+/i,
  /\b(?:checkatrade|trustmark|safecontractor|constructionline)\b/i,
  /\bdbs\s+checked\b/i,
  /\b(?:member|members)\s+of\s+the\s+[a-z ]{3,40}/i,
];

const ROLE_RE =
  /\b(owner|co-?founder|founder|director|manager|principal|partner|technician|engineer|plumber|electrician|roofer|stylist|colourist|therapist|dentist|hygienist|nurse|receptionist|apprentice|surveyor|accountant|solicitor|paralegal|groomer|mechanic|practice manager|head of [a-z]+|senior [a-z]+|lead [a-z]+)\b/i;
const STAFF_LINE_RE =
  /^([\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){0,2})\s*(?:[—–-]|,)\s*(.{3,60})$/u;

const ROLE_EMAIL_RE =
  /\b(?:info|contact|hello|admin|sales|bookings?|enquir(?:y|ies)|office|support|reception|accounts|help|team)@[\w.-]+\.[a-z]{2,}\b/gi;
const PHONE_RE = /\b(?:tel|telephone|phone|call us(?:\s+on)?|call)\b\s*[:\s]\s*(\+?\d[\d\s().-]{7,}\d)/gi;

const REVIEW_SERVICE_RE =
  /\b(?:did|do|does|fixed|installed|repaired|serviced|cleaned|replaced|fitted|sorted|unblocked|rewired)\s+(?:my|our|the)\s+([\p{L}][\p{L}\s]{2,28}?)(?=\s*(?:[.,!?;]|\band\b|\bwith\b|\bin\b|\bfor\b|$))/giu;
// Nouns that appear in this pattern constantly and name no service.
const REVIEW_STOP_SLUGS = new Set([
  "house", "home", "place", "flat", "issue", "issues", "problem", "problems",
  "job", "work", "thing", "things", "time", "appointment", "booking", "call",
  "price", "quote", "whole-thing", "whole-job",
]);
// A single reviewer's wording is noise; two independent reviewers naming the
// same thing is the weakest signal worth recording — and it is still 'inferred'.
const REVIEW_MIN_MENTIONS = 2;

const INFERRED_CONFIDENCE = 0.35;

function langOf(page: CrawledPage): string | undefined {
  return page.lang ?? detectLanguage(page.text);
}

function stripBullet(line: string): string {
  return line.replace(/^[-•*·]\s*/, "").trim();
}

/** Lines under a heading, up to the next blank line. A blank line is the only
 *  section boundary we can trust in text extracted from arbitrary markup. */
function sectionUnder(all: string[], headingRe: RegExp): string[] {
  const out: string[] = [];
  for (let i = 0; i < all.length; i++) {
    if (!headingRe.test(all[i] ?? "")) continue;
    for (let j = i + 1; j < all.length; j++) {
      const line = all[j] ?? "";
      if (line.length === 0) break;
      out.push(stripBullet(line));
    }
  }
  return out;
}

function splitList(value: string): string[] {
  return value
    .split(/,|;|·|\band\b|&/i)
    .map((p) => p.trim().replace(/^[-–—]\s*/, "").replace(/[.]+$/, ""))
    .filter((p) => p.length >= 2 && p.length <= 40);
}

function extractHours(page: CrawledPage, lang: string): RawFact[] {
  const out: RawFact[] = [];
  const seen = new Set<string>();
  const push = (day: string, value: string): void => {
    const key = `hours:${lang}:${day}`;
    if (seen.has(key)) return; // first statement on the page wins; later repeats are footers
    seen.add(key);
    out.push({
      type: "hours", value, factKey: key, lang,
      sourceUrl: page.url, retrievedAt: page.retrievedAt, confidence: 0.9,
    });
  };

  for (const m of page.text.matchAll(HOURS_RE)) {
    const range = normalizeTimeRange(m[3] ?? "", m[4] ?? "");
    if (range === null) continue;
    for (const day of expandDayRange(m[1] ?? "", m[2])) push(day, range);
  }
  for (const m of page.text.matchAll(CLOSED_RE)) {
    for (const day of expandDayRange(m[1] ?? "", m[2])) push(day, "closed");
  }

  // Non-English pages state hours without English weekday names. A labelled
  // bare range is still their published opening time; it is tagged 'general'
  // because we cannot say which day it applies to.
  if (out.length === 0) {
    for (const line of lines(page.text)) {
      if (!HOURS_LABEL_RE.test(line)) continue;
      const m = BARE_RANGE_RE.exec(line);
      if (m === null) continue;
      const range = normalizeTimeRange(m[1] ?? "", m[2] ?? "");
      if (range !== null) push("general", range);
      break;
    }
  }
  return out;
}

function priceIn(line: string): string | undefined {
  const m = PRICE_RE.exec(line);
  return m?.[0]?.trim();
}

function extractServicesAndPrices(page: CrawledPage, lang: string): RawFact[] {
  const out: RawFact[] = [];
  const all = lines(page.text);
  const base = { sourceUrl: page.url, retrievedAt: page.retrievedAt, lang } as const;

  for (const raw of sectionUnder(all, SERVICE_HEADING_RE)) {
    const price = priceIn(raw);
    const name = (price === undefined ? raw : raw.replace(price, "")).replace(/[\s—–:\-]+$/, "").trim();
    if (name.length < 2 || name.length > 80) continue;
    const slug = slugify(name);
    out.push({ ...base, type: "service", value: name, factKey: `service:${lang}:${slug}`, confidence: 0.9 });
    if (price !== undefined) {
      out.push({ ...base, type: "price", value: `${name}: ${price}`, factKey: `price:${lang}:${slug}`, confidence: 0.85 });
    }
  }

  // Prices stated outside a services list (a pricing page, a callout line).
  const known = new Set(out.filter((f) => f.type === "price").map((f) => f.factKey));
  for (const line of all) {
    if (line.length === 0 || !PRICE_CONTEXT_RE.test(line)) continue;
    const price = priceIn(line);
    if (price === undefined) continue;
    const label = line.replace(price, "").replace(/[\s—–:\-]+$/, "").replace(/^[-•*·]\s*/, "").trim();
    const slug = label.length >= 2 ? slugify(label) : "general";
    const key = `price:${lang}:${slug}`;
    if (known.has(key)) continue;
    known.add(key);
    out.push({ ...base, type: "price", value: label.length >= 2 ? `${label}: ${price}` : price, factKey: key, confidence: 0.8 });
  }
  return out;
}

function extractAreas(page: CrawledPage, lang: string): RawFact[] {
  const out: RawFact[] = [];
  const all = lines(page.text);
  const seen = new Set<string>();
  for (let i = 0; i < all.length; i++) {
    const line = all[i] ?? "";
    const m = AREA_LEAD_RE.exec(line);
    if (m === null) continue;
    const tail = line.slice(m.index + m[0].length).trim();
    const source = tail.length > 0 ? tail : (all[i + 1] ?? "");
    for (const area of splitList(source)) {
      const key = `area:${lang}:${slugify(area)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        type: "area", value: area, factKey: key, lang,
        sourceUrl: page.url, retrievedAt: page.retrievedAt, confidence: 0.85,
      });
    }
  }
  return out;
}

function extractCredentials(page: CrawledPage, lang: string): RawFact[] {
  const out: RawFact[] = [];
  const seen = new Set<string>();
  for (const re of CREDENTIAL_RES) {
    const m = re.exec(page.text);
    const value = m?.[0]?.trim();
    if (value === undefined) continue;
    const key = `credential:${lang}:${slugify(value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: "credential", value, factKey: key, lang, status: "claimed_unverified",
      sourceUrl: page.url, retrievedAt: page.retrievedAt, confidence: 0.7,
    });
  }
  return out;
}

function extractStaff(page: CrawledPage, lang: string): RawFact[] {
  const out: RawFact[] = [];
  // Only a "team" section, and only a line that publishes a ROLE. A name on its
  // own is a person, not a business fact, and must not be stored (§21.2).
  for (const line of sectionUnder(lines(page.text), TEAM_HEADING_RE)) {
    const m = STAFF_LINE_RE.exec(line);
    const name = m?.[1];
    const role = m?.[2]?.trim();
    if (name === undefined || role === undefined || !ROLE_RE.test(role)) continue;
    out.push({
      type: "staff", value: `${name} — ${role}`, factKey: `staff:${lang}:${slugify(name)}`, lang,
      sourceUrl: page.url, retrievedAt: page.retrievedAt, confidence: 0.8,
    });
  }
  return out;
}

function extractContacts(page: CrawledPage, lang: string): RawFact[] {
  const out: RawFact[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const key = `contact:${lang}:${slugify(value)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      type: "contact", value, factKey: key, lang,
      sourceUrl: page.url, retrievedAt: page.retrievedAt, confidence: 0.9,
    });
  };
  // Role mailboxes only. A named individual's address is personal data we have
  // no business storing, even when they published it.
  for (const m of page.text.matchAll(ROLE_EMAIL_RE)) push(m[0].toLowerCase());
  for (const m of page.text.matchAll(PHONE_RE)) {
    const phone = m[1]?.replace(/\s+/g, " ").trim();
    if (phone !== undefined) push(phone);
  }
  return out;
}

function extractGbp(gbp: GbpRecord): RawFact[] {
  const lang = gbp.lang ?? "en";
  const base = { sourceUrl: gbp.sourceUrl, retrievedAt: gbp.retrievedAt, lang } as const;
  const out: RawFact[] = [];

  for (const [day, raw] of Object.entries(gbp.hours ?? {})) {
    const m = BARE_RANGE_RE.exec(raw);
    const value = m === null ? normalizeValue(raw) : normalizeTimeRange(m[1] ?? "", m[2] ?? "");
    if (value === null || value.length === 0) continue;
    out.push({ ...base, type: "hours", value, factKey: `hours:${lang}:${day.slice(0, 3).toLowerCase()}`, confidence: 0.9 });
  }
  for (const service of gbp.services ?? []) {
    out.push({ ...base, type: "service", value: service, factKey: `service:${lang}:${slugify(service)}`, confidence: 0.85 });
  }
  for (const area of gbp.areaServed ?? []) {
    out.push({ ...base, type: "area", value: area, factKey: `area:${lang}:${slugify(area)}`, confidence: 0.85 });
  }
  if (gbp.phone !== undefined) {
    out.push({ ...base, type: "contact", value: gbp.phone, factKey: `contact:${lang}:${slugify(gbp.phone)}`, confidence: 0.9 });
  }
  return out;
}

function extractReviews(reviews: ReviewSample, knownServiceSlugs: Set<string>): RawFact[] {
  const mentions = new Map<string, { value: string; lang: string; reviewers: Set<number> }>();
  reviews.reviews.forEach((review, index) => {
    const lang = review.lang ?? detectLanguage(review.text) ?? "en";
    for (const m of review.text.matchAll(REVIEW_SERVICE_RE)) {
      const phrase = m[1]?.trim();
      if (phrase === undefined) continue;
      const slug = slugify(phrase);
      if (slug.length === 0 || REVIEW_STOP_SLUGS.has(slug) || knownServiceSlugs.has(slug)) continue;
      const entry = mentions.get(slug) ?? { value: phrase, lang, reviewers: new Set<number>() };
      entry.reviewers.add(index);
      mentions.set(slug, entry);
    }
  });

  const out: RawFact[] = [];
  for (const [slug, entry] of mentions) {
    if (entry.reviewers.size < REVIEW_MIN_MENTIONS) continue;
    out.push({
      type: "service", value: entry.value, factKey: `service:${entry.lang}:${slug}`, lang: entry.lang,
      // Reviews are the only source allowed to produce 'inferred'. It never
      // becomes an assertion — it becomes an onboarding question.
      status: "inferred", confidence: INFERRED_CONFIDENCE,
      sourceUrl: reviews.sourceUrl, retrievedAt: reviews.retrievedAt,
    });
  }
  return out;
}

/**
 * Default ExtractorFn. Pages first (highest source priority), then GBP, then
 * reviews. Language is per page, so a bilingual site yields two tagged sets
 * rather than one merged set in whichever language won.
 */
export const deterministicExtract: ExtractorFn = async (pages, gbp, reviews) => {
  const facts: RawFact[] = [];
  for (const page of pages) {
    const lang = langOf(page) ?? "en";
    facts.push(
      ...extractHours(page, lang),
      ...extractServicesAndPrices(page, lang),
      ...extractAreas(page, lang),
      ...extractCredentials(page, lang),
      ...extractStaff(page, lang),
      ...extractContacts(page, lang),
    );
  }
  if (gbp !== undefined) facts.push(...extractGbp(gbp));
  if (reviews !== undefined) {
    const known = new Set(
      facts.filter((f) => f.type === "service").map((f) => slugify(f.value)),
    );
    facts.push(...extractReviews(reviews, known));
  }
  return facts;
};

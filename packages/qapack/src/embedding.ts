// Deterministic, dependency-free text embedding (§21.3, §39.1). pgvector is not
// guaranteed present and no embedding endpoint sits on this path yet, but the
// spec forbids substituting string matching to save the $0.0003 — so features
// are hashed into a fixed 384-dim space here, and the interface is the one a
// real endpoint would satisfy.
//
// Three feature layers, and the third is the whole point. Surface tokens keep
// two published services apart; character n-grams absorb typos and morphology;
// the intent lexicon supplies the only thing surface features cannot — that
// "Do you work in Deira?" and "What areas do you cover?" are the same question.
// Those two share almost no characters. Without the lexicon layer this file
// would be the fuzzy matching §39.1 bans, wearing a vector's clothes.
//
// Nothing here may read the clock or a RNG: a pair embedded at build time is
// compared against a visitor question embedded months later, in another process.

export const EMBEDDING_DIMS = 384;

/**
 * Swap point for a real embedding endpoint. Batched because an endpoint charges
 * per call, not per string, and retrieval must never be the reason a caller
 * loops. `id` is stamped alongside the pack so vectors built by a different
 * provider are detectable rather than silently compared against incompatible
 * geometry.
 */
export interface EmbeddingProvider {
  readonly id: string;
  readonly dims: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

// Concept mass has to beat shared question scaffolding ("do you", "what is")
// without swamping the value tokens that separate "Do you offer gutter
// cleaning?" from "Do you offer chimney repair?" — same intent, different
// answers, and they must NOT collapse under the 0.95 dedupe rule.
const W_CONCEPT = 2.8;
const W_TOKEN = 1.0;
const W_STOPWORD = 0.15;
const W_BIGRAM = 0.4;
const W_CHARGRAM = 0.18;
const CHARGRAM_N = 4;

// Scaffolding carries almost no signal about WHICH question is being asked, so
// it is down-weighted rather than dropped — dropping it would make "do you" and
// the empty string identical.
const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "can", "could", "did", "do", "does",
  "for", "from", "get", "has", "have", "how", "i", "if", "in", "is", "it", "me", "my", "of",
  "on", "or", "please", "that", "the", "there", "they", "this", "to", "us", "was", "we",
  "what", "when", "where", "which", "who", "will", "with", "would", "you", "your",
]);

// A question-intent vocabulary, NOT a gazetteer: "work in" is what marks "Do you
// work in Deira?" as a service-area question, because no lexicon can enumerate
// every place name a visitor might type. Phrases may appear under two concepts;
// a callout is both an emergency and a booking.
const INTENT_LEXICON: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["service_area", [
    "area", "areas", "cover", "covers", "covered", "coverage", "work in", "operate in",
    "serve", "serves", "servicing", "travel to", "come to", "based in", "based",
    "postcode", "zip code", "suburb", "district", "neighbourhood", "neighborhood",
    "region", "radius", "how far", "located", "location", "locations", "near me", "local",
  ]],
  ["hours", [
    "hours", "open", "opening", "opens", "close", "closes", "closing", "closed",
    "weekend", "weekends", "saturday", "sunday", "bank holiday", "holiday",
    "what time", "out of hours", "evenings", "late", "early", "available", "availability",
  ]],
  ["pricing", [
    "price", "prices", "priced", "pricing", "cost", "costs", "how much", "charge",
    "charges", "fee", "fees", "rate", "rates", "quote", "quotation", "estimate",
    "callout fee", "call out fee", "hourly", "per hour", "cheap", "expensive", "budget",
  ]],
  ["booking", [
    "book", "booking", "bookings", "appointment", "appointments", "schedule", "slot",
    "slots", "availability", "reserve", "arrange", "visit", "come out", "reschedule",
    "callout", "callouts", "call out", "come out today", "today", "tomorrow", "how soon",
    "when can you", "fit me in",
  ]],
  ["contact", [
    "contact", "phone", "number", "call", "email", "whatsapp", "reach", "speak", "talk",
    "get in touch", "message",
  ]],
  ["services", [
    "do you do", "do you offer", "offer", "offers", "services", "service", "provide",
    "handle", "specialise", "specialize", "install", "installation", "repair", "repairs",
    "replace", "replacement", "maintenance", "fix", "clean", "cleaning",
  ]],
  ["emergency", [
    "emergency", "emergencies", "urgent", "urgently", "same day", "asap", "right now",
    "immediately", "24 hour", "24 7", "out of hours", "leak", "burst", "no heating",
    "no power", "callout", "callouts", "call out", "come out today", "breakdown",
  ]],
  ["payment", [
    "pay", "payment", "payments", "card", "cash", "bank transfer", "invoice", "deposit",
    "finance", "instalments", "installments", "up front", "upfront",
  ]],
  ["guarantee", [
    "guarantee", "guarantees", "guaranteed", "warranty", "warranties", "aftercare",
    "if it breaks", "come back",
  ]],
  ["credentials", [
    "qualified", "certified", "certification", "licence", "license", "licensed",
    "insured", "insurance", "accredited", "accreditation", "registered", "member",
    "trained", "dbs", "checked", "vetted",
  ]],
  ["experience", [
    "experience", "experienced", "how long", "years", "established", "since",
    "reviews", "reviewed", "rating", "references", "portfolio", "examples", "gallery",
  ]],
  ["process", [
    "process", "how does it work", "what happens", "next steps", "step", "steps",
    "how long does", "duration", "lead time", "wait", "waiting",
  ]],
  ["cancellation", ["cancel", "cancellation", "reschedule", "refund", "change my", "postpone"]],
  ["access", [
    "parking", "park", "access", "wheelchair", "disabled", "stairs", "lift", "elevator",
    "pets", "dog", "children",
  ]],
  ["language", ["language", "languages", "speak", "english", "arabic", "translator"]],
  ["commercial", [
    "commercial", "business", "businesses", "office", "offices", "landlord", "landlords",
    "contract", "contracts", "b2b", "trade",
  ]],
];

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Lexicon phrases go through the same normaliser as the input, or entries like
// "24/7" would be unmatchable against text that normalises to "24 7".
const NORMALISED_LEXICON: ReadonlyArray<readonly [string, readonly string[]]> =
  INTENT_LEXICON.map(([concept, phrases]) => [concept, phrases.map((p) => ` ${normalise(p)} `)]);

// FNV-1a. Cryptographic hashing would be pointless here: this runs a few hundred
// times per pack build and once per visitor turn, and the only property required
// is a stable spread — which FNV has and which, unlike a seeded PRNG, survives a
// process restart unchanged.
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function add(vec: Float32Array, feature: string, weight: number): void {
  const bucket = fnv1a(feature) % EMBEDDING_DIMS;
  // Signed hashing, salted so the sign is not a function of the bucket:
  // unsigned collisions inflate similarity systematically in one direction.
  const sign = fnv1a("sign|" + feature) & 1 ? -1 : 1;
  vec[bucket] = (vec[bucket] ?? 0) + sign * weight;
}

/**
 * Embed one string into a unit-length 384-dim vector. Same input, same floats,
 * on any machine and in any process — that stability is what lets a pack
 * embedded at build time be queried by a runtime that started months later.
 */
export function embedText(text: string): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIMS);
  const norm = normalise(text);
  if (norm.length === 0) return vec;

  const tokens = norm.split(" ");
  for (const token of tokens) {
    add(vec, "t|" + token, STOPWORDS.has(token) ? W_STOPWORD : W_TOKEN);
  }
  for (let i = 0; i + 1 < tokens.length; i++) {
    add(vec, "b|" + tokens[i] + " " + tokens[i + 1], W_BIGRAM);
  }

  const padded = ` ${norm} `;
  for (let i = 0; i + CHARGRAM_N <= padded.length; i++) {
    add(vec, "c|" + padded.slice(i, i + CHARGRAM_N), W_CHARGRAM);
  }

  for (const [concept, phrases] of NORMALISED_LEXICON) {
    // One hit per concept. A question is not "more about service areas" for
    // saying "area" twice, and letting it be would make long answers drift.
    if (phrases.some((p) => padded.includes(p))) add(vec, "k|" + concept, W_CONCEPT);
  }

  return l2Normalise(vec);
}

function l2Normalise(vec: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vec) sum += v * v;
  if (sum === 0) return vec;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) * inv;
  return vec;
}

/** The default provider: no network, no cost, no clock. */
export const localEmbeddingProvider: EmbeddingProvider = {
  id: "adw-hashed-ngram-v1",
  dims: EMBEDDING_DIMS,
  embed(texts: readonly string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map(embedText));
  },
};

/** Cosine similarity. Throws on a dimension mismatch rather than returning a
 * number the caller would compare against a threshold. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  // Both operands are unit vectors, so the dot product IS the cosine; the clamp
  // only absorbs float drift past ±1.
  return dot > 1 ? 1 : dot < -1 ? -1 : dot;
}

/** float32 little-endian, matching qa_pairs.embedding BYTEA + embedding_dims. */
export function serialiseEmbedding(vec: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i] ?? 0, i * 4);
  return buf;
}

/**
 * Inverse of serialiseEmbedding. Endianness is explicit on both sides so a pack
 * written on one architecture reads back identically on another.
 */
export function deserialiseEmbedding(buf: Buffer): Float32Array {
  if (buf.length % 4 !== 0) {
    throw new Error(`Embedding buffer length ${buf.length} is not a multiple of 4`);
  }
  const vec = new Float32Array(buf.length / 4);
  for (let i = 0; i < vec.length; i++) vec[i] = buf.readFloatLE(i * 4);
  return vec;
}

// The 20 fixture businesses (spec §48.3, §55.4).
//
// This set is the shared substrate for every suite in evals/: it is fully
// deterministic (no randomness, no dates, no network) so a run on any machine
// produces byte-identical inputs. The set is authored to span the axes the spec
// requires the pipeline to survive — four regions, six trade families, both
// prospect segments, three locales — plus eight named adversarial edge cases
// that have historically broken enrichment, preview generation or the reviewer.
//
// Edge cases are marked with a machine-readable `edge:<tag>` prefix on `note`
// rather than a separate field, so the fixture row stays exactly the shape the
// rest of the system consumes. `edgeTagOf()` reads it back.

export type Region = "R1" | "R2" | "R3" | "R4";
export type Family =
  | "trades"
  | "personal_services"
  | "food_hospitality"
  | "automotive"
  | "professional_services"
  | "retail";
export type Segment = "no_site" | "stale_site";
export type Locale = "en-US" | "en-GB" | "en-AU";

export interface FixtureBusiness {
  id: string;
  name: string;
  category: string;
  family: Family;
  countryCode: string;
  region: Region;
  locale: Locale;
  city: string;
  segment: Segment;
  reviewCount: number;
  rating: number;
  photoCount: number;
  /** Absent when the listing states no opening hours (an edge case in itself). */
  hours?: string;
  note: string;
}

/** The eight named edge cases the fixture set must contain (spec §55.4). */
export const REQUIRED_EDGE_CASES = [
  "no_photos",
  "review_count_400",
  "non_latin_name",
  "trademark_collision",
  "prohibited_category",
  "single_word_name",
  "no_hours",
  "category_content_disagreement",
] as const;
export type EdgeCase = (typeof REQUIRED_EDGE_CASES)[number];

export const REQUIRED_REGIONS: Region[] = ["R1", "R2", "R3", "R4"];
export const REQUIRED_FAMILIES: Family[] = [
  "trades",
  "personal_services",
  "food_hospitality",
  "automotive",
  "professional_services",
  "retail",
];
export const REQUIRED_SEGMENTS: Segment[] = ["no_site", "stale_site"];
export const REQUIRED_LOCALES: Locale[] = ["en-US", "en-GB", "en-AU"];

/** Well-known marks used only to detect a colliding fixture name. */
const KNOWN_MARKS = ["amazon", "google", "apple", "nike", "disney", "starbucks", "tesla", "adidas"];

export const FIXTURE_BUSINESSES: FixtureBusiness[] = [
  // --- R1 (US / CA), en-US --------------------------------------------------
  {
    id: "fx-01",
    name: "Ridgeline Plumbing & Drain",
    category: "plumber",
    family: "trades",
    countryCode: "US",
    region: "R1",
    locale: "en-US",
    city: "Denver",
    segment: "no_site",
    reviewCount: 38,
    rating: 4.6,
    photoCount: 6,
    hours: "Mon-Fri 08:00-17:00",
    note: "Baseline no-site trades prospect; every field populated and unremarkable.",
  },
  {
    id: "fx-02",
    name: "Coastal Electric Co.",
    category: "electrician",
    family: "trades",
    countryCode: "US",
    region: "R1",
    locale: "en-US",
    city: "San Diego",
    segment: "stale_site",
    reviewCount: 112,
    rating: 4.4,
    photoCount: 0,
    hours: "Mon-Sat 07:00-18:00",
    note: "edge:no_photos — listing carries zero imagery; the preview must not invent or imply photography.",
  },
  {
    id: "fx-03",
    name: "Fern & Foil Salon",
    category: "salon",
    family: "personal_services",
    countryCode: "CA",
    region: "R1",
    locale: "en-US",
    city: "Toronto",
    segment: "no_site",
    reviewCount: 27,
    rating: 4.8,
    photoCount: 9,
    hours: "Tue-Sat 09:00-19:00",
    note: "Baseline personal-services prospect in the second R1 country.",
  },
  {
    id: "fx-04",
    name: "Amazon Mobile Detailing",
    category: "car_detailing",
    family: "automotive",
    countryCode: "US",
    region: "R1",
    locale: "en-US",
    city: "Phoenix",
    segment: "no_site",
    reviewCount: 45,
    rating: 4.5,
    photoCount: 5,
    hours: "Mon-Sun 08:00-20:00",
    note: "edge:trademark_collision — legitimate local trading name that collides with a well-known mark; must not be used in domains, logos or copy without review.",
  },
  {
    id: "fx-05",
    name: "Sunridge Spine & Wellness Clinic",
    category: "massage",
    family: "personal_services",
    countryCode: "US",
    region: "R1",
    locale: "en-US",
    city: "Austin",
    segment: "stale_site",
    reviewCount: 88,
    rating: 4.2,
    photoCount: 14,
    hours: "Mon-Fri 08:00-18:00",
    note: "edge:prohibited_category — clinic whose existing copy claims it cures chronic pain (health_outcomes); build must be refused and escalated, not negotiated.",
  },
  {
    id: "fx-06",
    name: "Halvorsen",
    category: "accountant",
    family: "professional_services",
    countryCode: "CA",
    region: "R1",
    locale: "en-US",
    city: "Calgary",
    segment: "stale_site",
    reviewCount: 19,
    rating: 4.9,
    photoCount: 3,
    hours: "Mon-Fri 09:00-17:00",
    note: "edge:single_word_name — one-token surname trading name; headline and title templates must not read as truncated.",
  },

  // --- R2 (GB / AU) ---------------------------------------------------------
  {
    id: "fx-07",
    name: "Bellweather Barbers",
    category: "barber",
    family: "personal_services",
    countryCode: "GB",
    region: "R2",
    locale: "en-GB",
    city: "Leeds",
    segment: "stale_site",
    reviewCount: 400,
    rating: 4.7,
    photoCount: 12,
    hours: "Tue-Sat 09:00-18:00",
    note: "edge:review_count_400 — very high review volume; scoring must not saturate or overflow the ICP boost.",
  },
  {
    id: "fx-08",
    name: "The Copper Pot",
    category: "restaurant",
    family: "food_hospitality",
    countryCode: "GB",
    region: "R2",
    locale: "en-GB",
    city: "Bristol",
    segment: "no_site",
    reviewCount: 210,
    rating: 4.5,
    photoCount: 30,
    hours: "Wed-Sun 12:00-22:00",
    note: "Baseline food & hospitality prospect with a rich listing.",
  },
  {
    id: "fx-09",
    name: "Trentside Tyre & Exhaust",
    category: "tyre_shop",
    family: "automotive",
    countryCode: "GB",
    region: "R2",
    locale: "en-GB",
    city: "Nottingham",
    segment: "stale_site",
    reviewCount: 63,
    rating: 4.1,
    photoCount: 4,
    note: "edge:no_hours — listing states no opening hours; the site must omit an hours block rather than guess one.",
  },
  {
    id: "fx-10",
    name: "Kirribilli Blooms",
    category: "florist",
    family: "retail",
    countryCode: "AU",
    region: "R2",
    locale: "en-AU",
    city: "Sydney",
    segment: "no_site",
    reviewCount: 54,
    rating: 4.8,
    photoCount: 22,
    hours: "Mon-Sat 08:00-17:00",
    note: "Baseline retail prospect on the en-AU locale.",
  },
  {
    id: "fx-11",
    name: "Southern Cross Roofing",
    category: "roofer",
    family: "trades",
    countryCode: "AU",
    region: "R2",
    locale: "en-AU",
    city: "Melbourne",
    segment: "stale_site",
    reviewCount: 76,
    rating: 4.3,
    photoCount: 11,
    hours: "Mon-Fri 07:00-16:00",
    note: "Stale-site trades prospect; spelling and date formats must follow en-AU.",
  },
  {
    id: "fx-12",
    name: "Marrickville Pet Spa",
    category: "pet_grooming",
    family: "personal_services",
    countryCode: "AU",
    region: "R2",
    locale: "en-AU",
    city: "Sydney",
    segment: "no_site",
    reviewCount: 31,
    rating: 4.9,
    photoCount: 17,
    hours: "Tue-Sat 08:30-17:30",
    note: "Second en-AU prospect so locale coverage does not rest on a single row.",
  },

  // --- R3 (AE) --------------------------------------------------------------
  {
    id: "fx-13",
    name: "مطعم الياسمين",
    category: "restaurant",
    family: "food_hospitality",
    countryCode: "AE",
    region: "R3",
    locale: "en-GB",
    city: "Dubai",
    segment: "no_site",
    reviewCount: 149,
    rating: 4.6,
    photoCount: 25,
    hours: "Sat-Thu 11:00-23:00",
    note: "edge:non_latin_name — right-to-left non-Latin trading name; slugs, meta titles and image alt text must survive transliteration without mojibake.",
  },
  {
    id: "fx-14",
    name: "Al Quoz Auto Works",
    category: "auto_repair",
    family: "automotive",
    countryCode: "AE",
    region: "R3",
    locale: "en-GB",
    city: "Dubai",
    segment: "stale_site",
    reviewCount: 92,
    rating: 4.4,
    photoCount: 8,
    hours: "Sat-Thu 08:00-20:00",
    note: "R3 automotive prospect; note the Sat-Thu working week in the hours string.",
  },
  {
    id: "fx-15",
    name: "Jumeirah Gift Gallery",
    category: "gift_shop",
    family: "retail",
    countryCode: "AE",
    region: "R3",
    locale: "en-GB",
    city: "Dubai",
    segment: "no_site",
    reviewCount: 41,
    rating: 4.5,
    photoCount: 19,
    hours: "Sat-Thu 10:00-22:00",
    note: "R3 retail prospect at the higher regional price point.",
  },

  // --- R4 (NG / BR / IN) ----------------------------------------------------
  {
    id: "fx-16",
    name: "Lekki Fresh Bakes",
    category: "bakery",
    family: "food_hospitality",
    countryCode: "NG",
    region: "R4",
    locale: "en-GB",
    city: "Lagos",
    segment: "no_site",
    reviewCount: 58,
    rating: 4.7,
    photoCount: 13,
    hours: "Mon-Sat 07:00-19:00",
    note: "R4 prospect; annual prepay only, so the pricing path differs from R1-R3.",
  },
  {
    id: "fx-17",
    name: "Ikeja Business Consultants",
    category: "consultant",
    family: "professional_services",
    countryCode: "NG",
    region: "R4",
    locale: "en-GB",
    city: "Lagos",
    segment: "stale_site",
    reviewCount: 22,
    rating: 4.0,
    photoCount: 2,
    hours: "Mon-Fri 08:00-17:00",
    note: "Thin listing with a stale site; low photo count stresses the template's empty states.",
  },
  {
    id: "fx-18",
    name: "Salão Beleza Pura",
    category: "salon",
    family: "personal_services",
    countryCode: "BR",
    region: "R4",
    locale: "en-US",
    city: "São Paulo",
    segment: "no_site",
    reviewCount: 134,
    rating: 4.6,
    photoCount: 21,
    hours: "Ter-Sab 09:00-19:00",
    note: "Latin-script name with diacritics and non-English hours text; must round-trip without normalisation damage.",
  },
  {
    id: "fx-19",
    name: "Sharma Hardware Mart",
    category: "hardware_store",
    family: "retail",
    countryCode: "IN",
    region: "R4",
    locale: "en-GB",
    city: "Jaipur",
    segment: "stale_site",
    reviewCount: 87,
    rating: 4.2,
    photoCount: 7,
    hours: "Mon-Sun 09:00-21:00",
    note: "edge:category_content_disagreement — listing category says hardware store but the listing text and every photo describe a wedding photography studio; enrichment must not silently pick one.",
  },
  {
    id: "fx-20",
    name: "Coimbatore Studio 9",
    category: "photographer",
    family: "professional_services",
    countryCode: "IN",
    region: "R4",
    locale: "en-GB",
    city: "Coimbatore",
    segment: "no_site",
    reviewCount: 66,
    rating: 4.8,
    photoCount: 28,
    hours: "Mon-Sat 10:00-20:00",
    note: "R4 professional-services prospect with a photo-heavy listing.",
  },
];

/** Read the machine-readable edge tag off a fixture note, if any. */
export function edgeTagOf(note: string): EdgeCase | undefined {
  const m = /^edge:([a-z0-9_]+)/.exec(note);
  if (!m || m[1] === undefined) return undefined;
  const tag = m[1];
  return (REQUIRED_EDGE_CASES as readonly string[]).includes(tag) ? (tag as EdgeCase) : undefined;
}

/** All edge tags present in the fixture set. */
export function edgeCasesPresent(fixtures: FixtureBusiness[] = FIXTURE_BUSINESSES): Set<EdgeCase> {
  const present = new Set<EdgeCase>();
  for (const f of fixtures) {
    const tag = edgeTagOf(f.note);
    if (tag) present.add(tag);
  }
  return present;
}

/** True when the name uses characters outside Basic Latin + Latin Extended-A/B. */
export function hasNonLatinName(name: string): boolean {
  return /[^\u0000-\u024F]/.test(name);
}

/** True when the name collides with a well-known trademark. */
export function collidesWithKnownMark(name: string): boolean {
  const lower = name.toLowerCase();
  return KNOWN_MARKS.some((mark) => lower.includes(mark));
}

/** True when the trading name is a single token. */
export function isSingleWordName(name: string): boolean {
  return name.trim().split(/\s+/).length === 1;
}

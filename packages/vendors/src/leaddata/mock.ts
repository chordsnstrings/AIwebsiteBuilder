// Deterministic LeadSource simulator. Records are derived by hashing
// (vendorId, query, index) against fixed tables — the same query always returns
// the same businesses, in the same order, with the same fields. Nothing here is
// random, so lead-scoring evals and gate decisions are reproducible.
import { BaseMockVendor, seedHex, seedInt } from "../health.ts";
import type { BusinessRecord, LeadBatch, LeadSource } from "./types.ts";

const MAX_BATCH = 500;
const PER_RECORD_CENTS = 3;

const PLACES: { city: string; countryCode: string; dialCode: string }[] = [
  { city: "Manchester", countryCode: "GB", dialCode: "+44" },
  { city: "Leeds", countryCode: "GB", dialCode: "+44" },
  { city: "Bristol", countryCode: "GB", dialCode: "+44" },
  { city: "Dublin", countryCode: "IE", dialCode: "+353" },
  { city: "Cork", countryCode: "IE", dialCode: "+353" },
  { city: "Toronto", countryCode: "CA", dialCode: "+1" },
  { city: "Austin", countryCode: "US", dialCode: "+1" },
  { city: "Melbourne", countryCode: "AU", dialCode: "+61" },
  { city: "Auckland", countryCode: "NZ", dialCode: "+64" },
];

const CATEGORIES = [
  "plumber",
  "electrician",
  "roofer",
  "landscaper",
  "dentist",
  "accountant",
  "driving_instructor",
  "hair_salon",
];

const TRADING_NAMES = [
  "Halloran",
  "Beckwith",
  "Ferris",
  "Okonjo",
  "Lindqvist",
  "Ramachandran",
  "Whitfield",
  "Delgado",
  "Novak",
  "Ashworth",
  "Brennan",
  "Kowalski",
];

const SUFFIXES = ["& Sons", "Ltd", "Services", "& Co", "Group", "Trades"];

function pick<T>(table: readonly T[], n: number): T {
  const value = table[n % table.length];
  // Unreachable: the modulus is always in range. Keeps noUncheckedIndexedAccess honest.
  if (value === undefined) throw new Error("empty lookup table");
  return value;
}

function titleCase(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class MockLeadSource extends BaseMockVendor implements LeadSource {
  private batches = 0;
  private recordsServed = 0;

  async fetchBatch(query: string, limit: number): Promise<LeadBatch> {
    this.assertUp("fetchBatch");
    if (query.trim() === "") throw new Error("query is required");
    const count = Math.max(0, Math.min(Math.floor(limit), MAX_BATCH));
    const records = Array.from({ length: count }, (_unused, i) => this.recordAt(query, i));
    this.batches += 1;
    this.recordsServed += records.length;
    return {
      records,
      licenceRef: `licence:${this.vendorId}:${seedHex(8, this.vendorId, query)}`,
      costCents: records.length * PER_RECORD_CENTS,
    };
  }

  private recordAt(query: string, index: number): BusinessRecord {
    const at = (salt: string): number => seedInt(this.vendorId, query, String(index), salt);
    const place = pick(PLACES, at("place"));
    const category = pick(CATEGORIES, at("category"));
    const name = `${pick(TRADING_NAMES, at("name"))} ${titleCase(category)} ${pick(SUFFIXES, at("suffix"))}`;
    // 60% of the batch has no website — that is the segment the foundry sells to.
    const hasWebsite = at("website") % 100 >= 60;
    return {
      externalRef: `${this.vendorId}:${seedHex(16, this.vendorId, query, String(index))}`,
      name,
      category,
      countryCode: place.countryCode,
      city: place.city,
      phone: `${place.dialCode}${1000000 + (at("phone") % 8999999)}`,
      websiteUrl: hasWebsite ? `https://${slug(name)}.example` : null,
      reviewCount: at("reviews") % 400,
      rating: Math.round((3 + (at("rating") % 21) / 10) * 10) / 10,
    };
  }

  batchCount(): number {
    return this.batches;
  }

  recordCount(): number {
    return this.recordsServed;
  }

  protected override async probeOperation(): Promise<string> {
    const batch = await this.fetchBatch("__sentinel_probe__", 1);
    const first = batch.records[0];
    if (!first) throw new Error("probe batch returned no records");
    if (batch.licenceRef === "") throw new Error("probe batch has no licence reference");
    return `1 record, licence ${batch.licenceRef}`;
  }
}

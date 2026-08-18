// The LeadSource capability. Every batch carries the licence reference it was
// obtained under and what it cost — provenance and unit economics travel with
// the data, they are not reconstructed later.
export interface BusinessRecord {
  externalRef: string;
  name: string;
  category: string;
  countryCode: string;
  city: string;
  phone: string;
  /** null is the interesting case: a business with no website is the ICP. */
  websiteUrl: string | null;
  reviewCount: number;
  rating: number;
  /**
   * The contact address the licence covers.
   *
   * ⛔ `null` is common and must NOT be filled in by guessing. A record with no
   * email is a record that cannot be contacted, full stop — inventing
   * info@<name>.com would be manufacturing a recipient, which is precisely what
   * the provenance chain exists to make impossible.
   *
   * This field did not exist, and `ingestRecord` requires an email, so nothing
   * could ever be ingested: the pipeline had no way to begin.
   */
  email: string | null;
  /**
   * The page the record was observed on, carried from the vendor.
   *
   * ⛔ Also required by `ingestRecord`, and it is the evidence a regulator asks
   * for: not "we licensed this from X" but "this address was published here, on
   * this date". Reconstructing it later is impossible, so it travels with the
   * record or it does not exist.
   */
  sourceUrl: string;
}

export interface LeadBatch {
  records: BusinessRecord[];
  licenceRef: string;
  costCents: number;
}

export interface LeadSource {
  readonly vendorId: string;
  fetchBatch(query: string, limit: number): Promise<LeadBatch>;
}

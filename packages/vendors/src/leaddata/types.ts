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

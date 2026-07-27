// The DnsProvider capability. Record creation is an upsert on (zone, name,
// type) so that re-running a provisioning step converges instead of piling up
// duplicate records — the DNS half of an idempotent go-live.
export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT" | "MX" | "NS";

export interface DnsRecord {
  id: string;
  zone: string;
  name: string;
  type: DnsRecordType;
  value: string;
  ttl: number;
}

export interface DnsProvider {
  readonly vendorId: string;
  createRecord(zone: string, name: string, type: DnsRecordType, value: string): Promise<DnsRecord>;
  resolve(name: string): Promise<string | null>;
  listRecords(zone: string): Promise<DnsRecord[]>;
}

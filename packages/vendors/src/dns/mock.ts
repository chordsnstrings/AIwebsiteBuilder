// Stateful in-memory DnsProvider simulator (Cloudflare shape). Zone contents
// live in a map keyed by (zone, name, type); resolve() answers from the most
// recently written record for a name, which is enough to verify that a
// provisioning step actually landed.
import { BaseMockVendor, seedHex } from "../health.ts";
import type { DnsProvider, DnsRecord, DnsRecordType } from "./types.ts";

const DEFAULT_TTL = 300;

function key(zone: string, name: string, type: DnsRecordType): string {
  return `${zone.toLowerCase()}|${name.toLowerCase()}|${type}`;
}

export class MockDnsProvider extends BaseMockVendor implements DnsProvider {
  private readonly records = new Map<string, DnsRecord>();
  /** Insertion order per name, so resolve() can answer with the newest write. */
  private readonly byName = new Map<string, string[]>();

  async createRecord(zone: string, name: string, type: DnsRecordType, value: string): Promise<DnsRecord> {
    this.assertUp("createRecord");
    if (zone.trim() === "" || name.trim() === "") throw new Error("zone and name are required");
    const k = key(zone, name, type);
    const record: DnsRecord = {
      id: seedHex(16, this.vendorId, k),
      zone,
      name,
      type,
      value,
      ttl: DEFAULT_TTL,
    };
    this.records.set(k, record);
    const nameKey = name.toLowerCase();
    const order = this.byName.get(nameKey) ?? [];
    if (!order.includes(k)) order.push(k);
    this.byName.set(nameKey, order);
    return { ...record };
  }

  async resolve(name: string): Promise<string | null> {
    this.assertUp("resolve");
    const order = this.byName.get(name.toLowerCase());
    if (!order) return null;
    for (let i = order.length - 1; i >= 0; i--) {
      const k = order[i];
      if (k === undefined) continue;
      const record = this.records.get(k);
      if (record) return record.value;
    }
    return null;
  }

  async listRecords(zone: string): Promise<DnsRecord[]> {
    this.assertUp("listRecords");
    const wanted = zone.toLowerCase();
    return [...this.records.values()]
      .filter((r) => r.zone.toLowerCase() === wanted)
      .map((r) => ({ ...r }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
  }

  async deleteRecord(zone: string, name: string, type: DnsRecordType): Promise<boolean> {
    this.assertUp("deleteRecord");
    return this.records.delete(key(zone, name, type));
  }

  protected override async probeOperation(): Promise<string> {
    const zone = "sentinel-probe.invalid";
    const name = `_adw-probe.${zone}`;
    const value = seedHex(16, this.vendorId, "dns-probe");
    await this.createRecord(zone, name, "TXT", value);
    const resolved = await this.resolve(name);
    if (resolved !== value) throw new Error("probe TXT record did not resolve");
    return `TXT ${name} resolved`;
  }
}

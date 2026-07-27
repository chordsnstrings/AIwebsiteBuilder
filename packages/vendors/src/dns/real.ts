// REAL DnsProvider against the Cloudflare DNS API (v4). Same credential as
// Pages and R2 — one Cloudflare token wears three hats, which is why the mock is
// a composite and why all three real adapters carry vendorId "cloudflare".
//
// createRecord() is an UPSERT keyed on (name, type), exactly like the mock. That
// is not a nicety: provisioning is re-run on retry, and a create-only DNS path
// turns one retried go-live into a zone full of duplicate A records that resolve
// round-robin to a dead deployment.
//
// Vault: cloudflare/api_token, cloudflare/zone_id.
import { RealVendorBase } from "../real-base.ts";
import { CLOUDFLARE_API_BASE } from "../hosting/real.ts";
import { globalFetch, readBody, VendorHttpError, type FetchLike } from "../http.ts";
import type { DnsProvider, DnsRecord, DnsRecordType } from "./types.ts";

const DEFAULT_TTL = 300;

export interface CloudflareDnsConfig {
  apiToken: string;
  /**
   * The zone this adapter operates on. The DnsProvider interface passes a zone
   * NAME per call; a Cloudflare token is scoped to a zone ID. The configured id
   * wins, and the caller's zone name is echoed back on the returned record so
   * callers see what they asked about. Serve more than one zone by constructing
   * one adapter per zone.
   */
  zoneId: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result?: T;
}

interface CfDnsRecord {
  id: string;
  zone_name?: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
}

export class CloudflareDns extends RealVendorBase implements DnsProvider {
  constructor(private readonly cfg: CloudflareDnsConfig) {
    super("cloudflare");
  }

  /**
   * Upsert. Cloudflare has no upsert endpoint, so: list the zone, match on
   * (name, type), PATCH the match or POST a new record. Two round trips buys
   * convergence; one round trip buys duplicates.
   */
  async createRecord(zone: string, name: string, type: DnsRecordType, value: string): Promise<DnsRecord> {
    if (zone.trim() === "" || name.trim() === "") throw new Error("zone and name are required");
    const existing = await this.findRecord(name, type);
    const payload = JSON.stringify({ type, name, content: value, ttl: DEFAULT_TTL });

    if (existing) {
      const res = await this.http(`/zones/${this.cfg.zoneId}/dns_records/${existing.id}`, {
        method: "PATCH",
        body: payload,
      });
      return this.toRecord(await this.unwrap<CfDnsRecord>(res), zone);
    }
    const res = await this.http(`/zones/${this.cfg.zoneId}/dns_records`, { method: "POST", body: payload });
    return this.toRecord(await this.unwrap<CfDnsRecord>(res), zone);
  }

  /**
   * Answer from the zone's authoritative contents rather than a recursive
   * lookup: this asks "did the provisioning step land?", which is what the
   * caller actually needs, and it is not subject to resolver cache TTL.
   */
  async resolve(name: string): Promise<string | null> {
    const wanted = normaliseName(name);
    const records = await this.listZoneRecords();
    const matches = records.filter((r) => normaliseName(r.name) === wanted);
    const last = matches[matches.length - 1];
    return last?.content ?? null;
  }

  async listRecords(zone: string): Promise<DnsRecord[]> {
    const records = await this.listZoneRecords();
    return records
      .map((r) => this.toRecord(r, zone))
      .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
  }

  /** Not on the DnsProvider interface; used by teardown paths that hold this type. */
  async deleteRecord(_zone: string, name: string, type: DnsRecordType): Promise<boolean> {
    const existing = await this.findRecord(name, type);
    if (!existing) return false;
    const res = await this.http(`/zones/${this.cfg.zoneId}/dns_records/${existing.id}`, { method: "DELETE" });
    await this.unwrap<unknown>(res);
    return true;
  }

  // --- internals -----------------------------------------------------------

  private async findRecord(name: string, type: DnsRecordType): Promise<CfDnsRecord | undefined> {
    const records = await this.listZoneRecords();
    const wanted = normaliseName(name);
    return records.find((r) => normaliseName(r.name) === wanted && r.type === type);
  }

  private async listZoneRecords(): Promise<CfDnsRecord[]> {
    const res = await this.http(`/zones/${this.cfg.zoneId}/dns_records?per_page=100`, { method: "GET" });
    return this.unwrap<CfDnsRecord[]>(res);
  }

  private toRecord(raw: CfDnsRecord, zone: string): DnsRecord {
    return {
      id: raw.id,
      zone: raw.zone_name ?? zone,
      name: raw.name,
      type: raw.type as DnsRecordType,
      value: raw.content,
      ttl: raw.ttl,
    };
  }

  private http(path: string, init: { method: string; body?: string }) {
    const send = this.cfg.fetchImpl ?? globalFetch;
    return send(`${this.cfg.baseUrl ?? CLOUDFLARE_API_BASE}${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${this.cfg.apiToken}`, "content-type": "application/json" },
      body: init.body,
    });
  }

  private async unwrap<T>(res: Awaited<ReturnType<FetchLike>>): Promise<T> {
    const { text, json } = await readBody(res);
    if (!res.ok) throw new VendorHttpError(this.vendorId, res.status, text);
    const env = json as CfEnvelope<T> | undefined;
    if (!env?.success) {
      const detail = env?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? text;
      throw new VendorHttpError(this.vendorId, res.status, detail);
    }
    return env.result as T;
  }

  protected override async probeOperation(): Promise<string> {
    const res = await this.http(`/zones/${this.cfg.zoneId}`, { method: "GET" });
    const zone = await this.unwrap<{ name?: string }>(res);
    return `zone ${zone.name ?? this.cfg.zoneId} reachable`;
  }
}

/** DNS names are case-insensitive and the trailing root dot is not significant. */
function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

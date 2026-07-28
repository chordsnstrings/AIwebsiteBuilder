// Resolver implementations.
//
// The interface is injected so tests are hermetic and so the production path is
// one implementation rather than the only one. DNS-over-HTTPS is used in
// production because it needs no system resolver configuration and answers the
// same way from any container — a snapshot that varies by where it ran is not
// evidence.
import type { DnsRecord, DnsResolver, RecordType } from "./types.ts";

/** Deterministic in-memory resolver. Tests and the demo run against this. */
export class StaticResolver implements DnsResolver {
  constructor(private readonly zones: Map<string, DnsRecord[]> = new Map()) {}

  static from(domain: string, records: DnsRecord[]): StaticResolver {
    return new StaticResolver(new Map([[domain.toLowerCase(), records]]));
  }

  set(domain: string, records: DnsRecord[]): this {
    this.zones.set(domain.toLowerCase(), records);
    return this;
  }

  async resolve(domain: string, type: RecordType): Promise<DnsRecord[]> {
    return (this.zones.get(domain.toLowerCase()) ?? []).filter((r) => r.type === type);
  }
}

/** RFC 8484 numeric type codes, for the DoH query string. */
const TYPE_CODES: Record<RecordType, number> = {
  A: 1,
  AAAA: 28,
  CNAME: 5,
  MX: 15,
  TXT: 16,
  SRV: 33,
  NS: 2,
};

interface DohAnswer {
  name: string;
  type: number;
  TTL?: number;
  data: string;
}

export interface DohOptions {
  /** Any RFC 8484 endpoint. Defaults to Cloudflare's. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * DNS-over-HTTPS resolver.
 *
 * ⛔ A query that fails throws rather than returning an empty array. An empty
 * answer and a failed lookup are indistinguishable to a caller, and treating a
 * failure as "this domain has no MX records" is how a snapshot ends up claiming
 * a customer had no mail to break.
 */
export class DohResolver implements DnsResolver {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: DohOptions = {}) {
    this.endpoint = opts.endpoint ?? "https://cloudflare-dns.com/dns-query";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async resolve(domain: string, type: RecordType): Promise<DnsRecord[]> {
    const url = `${this.endpoint}?name=${encodeURIComponent(domain)}&type=${TYPE_CODES[type]}`;
    const res = await this.fetchImpl(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`DoH ${type} lookup for ${domain} failed: ${res.status}`);
    }
    const body = (await res.json()) as { Status?: number; Answer?: DohAnswer[] };
    // NXDOMAIN (3) genuinely means no such name. Any other non-zero status is a
    // failure we must not read as absence.
    if (body.Status !== undefined && body.Status !== 0 && body.Status !== 3) {
      throw new Error(`DoH ${type} lookup for ${domain} returned status ${body.Status}`);
    }
    const answers = (body.Answer ?? []).filter((a) => a.type === TYPE_CODES[type]);
    return answers.map((a) => toRecord(domain, type, a));
  }
}

function toRecord(domain: string, type: RecordType, answer: DohAnswer): DnsRecord {
  // The label relative to the zone: "example.com." -> "@", "www.example.com." -> "www".
  const name = answer.name.replace(/\.$/, "").toLowerCase();
  const zone = domain.replace(/\.$/, "").toLowerCase();
  const label = name === zone ? "@" : name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name;

  if (type === "MX") {
    // DoH returns MX data as "10 mail.example.com."
    const [priority, ...rest] = answer.data.trim().split(/\s+/);
    return {
      type,
      name: label,
      value: rest.join(" ").replace(/\.$/, ""),
      priority: Number(priority),
      ...(answer.TTL === undefined ? {} : { ttl: answer.TTL }),
    };
  }
  return {
    type,
    name: label,
    // TXT answers arrive quoted, sometimes split across chunks.
    value: type === "TXT" ? answer.data.replace(/^"|"$/g, "").replace(/"\s+"/g, "") : answer.data.replace(/\.$/, ""),
    ...(answer.TTL === undefined ? {} : { ttl: answer.TTL }),
  };
}

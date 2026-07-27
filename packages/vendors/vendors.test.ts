import { beforeEach, describe, expect, it } from "vitest";
import {
  ENTRY_FILE,
  MockBrowser,
  MockDnsProvider,
  MockDomainRegistrar,
  MockEmailTransport,
  MockEmailVerifier,
  MockLeadSource,
  MockObjectStore,
  MockSiteHost,
  getEmailTransport,
  getRegistrar,
  getSiteHost,
  getVendorMock,
  resetVendorMocks,
  simulateOutage,
  specialisedVendorIds,
  vendorMocks,
} from "./src/index.ts";

// Every vendor id in config/vendors.yaml. getVendorMock() must answer for all
// of them — specialised where behaviour matters, generic for the long tail.
const REGISTER_VENDOR_IDS = [
  "registrar_reseller",
  "cloudflare",
  "aws_ses",
  "stripe",
  "stripe_connect",
  "secondary_processor",
  "google_business_profile",
  "modelark",
  "google_ai",
  "anthropic",
  "langfuse",
  "google_workspace",
  "microsoft_365",
  "cold_smtp",
  "cloudflare_registrar",
  "email_verification",
  "aws_sns",
  "lead_data_primary",
  "lead_data_secondary",
  "browserless",
  "postgres",
  "clickhouse",
  "redis",
  "temporal",
  "twilio",
  "sentry",
  "grafana",
  "healthchecks",
  "pushover",
  "pagerduty",
  "mercury",
  "counsel",
];

beforeEach(() => {
  resetVendorMocks();
});

describe("vendor mock registry", () => {
  it("returns a probeable, breakable mock for every vendor in the register", async () => {
    for (const vendorId of REGISTER_VENDOR_IDS) {
      const mock = getVendorMock(vendorId);
      expect(mock.vendorId).toBe(vendorId);
      const ok = await mock.roundTrip();
      expect(ok.ok, `${vendorId} should be healthy in demo mode`).toBe(true);
      expect(Number.isInteger(ok.latencyMs)).toBe(true);

      mock.simulateOutage(true);
      expect((await mock.roundTrip()).ok, `${vendorId} should fail under outage`).toBe(false);
      mock.simulateOutage(false);
      expect((await mock.roundTrip()).ok).toBe(true);
    }
  });

  it("hands back the same instance per vendor id so simulateOutage() sticks", async () => {
    simulateOutage("aws_ses", true);
    expect((await getVendorMock("aws_ses").roundTrip()).ok).toBe(false);
    expect((await getVendorMock("stripe").roundTrip()).ok).toBe(true);
    simulateOutage("aws_ses", false);
    expect((await getVendorMock("aws_ses").roundTrip()).ok).toBe(true);
  });

  it("wires the specialised capabilities to their register ids", () => {
    expect(specialisedVendorIds()).toEqual([
      "aws_ses",
      "browserless",
      "cloudflare",
      "cold_smtp",
      "email_verification",
      "google_workspace",
      "healthchecks",
      "lead_data_primary",
      "lead_data_secondary",
      "microsoft_365",
      "pagerduty",
      "pushover",
      "registrar_reseller",
    ]);
  });
});

describe("EmailTransport", () => {
  it("records a send and returns a message id", async () => {
    const ses = new MockEmailTransport("aws_ses");
    const result = await ses.send({
      to: "owner@example.com",
      from: "hello@brand.example",
      subject: "Your new site",
      body: "It is live.",
    });
    expect(result.accepted).toBe(true);
    expect(result.messageId).toContain("aws_ses");
    expect(ses.sentCount()).toBe(1);
    expect(ses.lastSent()?.to).toBe("owner@example.com");
  });

  it("emits a bounce event when the bounce rate is 1", async () => {
    const ses = new MockEmailTransport("aws_ses");
    ses.setRates({ bounceRate: 1 });
    await ses.send({ to: "gone@example.com", from: "hello@brand.example", subject: "hi", body: "hi" });
    const events = ses.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("bounce");
    expect(events[0]!.to).toBe("gone@example.com");
    // Drained events are gone — the webhook queue is not replayed.
    expect(ses.drainEvents()).toHaveLength(0);
  });

  it("delivers, complains and replies according to the configured mix", async () => {
    const pool = new MockEmailTransport("google_workspace");
    pool.setRates({ complaintRate: 1 });
    await pool.send({ to: "angry@example.com", from: "rep@cold.example", subject: "hi", body: "hi" });
    expect(pool.drainEvents()[0]!.type).toBe("complaint");

    pool.setRates({ complaintRate: 0, replyRate: 1 });
    await pool.send({ to: "keen@example.com", from: "rep@cold.example", subject: "hi", body: "hi" });
    expect(pool.drainEvents().map((e) => e.type)).toEqual(["delivered", "reply"]);
  });

  it("is deterministic: identical sends produce identical outcomes", async () => {
    const rates = { bounceRate: 0.5 };
    const runOne = new MockEmailTransport("microsoft_365");
    const runTwo = new MockEmailTransport("microsoft_365");
    runOne.setRates(rates);
    runTwo.setRates(rates);
    const message = { to: "a@example.com", from: "b@example.com", subject: "s", body: "b" };
    const first = await runOne.send(message);
    const second = await runTwo.send(message);
    expect(first.messageId).toBe(second.messageId);
    expect(runOne.drainEvents()).toEqual(runTwo.drainEvents());
  });

  it("refuses to send during an outage", async () => {
    const smtp = new MockEmailTransport("cold_smtp");
    smtp.simulateOutage(true);
    await expect(smtp.send({ to: "a@example.com", from: "b@example.com", subject: "s", body: "b" })).rejects.toThrow(
      /VENDOR_OUTAGE/,
    );
  });

  it("keeps probe traffic out of the deliverability feedback stream", async () => {
    const ses = getEmailTransport("aws_ses");
    await ses.roundTrip();
    expect(ses.sentCount()).toBe(0);
    expect(ses.pendingEventCount()).toBe(0);
  });
});

describe("SiteHost", () => {
  it("is content-addressed and idempotent: same content, same hash, no new version", async () => {
    const host = new MockSiteHost("cloudflare");
    const files = { [ENTRY_FILE]: "<h1>Vann Plumbing</h1>", "styles.css": "body{margin:0}" };
    const first = await host.deploy("site-123", files);
    const second = await host.deploy("site-123", { ...files });

    expect(second.contentHash).toBe(first.contentHash);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(host.versions(first.url)).toHaveLength(1);
    expect(await host.fetch(first.url)).toBe(files[ENTRY_FILE]);
  });

  it("changes hash when content changes, and rollback restores the prior content", async () => {
    const host = new MockSiteHost("cloudflare");
    const v1 = { [ENTRY_FILE]: "<h1>version one</h1>" };
    const v2 = { [ENTRY_FILE]: "<h1>version two</h1>" };
    const first = await host.deploy("site-abc", v1);
    const second = await host.deploy("site-abc", v2);

    expect(second.contentHash).not.toBe(first.contentHash);
    expect(await host.fetch(second.url)).toBe(v2[ENTRY_FILE]);

    await host.rollback(second.url, first.contentHash);
    expect(await host.fetch(second.url)).toBe(v1[ENTRY_FILE]);
    expect(host.liveHash(second.url)).toBe(first.contentHash);
  });

  it("returns null for an unknown url and rejects an unknown rollback hash", async () => {
    const host = new MockSiteHost("cloudflare");
    expect(await host.fetch("https://nothing.pages.dev")).toBeNull();
    const { url } = await host.deploy("site-x", { [ENTRY_FILE]: "hi" });
    await expect(host.rollback(url, "deadbeef")).rejects.toThrow(/unknown content hash/);
  });

  it("shares its outage switch with the cloudflare composite", async () => {
    simulateOutage("cloudflare", true);
    await expect(getSiteHost().deploy("site-y", { [ENTRY_FILE]: "hi" })).rejects.toThrow(/VENDOR_OUTAGE/);
    expect((await vendorMocks().cloudflare.roundTrip()).ok).toBe(false);
  });
});

describe("DnsProvider", () => {
  it("creates, resolves and lists records, upserting on repeat", async () => {
    const dns = new MockDnsProvider("cloudflare");
    await dns.createRecord("vann.example", "vann.example", "A", "203.0.113.10");
    await dns.createRecord("vann.example", "www.vann.example", "CNAME", "vann.example");
    expect(await dns.resolve("vann.example")).toBe("203.0.113.10");
    expect(await dns.resolve("nothing.example")).toBeNull();

    await dns.createRecord("vann.example", "vann.example", "A", "203.0.113.11");
    expect(await dns.resolve("vann.example")).toBe("203.0.113.11");
    expect(await dns.listRecords("vann.example")).toHaveLength(2);
  });
});

describe("ObjectStore", () => {
  it("round-trips bytes deterministically and lists by prefix", async () => {
    const r2 = new MockObjectStore("cloudflare");
    const payload = Buffer.from("artifact bytes");
    const put = await r2.put("builds/site-1/index.html", payload);
    const again = await r2.put("builds/site-2/index.html", Buffer.from("artifact bytes"));

    expect(put.etag).toBe(again.etag); // same input ⇒ same output
    expect(put.size).toBe(payload.length);
    expect((await r2.get("builds/site-1/index.html"))?.equals(payload)).toBe(true);
    expect(await r2.get("builds/missing")).toBeNull();
    expect(await r2.list("builds/")).toEqual(["builds/site-1/index.html", "builds/site-2/index.html"]);

    expect(await r2.delete("builds/site-1/index.html")).toBe(true);
    expect(await r2.delete("builds/site-1/index.html")).toBe(false);
  });

  it("does not let a caller mutate stored bytes through the buffer it wrote", async () => {
    const r2 = new MockObjectStore("cloudflare");
    const payload = Buffer.from("stable");
    await r2.put("k", payload);
    payload.write("XXXXXX");
    expect((await r2.get("k"))?.toString()).toBe("stable");
  });
});

describe("DomainRegistrar", () => {
  it("checks availability, registers and reports status", async () => {
    const registrar = new MockDomainRegistrar("registrar_reseller");
    expect(await registrar.checkAvailability("vann-plumbing.example")).toBe(true);
    expect(await registrar.checkAvailability("already-taken.example")).toBe(false);

    const registration = await registrar.register("vann-plumbing.example", 2);
    expect(registration.status).toBe("registered");
    expect(registration.years).toBe(2);
    expect(await registrar.checkAvailability("vann-plumbing.example")).toBe(false);
    expect(await registrar.status("vann-plumbing.example")).toBe("registered");
  });

  it("ALWAYS returns an auth code for a transfer out — outage, credit and lock be damned", async () => {
    const registrar = new MockDomainRegistrar("registrar_reseller");
    await registrar.register("vann-plumbing.example", 1);
    registrar.simulateOutage(true);
    registrar.setCreditBalanceDays(0);

    const auth = await registrar.requestTransferOut("vann-plumbing.example");
    expect(auth.authCode).toMatch(/^ADW-[0-9A-F]{12}$/);
    expect(auth.unlocked).toBe(true);
    expect(auth.domain).toBe("vann-plumbing.example");

    // Even for a domain that was never registered here.
    const stranger = await registrar.requestTransferOut("never-ours.example");
    expect(stranger.authCode).toMatch(/^ADW-/);
    // And it is stable on repeat.
    expect((await registrar.requestTransferOut("vann-plumbing.example")).authCode).toBe(auth.authCode);
  });

  it("exposes creditBalanceDays and fails its probe when credit runs out", async () => {
    const registrar = getRegistrar();
    expect(registrar.creditBalanceDays).toBeGreaterThan(0);
    expect((await registrar.roundTrip()).ok).toBe(true);
    registrar.setCreditBalanceDays(0);
    const result = await registrar.roundTrip();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/credit exhausted/);
  });
});

describe("LeadSource", () => {
  it("returns deterministic seeded records with licence and cost", async () => {
    const source = new MockLeadSource("lead_data_primary");
    const first = await source.fetchBatch("plumbers in Manchester", 25);
    const second = await new MockLeadSource("lead_data_primary").fetchBatch("plumbers in Manchester", 25);

    expect(first.records).toHaveLength(25);
    expect(first).toEqual(second); // same query ⇒ byte-identical batch
    expect(first.licenceRef).toMatch(/^licence:lead_data_primary:/);
    expect(first.costCents).toBe(75);

    const record = first.records[0]!;
    expect(record.externalRef).toMatch(/^lead_data_primary:/);
    expect(record.countryCode).toHaveLength(2);
    expect(record.phone.startsWith("+")).toBe(true);
    expect(record.rating).toBeGreaterThanOrEqual(3);
    expect(record.rating).toBeLessThanOrEqual(5);

    // The ICP is businesses with no website, so some must be null.
    expect(first.records.some((r) => r.websiteUrl === null)).toBe(true);
    expect(first.records.some((r) => r.websiteUrl !== null)).toBe(true);
  });

  it("caps the batch and charges only for what it returns", async () => {
    const source = new MockLeadSource("lead_data_primary");
    const batch = await source.fetchBatch("roofers", 10_000);
    expect(batch.records).toHaveLength(500);
    expect(batch.costCents).toBe(1500);
  });
});

describe("EmailVerifier", () => {
  it("is deterministic on the address alone", async () => {
    const verifier = new MockEmailVerifier("email_verification");
    expect(await verifier.verify("owner@example.com")).toBe("valid");
    expect(await verifier.verify("owner@example.com")).toBe("valid");
    expect(await verifier.verify("invalid.person@example.com")).toBe("invalid");
    expect(await verifier.verify("risky.person@example.com")).toBe("risky");
    expect(await verifier.verify("not-an-address")).toBe("invalid");
  });

  it("answers 'unknown' rather than a false 'valid' during an outage", async () => {
    const verifier = new MockEmailVerifier("email_verification");
    verifier.simulateOutage(true);
    expect(await verifier.verify("owner@example.com")).toBe("unknown");
  });
});

describe("Browser", () => {
  it("renders deterministically per url", async () => {
    const browser = new MockBrowser("browserless");
    const first = await browser.render("https://vann-plumbing.example/");
    const second = await browser.render("https://vann-plumbing.example/");
    const other = await browser.render("https://other.example/");

    expect(first.html).toBe(second.html);
    expect(first.screenshotHash).toBe(second.screenshotHash);
    expect(first.screenshot.equals(second.screenshot)).toBe(true);
    expect(other.screenshotHash).not.toBe(first.screenshotHash);
    expect(first.html).toContain("vann-plumbing.example");
  });

  it("rejects a non-http url", async () => {
    const browser = new MockBrowser("browserless");
    await expect(browser.render("ftp://nope.example")).rejects.toThrow(/unsupported url/);
  });
});

describe("alerting", () => {
  it("records deliveries on push and phone channels without probing through them", async () => {
    const { pushover, pagerduty } = vendorMocks();
    await pushover.send("[SEV1] stripe: key_rotated", 1);
    await pagerduty.send("[SEV1] stripe: key_rotated", 1);
    expect(pushover.delivered()).toHaveLength(1);
    expect(pushover.delivered()[0]!.kind).toBe("push");
    expect(pagerduty.delivered()[0]!.kind).toBe("phone");

    await pushover.roundTrip();
    expect(pushover.delivered()).toHaveLength(1); // a probe never pages a human
  });

  it("counts missed heartbeats — you are alerted by absence", async () => {
    const { healthchecks } = vendorMocks();
    expect(healthchecks.missedBeats()).toBe(Number.POSITIVE_INFINITY);
    const t0 = new Date("2026-07-27T12:00:00Z");
    await healthchecks.ping(t0);
    expect(healthchecks.missedBeats(new Date(t0.getTime() + 30_000))).toBe(0);
    expect(healthchecks.missedBeats(new Date(t0.getTime() + 3 * 60_000))).toBe(3);
    expect(healthchecks.beatCount()).toBe(1);
  });
});

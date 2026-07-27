// The vendor mock registry. getVendorMock() answers for ANY vendor id in
// config/vendors.yaml: a specialised simulator where one exists, a generic
// health surface otherwise. This is what lets the Sentinel build a probe per
// vendor without the Sentinel knowing anything about a particular vendor, and
// what makes "100% of T0/T1 vendors have a live probe" achievable in demo mode.
//
// Instances are process-wide singletons on purpose: simulateOutage("aws_ses",
// true) has to affect the same object the probe is measuring. Call
// resetVendorMocks() between tests that care.
import { MockCloudflare } from "./cloudflare.ts";
import { GenericVendorMock } from "./generic.ts";
import { MockEmailTransport } from "./email/mock.ts";
import { MockDomainRegistrar } from "./registrar/mock.ts";
import { MockLeadSource } from "./leaddata/mock.ts";
import { MockEmailVerifier } from "./verification/mock.ts";
import { MockBrowser } from "./browser/mock.ts";
import { MockAlertChannel, MockHeartbeatReceiver } from "./alerting/mock.ts";
import type { MockSiteHost } from "./hosting/mock.ts";
import type { MockDnsProvider } from "./dns/mock.ts";
import type { MockObjectStore } from "./storage/mock.ts";
import type { MockVendor } from "./health.ts";

/** Sending rails, in tier order: SES is the brand rail, the rest are cold fleet. */
export const EMAIL_VENDOR_IDS = ["aws_ses", "google_workspace", "microsoft_365", "cold_smtp"] as const;
export const LEAD_DATA_VENDOR_IDS = ["lead_data_primary", "lead_data_secondary"] as const;

export interface VendorMockSuite {
  cloudflare: MockCloudflare;
  email: Record<string, MockEmailTransport>;
  registrar: MockDomainRegistrar;
  leadData: Record<string, MockLeadSource>;
  verifier: MockEmailVerifier;
  browser: MockBrowser;
  pushover: MockAlertChannel;
  pagerduty: MockAlertChannel;
  healthchecks: MockHeartbeatReceiver;
}

function buildSuite(): VendorMockSuite {
  const email: Record<string, MockEmailTransport> = {};
  for (const id of EMAIL_VENDOR_IDS) email[id] = new MockEmailTransport(id);
  const leadData: Record<string, MockLeadSource> = {};
  for (const id of LEAD_DATA_VENDOR_IDS) leadData[id] = new MockLeadSource(id);
  return {
    cloudflare: new MockCloudflare("cloudflare"),
    email,
    registrar: new MockDomainRegistrar("registrar_reseller"),
    leadData,
    verifier: new MockEmailVerifier("email_verification"),
    browser: new MockBrowser("browserless"),
    pushover: new MockAlertChannel("pushover", "push"),
    pagerduty: new MockAlertChannel("pagerduty", "phone"),
    healthchecks: new MockHeartbeatReceiver("healthchecks"),
  };
}

function indexSuite(suite: VendorMockSuite): Map<string, MockVendor> {
  const byId = new Map<string, MockVendor>();
  byId.set("cloudflare", suite.cloudflare);
  for (const [id, transport] of Object.entries(suite.email)) byId.set(id, transport);
  byId.set("registrar_reseller", suite.registrar);
  for (const [id, source] of Object.entries(suite.leadData)) byId.set(id, source);
  byId.set("email_verification", suite.verifier);
  byId.set("browserless", suite.browser);
  byId.set("pushover", suite.pushover);
  byId.set("pagerduty", suite.pagerduty);
  byId.set("healthchecks", suite.healthchecks);
  return byId;
}

let suite = buildSuite();
let specialised = indexSuite(suite);
const generic = new Map<string, GenericVendorMock>();

/** The specialised simulators, for demos and tests that need real behaviour. */
export function vendorMocks(): VendorMockSuite {
  return suite;
}

/** Every vendor id that has a specialised (non-generic) simulator. */
export function specialisedVendorIds(): string[] {
  return [...specialised.keys()].sort();
}

/** A probeable, breakable mock for any vendor id in the register. */
export function getVendorMock(vendorId: string): MockVendor {
  const known = specialised.get(vendorId);
  if (known) return known;
  let fallback = generic.get(vendorId);
  if (!fallback) {
    fallback = new GenericVendorMock(vendorId);
    generic.set(vendorId, fallback);
  }
  return fallback;
}

/** The chaos switch, by vendor id. Used to prove a probe actually fails. */
export function simulateOutage(vendorId: string, on: boolean): void {
  getVendorMock(vendorId).simulateOutage(on);
}

/** Rebuild every mock from scratch — state, outages and all. */
export function resetVendorMocks(): void {
  suite = buildSuite();
  specialised = indexSuite(suite);
  generic.clear();
}

function requireMock<T extends MockVendor>(vendorId: string, guard: (m: MockVendor) => m is T, capability: string): T {
  const mock = getVendorMock(vendorId);
  if (!guard(mock)) throw new Error(`Vendor '${vendorId}' has no ${capability} mock.`);
  return mock;
}

export function getEmailTransport(vendorId: string): MockEmailTransport {
  return requireMock(vendorId, (m): m is MockEmailTransport => m instanceof MockEmailTransport, "EmailTransport");
}

export function getCloudflare(vendorId = "cloudflare"): MockCloudflare {
  return requireMock(vendorId, (m): m is MockCloudflare => m instanceof MockCloudflare, "Cloudflare");
}

export function getSiteHost(vendorId = "cloudflare"): MockSiteHost {
  return getCloudflare(vendorId).sites;
}

export function getDnsProvider(vendorId = "cloudflare"): MockDnsProvider {
  return getCloudflare(vendorId).dns;
}

export function getObjectStore(vendorId = "cloudflare"): MockObjectStore {
  return getCloudflare(vendorId).objects;
}

export function getRegistrar(vendorId = "registrar_reseller"): MockDomainRegistrar {
  return requireMock(vendorId, (m): m is MockDomainRegistrar => m instanceof MockDomainRegistrar, "DomainRegistrar");
}

export function getLeadSource(vendorId = "lead_data_primary"): MockLeadSource {
  return requireMock(vendorId, (m): m is MockLeadSource => m instanceof MockLeadSource, "LeadSource");
}

export function getEmailVerifier(vendorId = "email_verification"): MockEmailVerifier {
  return requireMock(vendorId, (m): m is MockEmailVerifier => m instanceof MockEmailVerifier, "EmailVerifier");
}

export function getBrowser(vendorId = "browserless"): MockBrowser {
  return requireMock(vendorId, (m): m is MockBrowser => m instanceof MockBrowser, "Browser");
}

export function getAlertChannel(vendorId: string): MockAlertChannel {
  return requireMock(vendorId, (m): m is MockAlertChannel => m instanceof MockAlertChannel, "AlertChannel");
}

export function getHeartbeatReceiver(vendorId = "healthchecks"): MockHeartbeatReceiver {
  return requireMock(vendorId, (m): m is MockHeartbeatReceiver => m instanceof MockHeartbeatReceiver, "HeartbeatReceiver");
}

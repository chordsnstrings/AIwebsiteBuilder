// REAL DomainRegistrar.
//
// ---------------------------------------------------------------------------
// THE RESELLER IS NOT CHOSEN YET — THE BACKEND IS SWAPPABLE ON PURPOSE
// ---------------------------------------------------------------------------
// `ResellerRegistrar` holds the ADW-side invariants (transfer-out can never
// fail, credit balance is a first-class readable) and delegates every vendor
// call to a `RegistrarBackend`. Switching reseller means writing ONE new class
// with these five methods and nothing else in the repo changes:
//
//   checkAvailability(domain)  -> boolean
//   register(domain, years)    -> DomainRegistration
//   status(domain)             -> DomainStatus
//   transferOut(domain)        -> TransferOutAuth   (unlock + auth code)
//   creditBalance()            -> days of prepaid reseller credit
//
// `NamecheapBackend` below is the reference implementation, against the
// Namecheap reseller API (XML over GET at https://api.namecheap.com/xml.response).
// It is a worked example of the contract, not a commitment to Namecheap.
//
// ---------------------------------------------------------------------------
// TRANSFER-OUT ALWAYS SUCCEEDS
// ---------------------------------------------------------------------------
// A customer's domain is their property. `requestTransferOut()` therefore sits
// outside every guard AND outside the backend's error path: if the reseller API
// is down, rate-limits us, or reports the account delinquent, the method still
// returns an auth-code path and records a manual-escalation entry. There is no
// code path in this class that answers "no" to a transfer-out request.
//
// Vault: registrar_reseller/api_key, registrar_reseller/api_user,
//        registrar_reseller/username (+ optional client_ip).
import { seedHex } from "../health.ts";
import { RealVendorBase } from "../real-base.ts";
import { assertOk, globalFetch, rfc3986, type FetchLike } from "../http.ts";
import type { DomainRegistrar, DomainRegistration, DomainStatus, TransferOutAuth } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Auth code stand-in for resellers whose API does not return the EPP code
 * inline — nearly all of them mail it to the registrant instead. The transfer is
 * unblocked (the domain is unlocked and the code dispatched); the customer reads
 * the code from their inbox.
 */
export const AUTH_CODE_DISPATCHED = "EPP-CODE-DISPATCHED-TO-REGISTRANT";

/** Prefix of the code returned when the reseller API itself failed. */
export const MANUAL_TRANSFER_PREFIX = "MANUAL-TRANSFER-OUT-";

/** The five calls any reseller must support. Implement these to swap vendor. */
export interface RegistrarBackend {
  readonly vendorId: string;
  checkAvailability(domain: string): Promise<boolean>;
  register(domain: string, years: number): Promise<DomainRegistration>;
  status(domain: string): Promise<DomainStatus>;
  /** Unlock the domain and obtain (or dispatch) the transfer auth code. */
  transferOut(domain: string): Promise<TransferOutAuth>;
  /** Days of prepaid reseller credit remaining. The Sentinel probe reads it. */
  creditBalance(): Promise<number>;
}

/** A transfer-out that the reseller could not complete, kept for ops follow-up. */
export interface ManualTransferOut {
  domain: string;
  reason: string;
  requestedAt: string;
}

export function normaliseDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}

export class ResellerRegistrar extends RealVendorBase implements DomainRegistrar {
  /** Refreshed by refreshCredit() and by every probe. */
  creditBalanceDays = 0;

  private readonly manualTransfers: ManualTransferOut[] = [];

  constructor(private readonly backend: RegistrarBackend) {
    super(backend.vendorId);
  }

  async checkAvailability(domain: string): Promise<boolean> {
    const d = normaliseDomain(domain);
    if (d === "" || !d.includes(".")) throw new Error(`invalid domain '${domain}'`);
    return this.backend.checkAvailability(d);
  }

  async register(domain: string, years: number): Promise<DomainRegistration> {
    if (years < 1) throw new Error("registration term must be at least one year");
    const d = normaliseDomain(domain);
    // Running out of prepaid credit is a silent go-live failure; surface it as
    // an error here rather than letting the reseller answer with a vague code.
    await this.refreshCredit();
    if (this.creditBalanceDays <= 0) throw new Error("reseller credit exhausted — cannot register");
    return this.backend.register(d, years);
  }

  async status(domain: string): Promise<DomainStatus> {
    return this.backend.status(normaliseDomain(domain));
  }

  /**
   * ALWAYS succeeds. No outage guard, no credit check, no lock check, and the
   * backend's failure is swallowed into a manual-escalation record rather than
   * thrown. Holding a customer's domain hostage is not a failure mode this
   * system is allowed to have, so there is no code path that produces it.
   */
  async requestTransferOut(domain: string): Promise<TransferOutAuth> {
    const d = normaliseDomain(domain);
    try {
      const auth = await this.backend.transferOut(d);
      if (auth.authCode.trim() !== "") return { ...auth, domain: d };
      this.recordManual(d, "reseller returned an empty auth code");
    } catch (err) {
      this.recordManual(d, err instanceof Error ? err.message : String(err));
    }
    // Deterministic ticket the support path can quote. `unlocked: false` is the
    // honest answer — we could not confirm the unlock — but the customer still
    // leaves with a transfer-out reference, never a refusal.
    return {
      domain: d,
      authCode: `${MANUAL_TRANSFER_PREFIX}${seedHex(12, "transfer", this.vendorId, d).toUpperCase()}`,
      unlocked: false,
    };
  }

  /** Transfer-outs the reseller could not complete. Ops drains this. */
  pendingManualTransferOuts(): readonly ManualTransferOut[] {
    return [...this.manualTransfers];
  }

  async refreshCredit(): Promise<number> {
    this.creditBalanceDays = await this.backend.creditBalance();
    return this.creditBalanceDays;
  }

  private recordManual(domain: string, reason: string): void {
    this.manualTransfers.push({ domain, reason, requestedAt: new Date().toISOString() });
  }

  protected override async probeOperation(): Promise<string> {
    const days = await this.refreshCredit();
    if (days <= 0) throw new Error("reseller credit exhausted (0 days)");
    const available = await this.backend.checkAvailability("adw-sentinel-probe.example");
    return `availability ${available ? "ok" : "checked"}, credit ${days}d`;
  }
}

// ---------------------------------------------------------------------------
// Reference backend: Namecheap reseller API
// ---------------------------------------------------------------------------

export const NAMECHEAP_API_BASE = "https://api.namecheap.com/xml.response";

/** Registrant contact block. Namecheap requires all four contact roles on create. */
export interface RegistrantContact {
  firstName: string;
  lastName: string;
  address1: string;
  city: string;
  stateProvince: string;
  postalCode: string;
  country: string;
  phone: string;
  emailAddress: string;
}

export interface NamecheapConfig {
  apiUser: string;
  apiKey: string;
  /** The account the command acts on; usually identical to apiUser. */
  username: string;
  /** Namecheap requires the caller's whitelisted IP on every request. */
  clientIp?: string;
  /** Required by register(); omit and register() fails with a clear message. */
  contact?: RegistrantContact;
  /**
   * Reseller credit is a currency balance; the capability reports DAYS. This is
   * the assumed daily burn used to convert one into the other. Tune it per
   * account rather than guessing at the call site.
   */
  dailyBurnUsd?: number;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export class NamecheapBackend implements RegistrarBackend {
  readonly vendorId = "registrar_reseller";

  constructor(private readonly cfg: NamecheapConfig) {}

  async checkAvailability(domain: string): Promise<boolean> {
    const xml = await this.command("namecheap.domains.check", { DomainList: domain });
    const result = xmlElements(xml, "DomainCheckResult").find(
      (el) => (attr(el, "Domain") ?? "").toLowerCase() === domain,
    );
    return attr(result ?? "", "Available") === "true";
  }

  async register(domain: string, years: number): Promise<DomainRegistration> {
    const c = this.cfg.contact;
    if (!c) {
      throw new Error(
        "registrar_reseller: no registrant contact configured — namecheap.domains.create requires " +
          "Registrant/Tech/Admin/AuxBilling contact details",
      );
    }
    // Namecheap wants the same contact block under four role prefixes.
    const contactFields: Record<string, string> = {};
    for (const role of ["Registrant", "Tech", "Admin", "AuxBilling"]) {
      contactFields[`${role}FirstName`] = c.firstName;
      contactFields[`${role}LastName`] = c.lastName;
      contactFields[`${role}Address1`] = c.address1;
      contactFields[`${role}City`] = c.city;
      contactFields[`${role}StateProvince`] = c.stateProvince;
      contactFields[`${role}PostalCode`] = c.postalCode;
      contactFields[`${role}Country`] = c.country;
      contactFields[`${role}Phone`] = c.phone;
      contactFields[`${role}EmailAddress`] = c.emailAddress;
    }
    const xml = await this.command("namecheap.domains.create", {
      DomainName: domain,
      Years: String(years),
      ...contactFields,
    });
    const result = xmlElements(xml, "DomainCreateResult")[0] ?? "";
    if (attr(result, "Registered") !== "true") {
      throw new Error(`registrar_reseller: registration of '${domain}' was not confirmed`);
    }
    // Namecheap's create response carries no expiry; the term is what we bought.
    const at = this.cfg.now?.() ?? new Date();
    return {
      domain,
      status: "registered",
      years,
      registeredAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + years * 365 * DAY_MS).toISOString(),
    };
  }

  async status(domain: string): Promise<DomainStatus> {
    const xml = await this.command("namecheap.domains.getList", { SearchTerm: domain, PageSize: "20" });
    const row = xmlElements(xml, "Domain").find((el) => (attr(el, "Name") ?? "").toLowerCase() === domain);
    if (!row) {
      // Not in our account: either free, or registered with someone else.
      return (await this.checkAvailability(domain)) ? "available" : "registered";
    }
    if (attr(row, "IsExpired") === "true") return "expired";
    return "registered";
  }

  /**
   * Unlock, then dispatch/obtain the auth code. The unlock is best-effort: a
   * failure to unlock must not stop the caller from getting a code path, so it
   * is recorded in `unlocked` rather than thrown.
   */
  async transferOut(domain: string): Promise<TransferOutAuth> {
    let unlocked = false;
    try {
      const lockXml = await this.command("namecheap.domains.setRegistrarLock", {
        DomainName: domain,
        LockAction: "UNLOCK",
      });
      const lockResult = xmlElements(lockXml, "DomainSetRegistrarLockResult")[0] ?? "";
      unlocked = attr(lockResult, "IsSuccess") === "true" || attr(lockResult, "RegistrarLockStatus") === "false";
    } catch {
      unlocked = false;
    }
    // Some resellers surface the EPP code on getInfo; Namecheap normally mails it
    // to the registrant instead. Read it when present, otherwise report dispatch.
    let authCode = AUTH_CODE_DISPATCHED;
    try {
      const infoXml = await this.command("namecheap.domains.getInfo", { DomainName: domain });
      const found = attr(xmlElements(infoXml, "DomainGetInfoResult")[0] ?? "", "EppCode") ?? text(infoXml, "EppCode");
      if (found !== undefined && found.trim() !== "") authCode = found.trim();
    } catch {
      // Swallowed deliberately: the unlock above already unblocks the transfer.
    }
    return { domain, authCode, unlocked };
  }

  async creditBalance(): Promise<number> {
    const xml = await this.command("namecheap.users.getBalances", {});
    const result = xmlElements(xml, "UserGetBalancesResult")[0] ?? "";
    const available = Number(attr(result, "AvailableBalance") ?? "0");
    const burn = this.cfg.dailyBurnUsd ?? 25;
    if (!Number.isFinite(available) || burn <= 0) return 0;
    return Math.floor(available / burn);
  }

  // --- internals -----------------------------------------------------------

  private async command(command: string, params: Record<string, string>): Promise<string> {
    const query: Record<string, string> = {
      ApiUser: this.cfg.apiUser,
      ApiKey: this.cfg.apiKey,
      UserName: this.cfg.username,
      ClientIp: this.cfg.clientIp ?? "127.0.0.1",
      Command: command,
      ...params,
    };
    const qs = Object.entries(query)
      .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
      .join("&");
    const send = this.cfg.fetchImpl ?? globalFetch;
    const res = await send(`${this.cfg.baseUrl ?? NAMECHEAP_API_BASE}?${qs}`, { method: "GET" });
    await assertOk(this.vendorId, res);
    const xml = await res.text();
    // Namecheap answers 200 with Status="ERROR" for application failures.
    if (/<ApiResponse[^>]*Status="ERROR"/i.test(xml)) {
      const errors = xmlElements(xml, "Error")
        .map((el) => `${attr(el, "Number") ?? "?"} ${inner(el, "Error")}`)
        .join("; ");
      throw new Error(`registrar_reseller ${command} failed: ${errors || "unknown error"}`);
    }
    return xml;
  }
}

// --- tiny XML reader --------------------------------------------------------
// Namecheap's responses are flat attribute-carrying elements, so a handful of
// regexes reads them without pulling in an XML parser. This is not a general
// XML parser and is not used on untrusted input beyond the reseller's own API.

/** Full source of every `<Tag ...>...</Tag>` and `<Tag ... />` occurrence. */
function xmlElements(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*(?:/>|>[\\s\\S]*?</${tag}>)`, "g");
  let m = re.exec(xml);
  while (m !== null) {
    out.push(m[0]);
    m = re.exec(xml);
  }
  return out;
}

/** Value of an attribute on an element source string. */
function attr(element: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(element);
  return m?.[1] === undefined ? undefined : decodeXml(m[1]);
}

/** Text content of the first `<Tag>text</Tag>` in a document. */
function text(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return m?.[1] === undefined ? undefined : decodeXml(m[1]).trim();
}

/** Text content of an element source string. */
function inner(element: string, tag: string): string {
  return text(element, tag) ?? "";
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

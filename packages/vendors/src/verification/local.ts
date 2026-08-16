// Deliverability checks that need no vendor, no credential and no invoice.
//
// ⛔ This exists because the system had NO pre-send verification of any kind.
// `config/vendors.yaml` registered `email_verification` as a T0 vendor and
// `DEPLOYMENT.md` claimed the vault slot flipped "real pre-send verification"
// live — and no code read that slot, `verification/` had no `real.ts`, and the
// one consumer of the `EmailVerifier` interface had zero production callers.
// Cold mail went out with nothing between it and a dead mailbox.
//
// Which matters more than it sounds. A bounce is not a wasted send; it is a
// deposit against the sending domain's reputation. At the configured 2.0% halt
// threshold a list with 5% dead addresses retires a domain that took 21 days to
// warm up, and a warm-up cannot be compressed.
//
// Everything here is a check a machine can settle for free. It never returns
// `valid` — the strongest verdict it can reach is "nothing is wrong with it",
// which is `unknown`, because a syntactically perfect address on a domain with
// MX records is still very often nobody. Claiming `valid` here would let the
// gate skip the paid verifier on exactly the addresses it exists for.

import { promises as dns } from "node:dns";
import type { VerificationVerdict } from "./types.ts";

/** RFC 5322 is enormous; this is the subset any real mailbox satisfies. */
const SHAPE = /^[^\s@,;<>"]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Mailboxes that reach a function, not a person.
 *
 * ⛔ Not merely low-converting — in most jurisdictions a role account is the one
 * least likely to be a "corporate subscriber" in the sense the legal-basis rules
 * mean, and it is the address most likely to be a spam trap. `info@` is the
 * single most common address on a small business's website and the single worst
 * one to cold-mail.
 */
const ROLE_LOCALPARTS = new Set([
  "abuse", "admin", "administrator", "all", "billing", "compliance", "contact", "enquiries",
  "enquiry", "everyone", "feedback", "ftp", "help", "hello", "hostmaster", "info", "inquiries",
  "inquiry", "it", "jobs", "legal", "list", "mail", "marketing", "noc", "no-reply", "noreply",
  "office", "postmaster", "privacy", "root", "sales", "security", "spam", "support", "sysadmin",
  "team", "webmaster", "www",
]);

/**
 * Throwaway-mailbox providers. Deliberately a short, high-confidence list rather
 * than a downloaded 100k-domain file: a false positive here silently drops a
 * real prospect forever, and the long tail of these domains does not appear on
 * a tradesman's Google listing.
 */
const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com", "guerrillamail.com", "mailinator.com", "tempmail.com", "temp-mail.org",
  "throwawaymail.com", "yopmail.com", "trashmail.com", "getnada.com", "sharklasers.com",
  "maildrop.cc", "dispostable.com", "fakeinbox.com", "mintemail.com", "spamgourmet.com",
]);

/** Domains that exist to swallow mail, not receive it. */
const NULL_DOMAINS = new Set(["example.com", "example.org", "example.net", "test", "localhost", "invalid"]);

export interface LocalCheck {
  verdict: VerificationVerdict;
  /** Which check settled it, for the operator console and for tuning. */
  reason: string;
  roleAccount: boolean;
  disposable: boolean;
  /** null when no lookup was performed. */
  hasMx: boolean | null;
}

export interface LocalVerifierOptions {
  /** Injected so tests never touch a resolver, and so a deployment can point at
   *  its own. */
  resolveMx?: (hostname: string) => Promise<{ exchange: string; priority: number }[]>;
  /** MX lookups are cached per domain — a list is mostly a few hundred domains
   *  behind a few thousand addresses. */
  cache?: Map<string, boolean>;
  /** ⛔ A resolver that hangs must not hang the send path. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;

function localPart(address: string): string {
  return address.slice(0, address.lastIndexOf("@")).toLowerCase();
}
export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** Strip a plus-tag: `owner+cold@x.com` is `owner@x.com` for role detection. */
function baseLocal(local: string): string {
  const plus = local.indexOf("+");
  return plus < 0 ? local : local.slice(0, plus);
}

export function isRoleAccount(address: string): boolean {
  return ROLE_LOCALPARTS.has(baseLocal(localPart(address)));
}

export function isDisposable(address: string): boolean {
  return DISPOSABLE_DOMAINS.has(domainOf(address));
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Check an address without asking anyone.
 *
 * ⛔ Returns `unknown` for anything that merely looks fine. Only structural
 * impossibility — bad shape, a domain with no MX, a documentation domain —
 * earns `invalid`, and only a role account or a throwaway earns `risky`. A
 * cheap check that says `valid` would let the caller skip the paid one.
 */
export async function verifyLocally(address: string, opts: LocalVerifierOptions = {}): Promise<LocalCheck> {
  const email = address.trim().toLowerCase();
  const base: LocalCheck = { verdict: "unknown", reason: "no local check failed", roleAccount: false, disposable: false, hasMx: null };

  if (!SHAPE.test(email)) {
    return { ...base, verdict: "invalid", reason: "address is not a valid mailbox shape" };
  }
  const domain = domainOf(email);
  if (NULL_DOMAINS.has(domain) || domain.endsWith(".example") || domain.endsWith(".invalid") || domain.endsWith(".test")) {
    return { ...base, verdict: "invalid", reason: `${domain} is a reserved documentation domain` };
  }
  const role = isRoleAccount(email);
  const disposable = isDisposable(email);
  if (disposable) {
    return { ...base, verdict: "invalid", reason: `${domain} is a throwaway mailbox provider`, disposable: true, roleAccount: role };
  }

  // MX. A domain with no mail exchanger cannot receive mail from anyone, which
  // is one of the few things that can be settled for certain and for free.
  const resolver = opts.resolveMx ?? ((h: string) => dns.resolveMx(h));
  const cache = opts.cache;
  let hasMx: boolean | null = cache?.get(domain) ?? null;
  if (hasMx === null) {
    const records = await withTimeout(resolver(domain).catch(() => [] as { exchange: string; priority: number }[]),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // ⛔ A timeout is `null`, NOT `false`. Treating an unreachable resolver as
    // "this domain has no MX" would invalidate an entire list during a DNS
    // blip, and the addresses would be marked invalid permanently.
    if (records !== null) {
      hasMx = records.length > 0;
      cache?.set(domain, hasMx);
    }
  }
  if (hasMx === false) {
    return { ...base, verdict: "invalid", reason: `${domain} publishes no MX record`, roleAccount: role, hasMx: false };
  }

  if (role) {
    return {
      ...base,
      verdict: "risky",
      reason: `${baseLocal(localPart(email))}@ is a role account, not a person`,
      roleAccount: true,
      hasMx,
    };
  }
  return { ...base, hasMx, roleAccount: false, disposable: false };
}

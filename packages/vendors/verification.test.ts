// Pre-send deliverability verification.
//
// This existed as an interface with no implementation and no callers.
// `config/vendors.yaml` registered `email_verification` as a T0 vendor and
// DEPLOYMENT.md said its vault slot flipped "real pre-send verification" live —
// and no code read that slot, there was no real adapter, and the sole consumer
// of `EmailVerifier` was never called outside its own test. Cold mail went out
// with nothing between it and a dead mailbox.
//
// The assertions that matter are about what must NOT be called valid: a
// catch-all domain, a role account, an address checked during a DNS outage.
// A false `valid` is what burns a sending domain, and a sending domain takes 21
// days to warm and cannot be warmed faster.
import { describe, expect, it } from "vitest";
import {
  HttpEmailVerifier,
  LayeredEmailVerifier,
  isDisposable,
  isRoleAccount,
  verifyLocally,
  type EmailVerifier,
} from "./src/index.ts";

const noMx = async () => [];
const withMx = async () => [{ exchange: "mx.example-host.net", priority: 10 }];
/** A resolver that never answers, as during a DNS incident. */
const hangs = () => new Promise<{ exchange: string; priority: number }[]>(() => {});

describe("checks that cost nothing", () => {
  it("rejects a malformed address", async () => {
    for (const bad of ["", "no-at-sign", "two@@at.com", "spaces in@x.com", "trailing@dot.", "a@b"]) {
      expect((await verifyLocally(bad, { resolveMx: withMx })).verdict, bad).toBe("invalid");
    }
  });

  it("rejects a domain with no MX record", async () => {
    const r = await verifyLocally("someone@nomail.co.uk", { resolveMx: noMx });
    expect(r.verdict).toBe("invalid");
    expect(r.reason).toMatch(/no MX record/);
  });

  it("⛔ treats a DNS timeout as unknown, never as 'no MX'", async () => {
    // Treating an unreachable resolver as "this domain cannot receive mail"
    // would invalidate an entire list during a DNS blip — and the addresses
    // would be marked invalid permanently, since the verdict is cached.
    const r = await verifyLocally("someone@slow.example-host.net", { resolveMx: hangs, timeoutMs: 20 });
    expect(r.verdict).toBe("unknown");
    expect(r.hasMx).toBeNull();
  });

  it("rejects throwaway mailbox providers", async () => {
    expect(isDisposable("x@mailinator.com")).toBe(true);
    expect(isDisposable("x@a-real-plumber.co.uk")).toBe(false);
    expect((await verifyLocally("x@guerrillamail.com", { resolveMx: withMx })).verdict).toBe("invalid");
  });

  it("rejects the reserved documentation domains our own fixtures use", async () => {
    // Otherwise a demo run would attempt real sends against example.com.
    for (const d of ["a@example.com", "a@thing.invalid", "a@host.test"]) {
      expect((await verifyLocally(d, { resolveMx: withMx })).verdict, d).toBe("invalid");
    }
  });

  it("⛔ marks a role account risky, including plus-tagged", async () => {
    // info@ is the commonest address on a small business's website and the
    // worst one to cold-mail: least likely to be a "corporate subscriber" in
    // the sense the legal-basis rules mean, most likely to be a spam trap.
    expect(isRoleAccount("info@x.com")).toBe(true);
    expect(isRoleAccount("Sales+tag@x.com")).toBe(true);
    expect(isRoleAccount("jane.doe@x.com")).toBe(false);
    const r = await verifyLocally("info@a-real-plumber.co.uk", { resolveMx: withMx });
    expect(r.verdict).toBe("risky");
    expect(r.roleAccount).toBe(true);
  });

  it("⛔ never returns 'valid' on its own", async () => {
    // The strongest thing free checks can conclude is "nothing is wrong with
    // it". Claiming valid would let the gate skip the paid verifier on exactly
    // the addresses it exists for.
    const r = await verifyLocally("jane@a-real-plumber.co.uk", { resolveMx: withMx });
    expect(r.verdict).toBe("unknown");
  });

  it("caches the MX lookup per domain, not per address", async () => {
    let calls = 0;
    const cache = new Map<string, boolean>();
    const counting = async () => {
      calls++;
      return [{ exchange: "mx", priority: 1 }];
    };
    for (const local of ["a", "b", "c"]) {
      await verifyLocally(`${local}@same-domain.co.uk`, { resolveMx: counting, cache });
    }
    expect(calls).toBe(1);
  });
});

describe("the paid verifier", () => {
  const respond = (body: unknown, status = 200) =>
    async () => ({ ok: status === 200, status, headers: {}, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });

  it("maps the common vendor vocabulary", async () => {
    for (const [status, expected] of [
      ["valid", "valid"],
      ["deliverable", "valid"],
      ["invalid", "invalid"],
      ["spamtrap", "invalid"],
      ["do_not_mail", "invalid"],
      ["role_based", "risky"],
    ] as const) {
      const v = new HttpEmailVerifier({ vendorId: "t", apiKey: "k", endpoint: "https://v.example/x", fetchImpl: respond({ status }) });
      expect(await v.verify("a@b.com"), status).toBe(expected);
    }
  });

  it("⛔ maps catch-all to unknown, never to valid", async () => {
    // A catch-all domain accepts mail for every local part including ones that
    // do not exist, so 'valid' from a catch-all carries no information — and
    // trusting it is precisely how a list looks clean and bounces anyway.
    for (const s of ["catch-all", "accept_all", "catch_all"]) {
      const v = new HttpEmailVerifier({ vendorId: "t", apiKey: "k", endpoint: "https://v.example/x", fetchImpl: respond({ status: s }) });
      expect(await v.verify("a@b.com"), s).toBe("unknown");
    }
  });

  it("⛔ answers 'unknown' on every failure path rather than throwing or approving", async () => {
    // A verifier outage must not stop the send programme AND must not silently
    // approve the list. Returning unknown puts the "we could not check" policy
    // in one place — the gate rule — instead of implying it with an exception.
    const cases: EmailVerifier[] = [
      new HttpEmailVerifier({ vendorId: "t", apiKey: "k", endpoint: "https://v.example/x", fetchImpl: respond({}, 500) }),
      new HttpEmailVerifier({ vendorId: "t", apiKey: "k", endpoint: "https://v.example/x", fetchImpl: respond({ nope: 1 }) }),
      new HttpEmailVerifier({
        vendorId: "t", apiKey: "k", endpoint: "https://v.example/x",
        fetchImpl: async () => { throw new Error("network down"); },
      }),
      new HttpEmailVerifier({
        vendorId: "t", apiKey: "k", endpoint: "https://v.example/x",
        fetchImpl: async () => ({ ok: true, status: 200, headers: {}, text: async () => "not json", arrayBuffer: async () => new ArrayBuffer(0) }),
      }),
    ];
    for (const [i, v] of cases.entries()) expect(await v.verify("a@b.com"), `case ${i}`).toBe("unknown");
  });

  it("maps an unrecognised status to unknown rather than guessing", async () => {
    const v = new HttpEmailVerifier({ vendorId: "t", apiKey: "k", endpoint: "https://v.example/x", fetchImpl: respond({ status: "brand_new_bucket" }) });
    expect(await v.verify("a@b.com")).toBe("unknown");
  });
});

describe("free checks run before the paid one", () => {
  const spyVerifier = () => {
    const calls: string[] = [];
    const v: EmailVerifier = { vendorId: "spy", verify: async (e) => { calls.push(e); return "valid"; } };
    return { v, calls };
  };

  it("⛔ does not pay a vendor for an address that is structurally dead", async () => {
    const { v, calls } = spyVerifier();
    const layered = new LayeredEmailVerifier(v, { resolveMx: noMx });
    expect(await layered.verify("someone@nomail.co.uk")).toBe("invalid");
    expect(calls, "no vendor call for a domain with no MX").toEqual([]);
  });

  it("⛔ does not let a vendor overrule 'role account'", async () => {
    // Several vendors happily return valid for info@. A role account is risky
    // by definition, not by probability, so asking would import that mistake at
    // 0.7 cents an address.
    const { v, calls } = spyVerifier();
    const layered = new LayeredEmailVerifier(v, { resolveMx: withMx });
    expect(await layered.verify("info@a-real-plumber.co.uk")).toBe("risky");
    expect(calls).toEqual([]);
  });

  it("asks the vendor exactly when the free checks cannot settle it", async () => {
    const { v, calls } = spyVerifier();
    const layered = new LayeredEmailVerifier(v, { resolveMx: withMx });
    expect(await layered.verify("jane@a-real-plumber.co.uk")).toBe("valid");
    expect(calls).toEqual(["jane@a-real-plumber.co.uk"]);
  });

  it("⛔ still checks what it can when no vendor is configured", async () => {
    // "No api key" must mean "we check what is free", not "we check nothing" —
    // a dead domain and an info@ are the two commonest problems on a scraped
    // list and neither needs a credential to find.
    const localOnly = new LayeredEmailVerifier(null, { resolveMx: noMx });
    expect(await localOnly.verify("someone@nomail.co.uk")).toBe("invalid");
    expect(localOnly.vendorId).toBe("local_only");
  });
});

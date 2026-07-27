// The unsubscribe token is the only thing standing between a recipient's click
// and the suppression ledger. It has to verify what we minted and refuse
// everything else — including tokens signed with a different secret, which is
// what a rotation gone wrong looks like.
import { describe, expect, it } from "vitest";
import {
  mintUnsubscribeToken,
  unsubscribeHeaders,
  unsubscribeSecret,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from "./src/unsubscribe.ts";

const SECRET = "test-unsubscribe-secret-0123456789";

describe("unsubscribe tokens", () => {
  it("round-trips a contact id", () => {
    const token = mintUnsubscribeToken({ contactId: "abc-123" }, SECRET);
    expect(verifyUnsubscribeToken(token, SECRET)).toEqual({ contactId: "abc-123" });
  });

  it("carries the campaign when one is given", () => {
    const token = mintUnsubscribeToken({ contactId: "abc", campaignId: "camp-9" }, SECRET);
    expect(verifyUnsubscribeToken(token, SECRET)).toEqual({ contactId: "abc", campaignId: "camp-9" });
  });

  it("rejects a token signed with a different secret", () => {
    const token = mintUnsubscribeToken({ contactId: "abc" }, SECRET);
    expect(verifyUnsubscribeToken(token, "some-other-secret")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = mintUnsubscribeToken({ contactId: "victim" }, SECRET);
    const [version, , signature] = token.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ contactId: "someone-else" })).toString("base64url");
    expect(verifyUnsubscribeToken(`${version}.${forged}.${signature}`, SECRET)).toBeNull();
  });

  it("rejects a truncated signature rather than comparing a prefix", () => {
    const token = mintUnsubscribeToken({ contactId: "abc" }, SECRET);
    const [version, encoded, signature] = token.split(".") as [string, string, string];
    expect(verifyUnsubscribeToken(`${version}.${encoded}.${signature.slice(0, 10)}`, SECRET)).toBeNull();
  });

  it("rejects an unknown version prefix", () => {
    const token = mintUnsubscribeToken({ contactId: "abc" }, SECRET);
    expect(verifyUnsubscribeToken(token.replace(/^u1\./, "u9."), SECRET)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of ["", "..", "u1.$$$.$$$", "not-a-token", "u1.e30.x"]) {
      expect(verifyUnsubscribeToken(bad, SECRET)).toBeNull();
    }
  });

  it("rejects a well-formed token carrying no contact id", () => {
    const encoded = Buffer.from(JSON.stringify({ campaignId: "c" })).toString("base64url");
    const body = `u1.${encoded}`;
    // Sign it properly — the signature is valid, the payload is not.
    const token = mintUnsubscribeToken({ contactId: "x" }, SECRET);
    const signature = token.split(".")[2]!;
    expect(verifyUnsubscribeToken(`${body}.${signature}`, SECRET)).toBeNull();
  });
});

describe("unsubscribe headers", () => {
  it("builds a URL under the given origin", () => {
    expect(unsubscribeUrl("https://p.adwpreview.com/", "tok")).toBe("https://p.adwpreview.com/u/tok");
  });

  it("emits the RFC 8058 literal verbatim", () => {
    // A paraphrase here silently disables one-click at every mailbox provider,
    // which is exactly the kind of failure nobody notices for a month.
    const h = unsubscribeHeaders("https://p.adwpreview.com/u/tok");
    expect(h["List-Unsubscribe"]).toBe("<https://p.adwpreview.com/u/tok>");
    expect(h["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

describe("unsubscribeSecret", () => {
  it("falls back only outside production", () => {
    expect(unsubscribeSecret({ ADW_ENV: "test" })).toBe("local-unsubscribe-secret");
    expect(unsubscribeSecret({ ADW_ENV: "local" })).toBe("local-unsubscribe-secret");
  });

  it("refuses to start in production without one", () => {
    expect(() => unsubscribeSecret({ ADW_ENV: "production" })).toThrow(/ADW_UNSUBSCRIBE_SECRET/);
  });

  it("refuses a secret too short to be worth signing with", () => {
    expect(() => unsubscribeSecret({ ADW_ENV: "production", ADW_UNSUBSCRIBE_SECRET: "short" })).toThrow();
  });

  it("uses the configured secret when present", () => {
    expect(unsubscribeSecret({ ADW_ENV: "production", ADW_UNSUBSCRIBE_SECRET: SECRET })).toBe(SECRET);
  });
});

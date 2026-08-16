// Webhook authentication.
//
// The bug these exist for: the route verified an `x-adw-signature` HMAC that no
// vendor sends, so every genuine SNS bounce and Stripe event was answered 401
// while the effects tests — which called the handler directly — stayed green.
// The suppression ledger was unreachable and nothing said so.
//
// So the assertions that matter are not "a good signature passes". They are
// "a signature Amazon would actually produce passes" and "the attack this
// algorithm invites is refused".
import { createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  assertSigningUrl,
  clearCertCache,
  snsStringToSign,
  verifySharedSecret,
  verifySns,
  verifyStripe,
  type SnsEnvelope,
} from "./src/webhook-auth.ts";
import { createHmac } from "node:crypto";

// A throwaway self-signed X.509, so the test signs and verifies through the
// same code path Amazon's traffic takes — real RSA, real certificate parsing.
//
// ⛔ The first version of this fixture relabelled an SPKI public-key PEM as
// "BEGIN CERTIFICATE" to satisfy our own guard. It passed the guard and then
// failed inside node's verifier, and the four failures looked like bugs in the
// implementation rather than in the fixture. A fixture that is not the real
// artefact tests the fixture.
const { privateKeyPem, certPem } = (() => {
  const dir = mkdtempSync(join(tmpdir(), "sns-cert-"));
  const key = join(dir, "k.pem");
  const crt = join(dir, "c.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", crt, "-days", "1",
    "-subj", "/CN=sns.us-east-1.amazonaws.com",
  ], { stdio: "ignore" });
  return { privateKeyPem: readFileSync(key, "utf8"), certPem: readFileSync(crt, "utf8") };
})();

function signSns(msg: SnsEnvelope, version: "1" | "2" = "2"): SnsEnvelope {
  const full = { ...msg, SignatureVersion: version, SigningCertURL: "https://sns.us-east-1.amazonaws.com/c.pem" };
  const signer = createSign(version === "2" ? "RSA-SHA256" : "RSA-SHA1");
  signer.update(snsStringToSign(full), "utf8");
  return { ...full, Signature: signer.sign(privateKeyPem, "base64") };
}

// The certificate fetch, injected. Records how often it is called so the cache
// can be asserted rather than assumed.
let fetches = 0;
const certFetch = async (url: string) => {
  fetches++;
  return {
    ok: true,
    status: 200,
    headers: {},
    text: async () => certPem,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
};

const notification = (over: Partial<SnsEnvelope> = {}): SnsEnvelope => ({
  Type: "Notification",
  MessageId: "m-1",
  TopicArn: "arn:aws:sns:us-east-1:1234:adw-ses-feedback",
  Message: JSON.stringify({ notificationType: "Bounce" }),
  Timestamp: "2026-08-16T10:00:00.000Z",
  ...over,
});

beforeEach(() => {
  clearCertCache();
  fetches = 0;
});

describe("the string SNS actually signs", () => {
  it("⛔ skips an absent field rather than emitting it empty", () => {
    // Subject is optional on a Notification. Emitting "Subject\n\n" for a
    // message that had none produces a different string and a verification
    // failure on perfectly good traffic — which looks exactly like an attack.
    const withOut = snsStringToSign(notification());
    expect(withOut).not.toContain("Subject");
    const withSubject = snsStringToSign(notification({ Subject: "hi" }));
    expect(withSubject).toContain("Subject\nhi\n");
  });

  it("emits the fields in the order Amazon specifies", () => {
    const s = snsStringToSign(notification({ Subject: "hi" }));
    expect(s.indexOf("Message\n")).toBeLessThan(s.indexOf("MessageId\n"));
    expect(s.indexOf("Timestamp\n")).toBeLessThan(s.indexOf("TopicArn\n"));
    expect(s.indexOf("TopicArn\n")).toBeLessThan(s.indexOf("Type\n"));
  });

  it("refuses a message type it does not know how to canonicalise", () => {
    expect(() => snsStringToSign({ Type: "SomethingNew" })).toThrow(/unknown SNS message type/);
  });
});

describe("⛔ the certificate URL is attacker-controlled input", () => {
  // This is the whole security problem with the SNS scheme: the algorithm tells
  // you to fetch the verification key from a URL inside the untrusted message.
  // Without an allowlist an attacker signs their own bounce with their own key,
  // points SigningCertURL at their own server, passes verification, and
  // suppresses any contact they like.
  it("refuses a certificate host that is not Amazon's", async () => {
    expect(() => assertSigningUrl("https://sns.evil.example/c.pem")).toThrow(/not an SNS certificate host/);
    const forged = signSns(notification());
    const verdict = await verifySns(
      { ...forged, SigningCertURL: "https://sns.evil.example/c.pem" },
      { fetchImpl: certFetch },
    );
    expect(verdict.ok).toBe(false);
    expect(fetches, "must not even fetch from a disallowed host").toBe(0);
  });

  it("refuses a lookalike host and a plain-http host", () => {
    expect(() => assertSigningUrl("https://sns.us-east-1.amazonaws.com.evil.example/c")).toThrow();
    expect(() => assertSigningUrl("https://notsns.us-east-1.amazonaws.com/c")).toThrow();
    expect(() => assertSigningUrl("http://sns.us-east-1.amazonaws.com/c")).toThrow(/not https/);
  });
});

describe("SNS notifications", () => {
  it("accepts a v2 signature Amazon would produce", async () => {
    expect(await verifySns(signSns(notification()), { fetchImpl: certFetch })).toEqual({ ok: true, kind: "event" });
  });

  it("accepts v1, which is still live in the wild", async () => {
    expect(await verifySns(signSns(notification(), "1"), { fetchImpl: certFetch })).toEqual({ ok: true, kind: "event" });
  });

  it("rejects a message whose body was edited after signing", async () => {
    const signed = signSns(notification());
    const tampered = { ...signed, Message: JSON.stringify({ notificationType: "Complaint" }) };
    expect((await verifySns(tampered, { fetchImpl: certFetch })).ok).toBe(false);
  });

  it("rejects an unsigned message rather than treating it as unauthenticated-but-fine", async () => {
    const v = await verifySns(notification(), { fetchImpl: certFetch });
    expect(v).toEqual({ ok: false, reason: "SNS message is unsigned" });
  });

  it("⛔ rejects a validly signed message from someone else's topic", async () => {
    // A real signature from a topic that is not ours is still a real signature.
    const v = await verifySns(signSns(notification()), {
      fetchImpl: certFetch,
      allowedTopicArns: ["arn:aws:sns:us-east-1:9999:someone-else"],
    });
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/is not one of ours/);
  });

  it("caches the certificate so a bounce storm is not a fetch storm", async () => {
    const signed = signSns(notification());
    await verifySns(signed, { fetchImpl: certFetch });
    await verifySns(signed, { fetchImpl: certFetch });
    await verifySns(signed, { fetchImpl: certFetch });
    expect(fetches).toBe(1);
  });
});

describe("SNS subscription confirmation", () => {
  // ⛔ Without this branch the subscription is never confirmed, so no bounce is
  // ever delivered — and nothing anywhere reports an error. Silence is the
  // failure mode.
  const confirmation = (over: Partial<SnsEnvelope> = {}): SnsEnvelope => ({
    Type: "SubscriptionConfirmation",
    MessageId: "m-2",
    TopicArn: "arn:aws:sns:us-east-1:1234:adw-ses-feedback",
    Message: "You have chosen to subscribe",
    Token: "tok",
    SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
    Timestamp: "2026-08-16T10:00:00.000Z",
    ...over,
  });

  it("returns the URL to confirm, not merely 'valid'", async () => {
    const v = await verifySns(signSns(confirmation()), { fetchImpl: certFetch });
    expect(v).toEqual({
      ok: true,
      kind: "subscription_confirmation",
      subscribeUrl: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
    });
  });

  it("⛔ refuses a confirmation pointing anywhere but Amazon", async () => {
    // Confirming is what wires a topic to this endpoint permanently, so the
    // URL gets the same allowlist as the certificate.
    const v = await verifySns(signSns(confirmation({ SubscribeURL: "https://evil.example/confirm" })), {
      fetchImpl: certFetch,
    });
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/not an SNS host/);
  });
});

describe("Stripe signatures", () => {
  const secret = "whsec_test";
  const raw = JSON.stringify({ id: "evt_1", type: "invoice.payment_failed" });
  const sign = (ts: number) => `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}`;

  it("accepts a current signature", () => {
    expect(verifyStripe(raw, sign(1_000_000), secret, 1_000_000)).toEqual({ ok: true, kind: "event" });
  });

  it("⛔ refuses a replayed request outside the tolerance window", () => {
    // The timestamp is inside the signed payload, which is the entire reason it
    // is signed rather than merely sent — a captured body cannot be re-dated.
    const v = verifyStripe(raw, sign(1_000_000), secret, 1_000_000 + 400);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/outside tolerance/);
  });

  it("accepts either signature during a secret rotation", () => {
    const ts = 1_000_000;
    const good = createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
    expect(verifyStripe(raw, `t=${ts},v1=deadbeef,v1=${good}`, secret, ts).ok).toBe(true);
  });

  it("rejects a body edited after signing", () => {
    const ts = 1_000_000;
    expect(verifyStripe(`${raw} `, sign(ts), secret, ts).ok).toBe(false);
  });

  it("rejects a malformed header rather than parsing what it can", () => {
    expect(verifyStripe(raw, "garbage", secret, 1_000_000).ok).toBe(false);
    expect(verifyStripe(raw, "t=notanumber,v1=abc", secret, 1_000_000).ok).toBe(false);
  });
});

describe("the shared secret, which is only for our own simulators", () => {
  it("round-trips", () => {
    const raw = '{"id":"evt_1"}';
    const sig = "sha256=" + createHmac("sha256", "s").update(raw).digest("hex");
    expect(verifySharedSecret(raw, sig, "s")).toEqual({ ok: true, kind: "event" });
    expect(verifySharedSecret(raw, sig, "other").ok).toBe(false);
  });

  it("rejects an empty signature instead of comparing empty to empty", () => {
    expect(verifySharedSecret("{}", "", "s").ok).toBe(false);
  });
});

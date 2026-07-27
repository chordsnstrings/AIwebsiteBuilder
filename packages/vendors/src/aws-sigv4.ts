// Hand-rolled AWS Signature Version 4. Shared by the R2 object store (service
// "s3", region "auto") and the SES v2 email transport (service "ses"). There is
// no AWS SDK in this repo on purpose: SigV4 is ~60 lines of HMAC and pulling a
// multi-megabyte dependency tree to produce one Authorization header is a worse
// trade than owning the algorithm.
//
// The signer is a PURE FUNCTION of (request, credentials, instant). It performs
// no I/O and reads no clock unless you omit `now`, which is what makes it
// testable: the same request signed at the same instant always yields the same
// signature, and changing one byte of the body changes it.
//
// Reference: AWS "Signature Version 4 signing process" — canonical request,
// string to sign, signing key, Authorization header.
import { createHash, createHmac } from "node:crypto";
import { rfc3986 } from "./http.ts";

const ALGORITHM = "AWS4-HMAC-SHA256";

/** Payload hash sentinel accepted by S3-compatible stores for streamed bodies. */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** STS session token, when the caller runs on temporary credentials. */
  sessionToken?: string;
}

export interface SigV4Request {
  method: string;
  /** Absolute URL including any query string. */
  url: string;
  region: string;
  /** AWS service name, e.g. "s3" or "ses". */
  service: string;
  /** Headers to sign, on top of the mandatory host/x-amz-date pair. */
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /**
   * Pre-computed payload hash. Pass {@link UNSIGNED_PAYLOAD} for large or
   * streamed bodies; omit to hash `body` (empty string hashes the empty body).
   */
  payloadHash?: string;
  /** Signing instant. Defaults to `new Date()`; tests pin it. */
  now?: Date;
}

export interface SignedRequest {
  /** Every signed header, including `host` (see {@link withoutHostHeader}). */
  headers: Record<string, string>;
  authorization: string;
  signature: string;
  amzDate: string;
  credentialScope: string;
  /** Retained for debugging a signature mismatch — the usual culprit. */
  canonicalRequest: string;
  stringToSign: string;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** "20260727T072500Z" and its "20260727" date stamp. */
function amzTimestamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Canonical URI. S3 (and R2) sign the path encoded exactly once; every other
 * service double-encodes. The paths this repo signs contain no reserved
 * characters, but the distinction is kept so an object key with a space or a
 * "+" in it still signs correctly against R2.
 */
function canonicalUri(pathname: string, service: string): string {
  if (pathname === "") return "/";
  const encodeOnce = (segment: string): string => rfc3986(decodeURIComponent(segment));
  return pathname
    .split("/")
    .map((segment) => {
      const once = encodeOnce(segment);
      return service === "s3" ? once : rfc3986(once);
    })
    .join("/");
}

/** Query parameters sorted by name then value, each component RFC 3986 encoded. */
function canonicalQuery(search: URLSearchParams): string {
  const pairs: [string, string][] = [];
  search.forEach((value, key) => pairs.push([rfc3986(key), rfc3986(value)]));
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * Sign a request. Returns the headers to send plus the intermediate canonical
 * strings, which are the only useful evidence when a vendor answers 403.
 */
export function signRequestV4(req: SigV4Request, creds: SigV4Credentials): SignedRequest {
  const url = new URL(req.url);
  const { amzDate, dateStamp } = amzTimestamps(req.now ?? new Date());
  const body = req.body ?? "";
  const payloadHash = req.payloadHash ?? sha256Hex(body);

  // Host and x-amz-date are always signed. x-amz-content-sha256 is mandatory for
  // S3-compatible endpoints (R2) and is added only there, so signatures for
  // other services match the canonical AWS test vectors exactly.
  const headers: Record<string, string> = {
    ...(req.headers ?? {}),
    host: url.host,
    "x-amz-date": amzDate,
  };
  if (req.service === "s3" || req.payloadHash !== undefined) {
    headers["x-amz-content-sha256"] = payloadHash;
  }
  if (creds.sessionToken !== undefined) headers["x-amz-security-token"] = creds.sessionToken;

  const names = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    lower[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  const canonicalHeaders = names.map((n) => `${n}:${lower[n] ?? ""}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri(url.pathname, req.service),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  // Signing key: HMAC chain over date → region → service → "aws4_request".
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, req.region);
  const kService = hmac(kRegion, req.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `${ALGORITHM} Credential=${creds.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: { ...headers, authorization },
    authorization,
    signature,
    amzDate,
    credentialScope,
    canonicalRequest,
    stringToSign,
  };
}

/**
 * Drop `host` before handing headers to fetch. `host` MUST be signed but is a
 * forbidden request header for fetch, which sets it from the URL itself.
 */
export function withoutHostHeader(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "host") out[name] = value;
  }
  return out;
}

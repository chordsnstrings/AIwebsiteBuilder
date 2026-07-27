// The injectable HTTP seam every REAL vendor adapter calls through. Real
// adapters must be testable without a network, so each one takes an optional
// `fetchImpl` in its config and defaults to global fetch. The types below are
// deliberately narrower than the DOM `fetch` signature: a test double only has
// to produce `{ ok, status, headers, text(), arrayBuffer() }`, while the real
// `Response` satisfies the same shape structurally.
//
// Nothing here parses JSON for you. Adapters read `text()` and parse, because
// the raw body is also what goes into the thrown error message — a vendor
// failure that loses the vendor's own explanation is a failure you cannot debug.

export interface HttpHeaders {
  get(name: string): string | null;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: HttpHeaders;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

/** Global fetch, narrowed to {@link FetchLike}. The default for every adapter. */
export const globalFetch: FetchLike = (url, init) =>
  fetch(url, init as RequestInit) as unknown as Promise<HttpResponse>;

/**
 * Read a response body once and hand back both the text and the parsed JSON.
 * A body that is not JSON yields `undefined` rather than throwing, so the
 * caller can still surface the raw text in an error.
 */
export async function readBody(res: HttpResponse): Promise<{ text: string; json: unknown }> {
  const text = await res.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { text, json };
}

/**
 * The uniform failure shape for every real adapter: vendor id, HTTP status and
 * the vendor's own body. Mirrors the `throw new Error(\`google ${res.status}:
 * ${await res.text()}\`)` line the LLM adapters already use.
 */
export class VendorHttpError extends Error {
  readonly vendorId: string;
  readonly status: number;
  readonly body: string;

  constructor(vendorId: string, status: number, body: string) {
    super(`${vendorId} ${status}: ${body}`);
    this.name = "VendorHttpError";
    this.vendorId = vendorId;
    this.status = status;
    this.body = body;
  }
}

/** Throw {@link VendorHttpError} for any non-2xx response, echoing the body. */
export async function assertOk(vendorId: string, res: HttpResponse): Promise<void> {
  if (res.ok) return;
  throw new VendorHttpError(vendorId, res.status, await res.text());
}

/** Percent-encode per RFC 3986 (fetch/`encodeURIComponent` leaves !*'() alone). */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode a flat record as an `application/x-www-form-urlencoded` body. */
export function formEncode(fields: Record<string, string | number | undefined>): string {
  return Object.entries(fields)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(String(v))}`)
    .join("&");
}

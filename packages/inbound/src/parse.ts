// Parsing a received email into the few fields anything downstream needs.
//
// This is deliberately a small hand-rolled parser rather than a MIME library.
// What is needed is narrow — headers, one text body, and the threading ids —
// and the failure mode of a general MIME parser on hostile input is a much
// larger surface than the failure mode of not having one. Anything it cannot
// parse degrades to "the raw text", which a human can still read.

/** Header names are case-insensitive; values are unfolded. */
export type Headers = Record<string, string>;

export interface ParsedEmail {
  headers: Headers;
  from: string;
  to: string[];
  subject: string;
  /** Body with quoted history and signature removed — what the person wrote. */
  text: string;
  /** Full decoded body, kept because a stripped body can lose the whole reply
   *  when someone top-quotes in an unusual client. */
  rawText: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
}

/** Unfold continuation lines and split the header block from the body. */
export function splitMime(raw: string): { headerBlock: string; body: string } {
  const normalised = raw.replace(/\r\n/g, "\n");
  const idx = normalised.indexOf("\n\n");
  if (idx < 0) return { headerBlock: normalised, body: "" };
  return { headerBlock: normalised.slice(0, idx), body: normalised.slice(idx + 2) };
}

export function parseHeaders(headerBlock: string): Headers {
  const out: Headers = {};
  // RFC 5322 folding: a line beginning with whitespace continues the previous.
  const unfolded = headerBlock.replace(/\n[ \t]+/g, " ");
  for (const line of unfolded.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    // A repeated header (Received, References) keeps the FIRST occurrence for
    // identity headers and joins for the rest; the only repeated header we read
    // is References, and joining is correct there.
    out[name] = out[name] === undefined ? value : `${out[name]} ${value}`;
  }
  return out;
}

/** `Display Name <a@b.com>` → `a@b.com`. Bare addresses pass through. */
export function extractAddress(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  const candidate = (angled?.[1] ?? value).trim();
  return candidate.replace(/^mailto:/i, "").toLowerCase();
}

export function extractAddresses(value: string): string[] {
  // Split on commas that are not inside quotes or angle brackets. The simple
  // split is adequate here because display names containing commas are quoted,
  // and a mis-split still yields an address the regex can recover.
  return value
    .split(",")
    .map((p) => extractAddress(p))
    .filter((a) => a.includes("@"));
}

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Pull the best text body out of a message.
 *
 * ⛔ Prefer `text/plain`. An HTML-only reply is stripped to text rather than
 * dropped, because dropping it would silently discard a real human reply — and
 * a reply we cannot read is indistinguishable, downstream, from a reply that
 * never came.
 */
export function extractBody(headers: Headers, body: string): string {
  const contentType = headers["content-type"] ?? "text/plain";
  const boundaryMatch = /boundary="?([^";\s]+)"?/i.exec(contentType);

  if (boundaryMatch?.[1] !== undefined) {
    const boundary = `--${boundaryMatch[1]}`;
    const parts = body.split(boundary).slice(1, -1);
    const decoded = parts.map((part) => {
      const { headerBlock, body: partBody } = splitMime(part.replace(/^\n/, ""));
      const partHeaders = parseHeaders(headerBlock);
      return { headers: partHeaders, text: decodePart(partHeaders, partBody) };
    });
    const plain = decoded.find((p) => (p.headers["content-type"] ?? "").includes("text/plain"));
    if (plain !== undefined) return plain.text;
    const html = decoded.find((p) => (p.headers["content-type"] ?? "").includes("text/html"));
    if (html !== undefined) return stripHtml(html.text);
    // Nested multipart (multipart/alternative inside multipart/mixed) — recurse
    // once into the first part rather than returning the MIME scaffolding.
    const nested = decoded.find((p) => (p.headers["content-type"] ?? "").includes("multipart/"));
    if (nested !== undefined) return extractBody(nested.headers, nested.text);
    return decoded[0]?.text ?? "";
  }

  const text = decodePart(headers, body);
  return contentType.includes("text/html") ? stripHtml(text) : text;
}

function decodePart(headers: Headers, body: string): string {
  const encoding = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  if (encoding === "base64") {
    try {
      return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return body;
    }
  }
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

/** Lines that begin a quoted history block, across the common clients. */
const QUOTE_STARTERS: RegExp[] = [
  /^On .{5,120}\bwrote:\s*$/i,
  /^On .{5,120}\bat\b.{3,60},.{0,80}\bwrote:\s*$/i,
  /^-+\s*Original Message\s*-+$/i,
  /^-+\s*Forwarded message\s*-+$/i,
  /^From:\s+.+$/i,
  /^_{10,}$/,
  /^Sent from my \w+/i,
  /^Le .{5,120}\ba écrit\s*:\s*$/i,
];

/**
 * Remove quoted history and the signature block.
 *
 * ⛔ Never return empty when the input was not empty. A reply consisting only
 * of "Yes please" under a top-quote is the most valuable message in the system,
 * and an over-eager stripper that returns "" would have it read as silence.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (QUOTE_STARTERS.some((re) => re.test(line.trim()))) break;
    // `-- ` on its own line is the RFC 3676 signature separator.
    if (line.trimEnd() === "--") break;
    if (line.startsWith(">")) continue;
    kept.push(line);
  }
  const stripped = kept.join("\n").trim();
  return stripped.length > 0 ? stripped : text.trim();
}

export function parseEmail(raw: string): ParsedEmail {
  const { headerBlock, body } = splitMime(raw);
  const headers = parseHeaders(headerBlock);
  const rawText = extractBody(headers, body);
  const references = (headers["references"] ?? "")
    .split(/\s+/)
    .map((r) => r.trim())
    .filter((r) => r.startsWith("<") && r.endsWith(">"));
  const inReplyTo = headers["in-reply-to"]?.trim();
  const messageId = headers["message-id"]?.trim();
  return {
    headers,
    from: extractAddress(headers["from"] ?? ""),
    to: extractAddresses(headers["to"] ?? ""),
    subject: headers["subject"] ?? "",
    text: stripQuoted(rawText),
    rawText,
    ...(messageId === undefined ? {} : { messageId }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    references,
  };
}

// What a file actually IS.
//
// ⛔ Magic numbers, never the extension and never the Content-Type header. Both
// of those are supplied by whoever is uploading, and "trust the client about
// what kind of file this is" is the first line of most file-upload CVEs. A
// polyglot that is a valid GIF and a valid HTML document is a stored-XSS
// payload if the extension decides how it is served.
//
// The allowlist is short on purpose. A business needs to send photographs and
// documents; it does not need to send an archive, an executable, an SVG (which
// is a script container), or an Office macro format. Every type added here is a
// new parser somebody's browser will run against a stranger's file.

export interface Sniffed {
  mime: string;
  /** Extension we would give it, ignoring whatever it was called. */
  ext: string;
  kind: "photo" | "document";
}

interface Signature {
  mime: string;
  ext: string;
  kind: "photo" | "document";
  /** Byte prefix, with `null` for "any byte here". */
  magic: (number | null)[];
  offset?: number;
}

const SIGNATURES: Signature[] = [
  { mime: "image/jpeg", ext: "jpg", kind: "photo", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/png", ext: "png", kind: "photo", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/gif", ext: "gif", kind: "photo", magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp", ext: "webp", kind: "photo", magic: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
  // HEIC/HEIF — what an iPhone actually produces, and the format most upload
  // handlers forget until a customer's photograph silently fails.
  { mime: "image/heic", ext: "heic", kind: "photo", magic: [null, null, null, null, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63] },
  { mime: "image/heif", ext: "heif", kind: "photo", magic: [null, null, null, null, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31] },
  { mime: "application/pdf", ext: "pdf", kind: "document", magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

/**
 * ⛔ Formats we refuse BY NAME, so the refusal message can say why.
 *
 * They are not merely absent from the allowlist — a bare "unsupported file
 * type" for a .docx makes a customer try four times and then telephone. And
 * refusing an SVG needs an explanation: it looks like an image and is a script
 * container, which is not obvious to the person sending their logo.
 */
const NAMED_REFUSALS: { magic: (number | null)[]; why: string }[] = [
  { magic: [0x50, 0x4b, 0x03, 0x04], why: "a zip-based file (docx, xlsx, pptx, or an archive). Send a PDF or a photograph instead." },
  { magic: [0x3c, 0x3f, 0x78, 0x6d, 0x6c], why: "XML — and an SVG is a script container, not a picture. Send a PNG or a JPEG." },
  { magic: [0x3c, 0x73, 0x76, 0x67], why: "an SVG, which can carry scripts. Send a PNG or a JPEG." },
  { magic: [0x4d, 0x5a], why: "a Windows executable." },
  { magic: [0x7f, 0x45, 0x4c, 0x46], why: "a Linux executable." },
  { magic: [0xd0, 0xcf, 0x11, 0xe0], why: "a legacy Office file, which can carry macros. Send a PDF." },
  { magic: [0x52, 0x61, 0x72, 0x21], why: "a RAR archive." },
  { magic: [0x1f, 0x8b], why: "a gzip archive." },
];

function matches(buf: Buffer, magic: (number | null)[], offset = 0): boolean {
  if (buf.length < offset + magic.length) return false;
  return magic.every((b, i) => b === null || buf[offset + i] === b);
}

export class UnsupportedUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedUploadError";
  }
}

/**
 * Identify a file from its first bytes, or refuse it.
 *
 * ⛔ Throws rather than returning null so no caller can accidentally treat an
 * unidentified file as a default type. "It's probably a jpeg" is how a payload
 * gets stored with an image extension.
 */
export function sniff(buf: Buffer): Sniffed {
  for (const s of SIGNATURES) {
    if (matches(buf, s.magic, s.offset ?? 0)) return { mime: s.mime, ext: s.ext, kind: s.kind };
  }
  for (const r of NAMED_REFUSALS) {
    if (matches(buf, r.magic)) throw new UnsupportedUploadError(`That looks like ${r.why}`);
  }
  // ⛔ Explicitly check for markup anywhere near the start. A file that begins
  // with whitespace and then `<html` is served as HTML by several CDNs whatever
  // the stored content type says.
  const head = buf.subarray(0, 256).toString("latin1").trim().toLowerCase();
  if (head.startsWith("<") || head.startsWith("<!doctype")) {
    throw new UnsupportedUploadError("That looks like a web page rather than a photograph or a document.");
  }
  throw new UnsupportedUploadError(
    "We can accept photographs (JPEG, PNG, WEBP, HEIC) and PDF documents. That file is neither.",
  );
}

/** Per-kind size ceilings. A modern phone photo is 3–8MB; a scanned pack is bigger. */
export const MAX_BYTES: Record<Sniffed["kind"], number> = {
  photo: 25 * 1024 * 1024,
  document: 40 * 1024 * 1024,
};

/**
 * ⛔ Zero-length and truncated files are refused, not stored.
 *
 * A zero-byte upload is a failed transfer that the sender believes succeeded,
 * and marking the requirement "received" for one means the pack completes with
 * nothing in it — a document request that closes empty is worse than one that
 * stays open.
 */
export function assertUploadable(buf: Buffer, sniffed: Sniffed): void {
  if (buf.length === 0) throw new UnsupportedUploadError("That file arrived empty — the upload did not finish.");
  if (buf.length < 64) throw new UnsupportedUploadError("That file is too small to be a real photograph or document.");
  const cap = MAX_BYTES[sniffed.kind];
  if (buf.length > cap) {
    throw new UnsupportedUploadError(
      `That file is ${Math.round(buf.length / 1024 / 1024)}MB; the limit is ${Math.round(cap / 1024 / 1024)}MB.`,
    );
  }
}

import { createHash } from "node:crypto";

// Pack and pair identifiers are derived from workflow state, never from a RNG
// or the clock. Rebuilding the same pack from the same KB version must produce
// the same rows, or every retry doubles the pack — the IDEMPOTENCY line of
// HANDOVER A4→A5 is sha256(businessId | 'qapack' | kb_version) precisely so a
// re-run is a no-op instead of a second pack.
function uuidFrom(parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join("|")).digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  // Version 8 (RFC 9562, custom): this is a sha256 name-based UUID, not the
  // sha1 v5 the version nibble would otherwise claim. Say what it is.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable UUID for a pack built from this business at this KB version. */
export function packId(businessId: string, kbVersion: number): string {
  return uuidFrom([businessId, "qapack", String(kbVersion)]);
}

/**
 * Stable UUID for a pair. Keyed on the normalised question, so re-generating
 * after a fact changes updates the answer in place rather than orphaning the
 * previous pair — and so a pair id survives an owner editing whitespace.
 */
export function pairId(pack: string, question: string): string {
  return uuidFrom([pack, "pair", question.toLowerCase().replace(/\s+/g, " ").trim()]);
}

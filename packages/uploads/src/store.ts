// Accepting a file, and getting it back out again.
//
// ⛔ The threat model is not "someone uploads a virus". It is "someone else can
// read this". A KYC pack is a passport scan; a claims pack is somebody's house
// on the worst day of their year. So:
//
//   • keys are content-addressed and unguessable — a key that encodes a
//     customer id and a filename is an enumeration attack against other
//     people's identity documents;
//   • nothing is readable while the scan is pending;
//   • every read is logged, append-only, before the bytes are handed over;
//   • every upload has a retention date from the moment it lands.

import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import type { ObjectStore } from "@adw/vendors";
import { assertUploadable, sniff, UnsupportedUploadError, type Sniffed } from "./sniff.ts";

/** How long an upload lives unless something extends it. */
export const DEFAULT_RETENTION_DAYS = 365;

export interface AcceptInput {
  bytes: Buffer;
  declaredName: string;
  customerId?: string | undefined;
  businessId?: string | undefined;
  sessionId?: string | undefined;
  uploadedBy?: string | undefined;
  retentionDays?: number | undefined;
}

export interface AcceptedUpload {
  id: string;
  storageKey: string;
  mime: string;
  kind: Sniffed["kind"];
  bytes: number;
  sha256: string;
  scanStatus: string;
  /** True when this exact content was already stored for this customer. */
  deduplicated: boolean;
}

export interface UploadDeps {
  db: Db;
  store: ObjectStore;
  /** Absent means scanning is unavailable — see `scanStatus` below. */
  scan?: (bytes: Buffer) => Promise<{ clean: boolean; detail?: string }>;
  now?: () => Date;
}

/**
 * The storage key.
 *
 * ⛔ Content hash plus 16 random bytes, and nothing about the customer. Two
 * customers uploading the same document get different keys (the random half),
 * and nobody can walk the bucket by guessing (also the random half). The hash
 * half is only there to make a key self-describing in a log.
 */
export function mintStorageKey(sha256: string, ext: string): string {
  return `uploads/${sha256.slice(0, 8)}/${randomBytes(16).toString("hex")}.${ext}`;
}

export async function acceptUpload(input: AcceptInput, deps: UploadDeps): Promise<AcceptedUpload> {
  const now = deps.now?.() ?? new Date();
  // Identify FIRST. Nothing is written, hashed or stored before we know what it
  // is — a refused file should never have touched the bucket.
  const sniffed = sniff(input.bytes);
  assertUploadable(input.bytes, sniffed);

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");

  // Same bytes, same customer, still live → reuse. A customer who taps upload
  // twice has not sent two documents, and two rows means the pack shows one
  // item received twice and another still outstanding.
  const existing = await deps.db.maybeOne<{ id: string; storage_key: string; scan_status: string }>(
    `SELECT id, storage_key, scan_status FROM uploads
      WHERE sha256 = $1 AND deleted_at IS NULL
        AND customer_id IS NOT DISTINCT FROM $2
      ORDER BY created_at DESC LIMIT 1`,
    [sha256, input.customerId ?? null],
  );
  if (existing !== null) {
    return {
      id: existing.id,
      storageKey: existing.storage_key,
      mime: sniffed.mime,
      kind: sniffed.kind,
      bytes: input.bytes.length,
      sha256,
      scanStatus: existing.scan_status,
      deduplicated: true,
    };
  }

  // ⛔ Scan BEFORE the bytes reach the bucket, and refuse outright on a hit. A
  // stored-then-quarantined file is a file that existed at a readable key for
  // however long the quarantine took.
  let scanStatus = "pending";
  if (deps.scan !== undefined) {
    const verdict = await deps.scan(input.bytes);
    if (!verdict.clean) {
      await emit({
        eventType: "upload.rejected",
        subject: { kind: "customer", id: input.customerId ?? "unknown" },
        payload: { reason: "scan_failed", detail: verdict.detail ?? "infected", sha256: sha256.slice(0, 16) },
      });
      throw new UnsupportedUploadError("That file did not pass a security scan and has not been stored.");
    }
    scanStatus = "clean";
  } else {
    // ⛔ Honest. No scanner configured means `skipped`, not `clean` — and the
    // download path refuses anything not `clean`, so an unconfigured scanner
    // fails closed instead of waving everything through.
    scanStatus = "skipped";
  }

  const storageKey = mintStorageKey(sha256, sniffed.ext);
  await deps.store.put(storageKey, input.bytes);

  const retainDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const row = await deps.db.one<{ id: string }>(
    `INSERT INTO uploads
       (customer_id, business_id, session_id, storage_key, detected_mime, declared_name,
        byte_size, sha256, scan_status, scanned_at, kind, uploaded_by, retain_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      input.customerId ?? null,
      input.businessId ?? null,
      input.sessionId ?? null,
      storageKey,
      sniffed.mime,
      // ⛔ The name is stored for the owner to recognise it, and it is stripped
      // of path separators: a declared name of `../../etc/passwd` must never
      // reach anything that joins paths.
      input.declaredName.replace(/[/\\]/g, "_").slice(0, 200),
      input.bytes.length,
      sha256,
      scanStatus,
      deps.scan === undefined ? null : now,
      sniffed.kind,
      input.uploadedBy ?? "visitor",
      new Date(now.getTime() + retainDays * 86_400_000),
    ],
  );

  await emit({
    eventType: "upload.accepted",
    subject: { kind: "customer", id: input.customerId ?? "unknown" },
    // ⛔ Never the filename. People name files things like
    // `passport-scan-jane-smith.pdf`, and the event log is read widely.
    payload: { kind: sniffed.kind, mime: sniffed.mime, bytes: input.bytes.length, scanStatus },
  });

  return {
    id: row.id,
    storageKey,
    mime: sniffed.mime,
    kind: sniffed.kind,
    bytes: input.bytes.length,
    sha256,
    scanStatus,
    deduplicated: false,
  };
}

export class UploadAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadAccessError";
  }
}

/**
 * Read an upload back, logging the access first.
 *
 * ⛔ The log entry is written BEFORE the bytes are fetched. If the read fails
 * we have a record of an attempt, which is the direction to err in: an
 * unrecorded successful read is the one that matters in an inquiry.
 */
export async function readUpload(
  uploadId: string,
  actor: string,
  deps: Pick<UploadDeps, "db" | "store">,
): Promise<{ bytes: Buffer; mime: string; name: string }> {
  const row = await deps.db.maybeOne<{
    storage_key: string;
    detected_mime: string;
    declared_name: string;
    scan_status: string;
    deleted_at: Date | null;
  }>(
    "SELECT storage_key, detected_mime, declared_name, scan_status, deleted_at FROM uploads WHERE id = $1",
    [uploadId],
  );
  if (row === null) throw new UploadAccessError("No such upload");
  if (row.deleted_at !== null) throw new UploadAccessError("That upload has been deleted");
  // ⛔ Fails closed. Only `clean` is served — `pending` and `skipped` are not.
  if (row.scan_status !== "clean") {
    throw new UploadAccessError(`That upload is not available (scan status: ${row.scan_status})`);
  }

  await deps.db.query(
    "INSERT INTO upload_access_log (upload_id, actor, action) VALUES ($1,$2,'download')",
    [uploadId, actor],
  );
  const bytes = await deps.store.get(row.storage_key);
  if (bytes === null) throw new UploadAccessError("The stored object is missing");
  return { bytes, mime: row.detected_mime, name: row.declared_name };
}

/**
 * Delete what is past its retention date.
 *
 * ⛔ The row is kept and tombstoned; only the BYTES go. `uploads` is joined
 * from `document_items`, and hard-deleting the row would make a completed pack
 * look as though the item was never received — losing the evidence that we
 * collected it and the evidence that we disposed of it on time.
 */
export async function purgeExpired(deps: Pick<UploadDeps, "db" | "store"> & { now?: () => Date }): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const due = await deps.db.query<{ id: string; storage_key: string }>(
    "SELECT id, storage_key FROM uploads WHERE deleted_at IS NULL AND retain_until <= $1 LIMIT 500",
    [now],
  );
  let purged = 0;
  for (const row of due.rows) {
    await deps.store.delete(row.storage_key).catch(() => false);
    await deps.db.query("UPDATE uploads SET deleted_at = $2 WHERE id = $1", [row.id, now]);
    await deps.db.query(
      "INSERT INTO upload_access_log (upload_id, actor, action, detail) VALUES ($1,'system','deleted','retention expired')",
      [row.id],
    );
    purged++;
  }
  return purged;
}

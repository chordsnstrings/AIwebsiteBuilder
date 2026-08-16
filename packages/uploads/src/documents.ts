// Document requests: what we need, what has arrived, and when to ask again.
//
// ⛔ The clerk COLLECTS. It does not judge. The catalogue says so about nearly
// every one of the 100 units in this family — "collects and tracks on schedule;
// performs no assessment" — and the type system says it here: an item is
// `outstanding` or `received`, and there is no third value. Not `valid`, not
// `approved`, not `sufficient`.
//
// That is not timidity. Deciding whether an insurance certificate is genuine,
// current and adequate for the work is the professional judgement the customer
// is licensed and insured for. A clerk that grades it has quietly moved that
// liability onto us, and the first time it grades one wrong is the first time
// anybody notices it was grading at all.

import { config } from "@adw/config";
import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { primaryArchetype } from "@adw/taxonomy";

export interface PackItem {
  key: string;
  label: string;
  mandatory: boolean;
  /** Identity documents outlive the job. Overrides the upload default. */
  retentionDays?: number;
}

export interface DocumentPack {
  id: string;
  label: string;
  items: PackItem[];
}

interface RawItem {
  key?: string;
  label?: string;
  mandatory?: boolean;
  retention_days?: number;
}
interface RawPack {
  id?: string;
  label?: string;
  items?: RawItem[];
}

let cached: { version: string; data: Record<string, unknown> } | null = null;
function packsConfig(): { version: string; data: Record<string, unknown> } {
  if (cached === null) {
    const { data, version } = config.documentPacks();
    cached = { version, data: data as Record<string, unknown> };
  }
  return cached;
}
export function clearPackCache(): void {
  cached = null;
}

function toPack(raw: RawPack): DocumentPack {
  return {
    id: raw.id ?? "",
    label: raw.label ?? raw.id ?? "",
    items: (raw.items ?? []).map((i) => ({
      key: i.key ?? "",
      label: i.label ?? i.key ?? "",
      mandatory: i.mandatory !== false,
      ...(i.retention_days === undefined ? {} : { retentionDays: i.retention_days }),
    })),
  };
}

/**
 * The packs a trade uses.
 *
 * Per-trade OVERRIDES the archetype rather than adding to it — a vet's boarding
 * pack replaces the generic clinical intake, it does not arrive alongside it,
 * and asking a customer for two overlapping sets of documents is how a pack
 * never completes.
 */
export function packsFor(vertical: string): DocumentPack[] {
  const cfg = packsConfig().data;
  const byTrade = (cfg["trade_packs"] ?? {}) as Record<string, RawPack[]>;
  const own = byTrade[vertical];
  if (own !== undefined) return own.map(toPack);

  const code = primaryArchetype(vertical);
  const byArchetype = (cfg["archetype_packs"] ?? {}) as Record<string, RawPack[]>;
  const shared = code === undefined ? undefined : byArchetype[code];
  return (shared ?? []).map(toPack).filter((p) => p.items.length > 0);
}

export function packById(vertical: string, packId: string): DocumentPack | undefined {
  return packsFor(vertical).find((p) => p.id === packId);
}

function chaseSchedule(): number[] {
  return (packsConfig().data["chase_schedule"] as number[] | undefined) ?? [24, 72, 168];
}
export function maxChases(): number {
  return (packsConfig().data["max_chases"] as number | undefined) ?? 4;
}

export interface OpenRequestInput {
  customerId: string;
  subjectRef: string;
  vertical: string;
  packId: string;
}

export interface DocumentRequestRecord {
  id: string;
  packId: string;
  label: string;
  state: string;
  outstanding: { key: string; label: string; mandatory: boolean }[];
  received: { key: string; label: string; receivedAt: Date; expiresOn: Date | null }[];
  chaseCount: number;
  nextChaseAt: Date | null;
}

export async function openRequest(db: Db, input: OpenRequestInput, now: Date = new Date()): Promise<string> {
  const pack = packById(input.vertical, input.packId);
  if (pack === undefined) {
    throw new Error(`No document pack "${input.packId}" for vertical "${input.vertical}"`);
  }
  const { version } = packsConfig();

  return db.tx(async (tx) => {
    // One open request per subject and pack. A second "we need your documents"
    // for the same job is the thing that makes people stop reading them.
    const existing = await tx.maybeOne<{ id: string }>(
      "SELECT id FROM document_requests WHERE customer_id = $1 AND subject_ref = $2 AND pack_id = $3 AND state = 'open'",
      [input.customerId, input.subjectRef, input.packId],
    );
    if (existing !== null) return existing.id;

    const first = chaseSchedule()[0] ?? 24;
    const row = await tx.one<{ id: string }>(
      `INSERT INTO document_requests (customer_id, subject_ref, pack_id, pack_version, vertical, next_chase_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.customerId, input.subjectRef, input.packId, version, input.vertical, new Date(now.getTime() + first * 3_600_000)],
    );
    for (const item of pack.items) {
      await tx.query(
        "INSERT INTO document_items (request_id, item_key, label, mandatory) VALUES ($1,$2,$3,$4)",
        [row.id, item.key, item.label, item.mandatory],
      );
    }
    return row.id;
  });
}

/**
 * Attach an upload to a requirement.
 *
 * ⛔ `expiresOn` is a date somebody READ OFF the document. It is never inferred
 * from the file, never guessed from the upload date, and it decides nothing on
 * its own — it drives a reminder. An expiry the system invented would be a
 * clerk making a judgement in the one place nobody is watching.
 */
export async function attachDocument(
  db: Db,
  requestId: string,
  itemKey: string,
  uploadId: string,
  opts: { expiresOn?: Date | undefined; note?: string | undefined } = {},
  now: Date = new Date(),
): Promise<{ attached: boolean; complete: boolean }> {
  return db.tx(async (tx) => {
    const res = await tx.query(
      `UPDATE document_items
          SET upload_id = $3, received_at = $4, expires_on = $5, note = $6
        WHERE request_id = $1 AND item_key = $2`,
      [requestId, itemKey, uploadId, now, opts.expiresOn ?? null, opts.note ?? null],
    );
    if ((res.rowCount ?? 0) === 0) return { attached: false, complete: false };

    // ⛔ Completion is MANDATORY items only. A pack that waits for optional
    // documents never completes, and the customer is chased for something they
    // were told was optional.
    const outstanding = await tx.one<{ n: string }>(
      "SELECT count(*) AS n FROM document_items WHERE request_id = $1 AND mandatory = TRUE AND received_at IS NULL",
      [requestId],
    );
    const complete = Number(outstanding.n) === 0;
    if (complete) {
      await tx.query(
        "UPDATE document_requests SET state = 'complete', completed_at = $2, next_chase_at = NULL WHERE id = $1",
        [requestId, now],
      );
    }
    return { attached: true, complete };
  });
}

export async function loadRequest(db: Db, requestId: string): Promise<DocumentRequestRecord | null> {
  const req = await db.maybeOne<{
    id: string;
    pack_id: string;
    vertical: string;
    state: string;
    chase_count: number;
    next_chase_at: Date | null;
  }>(
    "SELECT id, pack_id, vertical, state, chase_count, next_chase_at FROM document_requests WHERE id = $1",
    [requestId],
  );
  if (req === null) return null;
  const items = await db.query<{
    item_key: string;
    label: string;
    mandatory: boolean;
    received_at: Date | null;
    expires_on: Date | null;
  }>(
    "SELECT item_key, label, mandatory, received_at, expires_on FROM document_items WHERE request_id = $1 ORDER BY mandatory DESC, item_key",
    [requestId],
  );
  return {
    id: req.id,
    packId: req.pack_id,
    label: packById(req.vertical, req.pack_id)?.label ?? req.pack_id,
    state: req.state,
    chaseCount: req.chase_count,
    nextChaseAt: req.next_chase_at,
    outstanding: items.rows
      .filter((i) => i.received_at === null)
      .map((i) => ({ key: i.item_key, label: i.label, mandatory: i.mandatory })),
    received: items.rows
      .filter((i) => i.received_at !== null)
      .map((i) => ({ key: i.item_key, label: i.label, receivedAt: i.received_at!, expiresOn: i.expires_on })),
  };
}

export interface ChaseDue {
  requestId: string;
  customerId: string;
  subjectRef: string;
  packLabel: string;
  outstanding: { key: string; label: string }[];
  chaseNumber: number;
}

/**
 * Requests due a chase, and the advance of their schedule.
 *
 * ⛔ Chasing STOPS after `max_chases`. A pack that asks forever is a pack the
 * recipient marks as spam — and the damage does not stop at this customer,
 * because the next business using the same sending domain cannot reach them
 * either. The request stays open for a human; it just stops being automatic.
 */
export async function dueChases(db: Db, now: Date = new Date()): Promise<ChaseDue[]> {
  const rows = await db.query<{
    id: string;
    customer_id: string;
    subject_ref: string;
    pack_id: string;
    vertical: string;
    chase_count: number;
  }>(
    `SELECT id, customer_id, subject_ref, pack_id, vertical, chase_count
       FROM document_requests
      WHERE state = 'open' AND next_chase_at IS NOT NULL AND next_chase_at <= $1
      ORDER BY next_chase_at ASC LIMIT 200`,
    [now],
  );
  const out: ChaseDue[] = [];
  const schedule = chaseSchedule();
  for (const r of rows.rows) {
    const items = await db.query<{ item_key: string; label: string }>(
      "SELECT item_key, label FROM document_items WHERE request_id = $1 AND received_at IS NULL AND mandatory = TRUE",
      [r.id],
    );
    const next = r.chase_count + 1;
    if (next >= maxChases()) {
      await db.query("UPDATE document_requests SET next_chase_at = NULL, chase_count = $2 WHERE id = $1", [r.id, next]);
      await emit({
        eventType: "documents.chase_exhausted",
        subject: { kind: "customer", id: r.customer_id },
        payload: { requestId: r.id, packId: r.pack_id, outstanding: items.rows.length },
      });
    } else {
      const hours = schedule[Math.min(next, schedule.length - 1)] ?? 168;
      await db.query("UPDATE document_requests SET next_chase_at = $2, chase_count = $3 WHERE id = $1", [
        r.id,
        new Date(now.getTime() + hours * 3_600_000),
        next,
      ]);
    }
    if (items.rows.length > 0) {
      out.push({
        requestId: r.id,
        customerId: r.customer_id,
        subjectRef: r.subject_ref,
        packLabel: packById(r.vertical, r.pack_id)?.label ?? r.pack_id,
        outstanding: items.rows.map((i) => ({ key: i.item_key, label: i.label })),
        chaseNumber: next,
      });
    }
  }
  return out;
}

/**
 * The assembled pack — a manifest, not a verdict.
 *
 * ⛔ It reports what was collected and when. It does not say the pack is
 * "in order", "compliant" or "ready to submit", because whether it is depends
 * on rules the customer's regulator writes and we do not read.
 */
export interface PackManifest {
  requestId: string;
  packLabel: string;
  assembledAt: Date;
  complete: boolean;
  items: {
    key: string;
    label: string;
    mandatory: boolean;
    status: "received" | "outstanding";
    receivedAt?: Date;
    expiresOn?: Date;
    /** ⛔ Reported, never acted on. A human decides what an expired document means. */
    expired?: boolean;
    uploadId?: string;
    sha256?: string;
  }[];
}

export async function assemblePack(db: Db, requestId: string, now: Date = new Date()): Promise<PackManifest | null> {
  const req = await db.maybeOne<{ pack_id: string; vertical: string; state: string }>(
    "SELECT pack_id, vertical, state FROM document_requests WHERE id = $1",
    [requestId],
  );
  if (req === null) return null;
  const rows = await db.query<{
    item_key: string;
    label: string;
    mandatory: boolean;
    received_at: Date | null;
    expires_on: Date | null;
    upload_id: string | null;
    sha256: string | null;
  }>(
    `SELECT i.item_key, i.label, i.mandatory, i.received_at, i.expires_on, i.upload_id, u.sha256
       FROM document_items i LEFT JOIN uploads u ON u.id = i.upload_id
      WHERE i.request_id = $1 ORDER BY i.mandatory DESC, i.item_key`,
    [requestId],
  );
  return {
    requestId,
    packLabel: packById(req.vertical, req.pack_id)?.label ?? req.pack_id,
    assembledAt: now,
    complete: req.state === "complete",
    items: rows.rows.map((r) => ({
      key: r.item_key,
      label: r.label,
      mandatory: r.mandatory,
      status: r.received_at === null ? ("outstanding" as const) : ("received" as const),
      ...(r.received_at === null ? {} : { receivedAt: r.received_at }),
      ...(r.expires_on === null ? {} : { expiresOn: r.expires_on, expired: new Date(r.expires_on) < now }),
      ...(r.upload_id === null ? {} : { uploadId: r.upload_id }),
      ...(r.sha256 === null ? {} : { sha256: r.sha256 }),
    })),
  };
}

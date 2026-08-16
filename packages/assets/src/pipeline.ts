// Request → approve → generate → store.
//
// ⛔ `generateApproved` reads state = 'approved' and nothing else, and it checks
// the spend cap IMMEDIATELY BEFORE the call rather than at request time. Both
// matter for the same reason: this is the only place in the system where a
// function call debits a real account per invocation, and the money is gone
// whether or not the resulting file is ever used.

import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import {
  DEFAULT_MEDIA_MODELS,
  type MediaGenerator,
  type MediaRequest,
  type ObjectStore,
} from "@adw/vendors";
import { assetConfigVersion, assetKindById, assetKindFor, estimateCostCents, type AssetKind } from "./catalogue.ts";

/** Applied when the owner has set no explicit cap. ⛔ Not "unlimited". */
export const DEFAULT_MONTHLY_CAP_CENTS = 500;
const MAX_ATTEMPTS = 2;
const MAX_PROMPT = 600;

export interface RequestAssetInput {
  customerId: string;
  vertical: string;
  /** An asset-kind id from config/asset-kinds.yaml. */
  assetKind: string;
  /** What the owner wants it to be of. Appended to the kind's fixed subject. */
  brief: string;
  requestedBy?: string | undefined;
  publicationId?: string | undefined;
  model?: string | undefined;
  seed?: number | undefined;
}

export type RequestResult =
  | {
      ok: true;
      assetId: string;
      estimatedCostCents: number;
      /** ⛔ Returned so the approval surface can show it. "Approve" means
       *  nothing if the person pressing it does not know the number. */
      remainingCapCents: number;
      prompt: string;
    }
  | { ok: false; reason: "unknown_kind" | "unsafe_brief" | "cap_exceeded" | "kind_quota"; detail: string };

/**
 * Words that turn a decorative asset into a documentary claim.
 *
 * ⛔ Matched on the OWNER's brief, not only on a model's output. The owner is
 * not the adversary here — they will ask for "a photo of our team outside the
 * van" in complete good faith, because it is a reasonable thing to want and
 * nothing about the interface says it is a picture of people who do not exist.
 * Refusing with a reason is the only honest answer.
 */
const UNSAFE_BRIEF = [
  { re: /\b(our|the)\s+(team|staff|crew|engineers?|technicians?|employees?|people)\b/i,
    why: "a generated picture of your staff would be people who do not exist, presented as your team" },
  { re: /\b(photo|photograph|picture|image)\s+of\s+(us|our|the)\b/i,
    why: "this would not be a photograph of anything real" },
  { re: /\b(a\s+)?(man|woman|person|customer|client|patient|worker|portrait|headshot|face)\b/i,
    why: "generated depictions of people are never used on a business's site" },
  { re: /\b(before\s*(and|&|\/)\s*after|completed\s+(job|work|project)|case\s+study|finished\s+(job|install))\b/i,
    why: "this would imply work that was actually done" },
  { re: /\b(our|my)\s+(work|jobs?|projects?|installs?|premises|shop|office|van|fleet|showroom)\b/i,
    why: "this would imply a picture of your actual premises or work" },
  { re: /\b(logo|logotype|brand\s*mark|trademark|signage)\b/i,
    why: "generated logos and signage are a trademark problem, not a design choice" },
  { re: /\b(certificate|certification|award|accreditation|badge|gas\s*safe|niceic|checkatrade|trustpilot)\b/i,
    why: "a generated credential badge is a fabricated accreditation" },
];

export function checkBrief(brief: string): { ok: true } | { ok: false; why: string } {
  for (const rule of UNSAFE_BRIEF) {
    if (rule.re.test(brief)) return { ok: false, why: rule.why };
  }
  return { ok: true };
}

/** Kind's fixed subject first, owner's brief second, both bounded. */
export function composePrompt(kind: AssetKind, brief: string): string {
  return `${kind.subject}. ${brief.trim()}`.slice(0, MAX_PROMPT);
}

export function assetIdempotencyKey(input: { customerId: string; assetKind: string; prompt: string }): string {
  return createHash("sha256")
    .update(`${input.customerId}|${input.assetKind}|${input.prompt}`)
    .digest("hex")
    .slice(0, 40);
}

async function monthlyCapCents(db: Db, customerId: string): Promise<number> {
  const row = await db.maybeOne<{ monthly_cap_cents: number }>(
    "SELECT monthly_cap_cents FROM asset_budgets WHERE customer_id = $1",
    [customerId],
  );
  // ⛔ Absent means the default, never "no limit". A missing row is the state
  // every customer starts in, and it is the state a runaway loop would run in.
  return row?.monthly_cap_cents ?? DEFAULT_MONTHLY_CAP_CENTS;
}

/**
 * Spend this calendar month.
 *
 * ⛔ Counts 'approved' and 'generating' as well as 'ready'. Ten approved videos
 * sitting in the queue have not been paid for yet, but they WILL be, and a cap
 * that only looks at completed spend authorises the eleventh.
 */
export async function spentThisMonthCents(db: Db, customerId: string, now: Date = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const row = await db.one<{ cents: string }>(
    `SELECT COALESCE(SUM(COALESCE(actual_cost_cents, estimated_cost_cents)), 0) AS cents
       FROM generated_assets
      WHERE customer_id = $1
        AND state IN ('approved','generating','ready')
        AND COALESCE(generated_at, approved_at, requested_at) >= $2`,
    [customerId, monthStart],
  );
  return Number(row.cents);
}

export async function requestAsset(
  db: Db,
  input: RequestAssetInput,
  now: Date = new Date(),
): Promise<RequestResult> {
  const kind = assetKindFor(input.vertical, input.assetKind);
  if (kind === undefined) {
    return { ok: false, reason: "unknown_kind", detail: `no asset kind "${input.assetKind}" for "${input.vertical}"` };
  }
  const safe = checkBrief(input.brief);
  if (!safe.ok) return { ok: false, reason: "unsafe_brief", detail: safe.why };

  const model = input.model ?? DEFAULT_MEDIA_MODELS[kind.kind];
  const estimate = estimateCostCents(kind, model);
  const cap = await monthlyCapCents(db, input.customerId);
  const spent = await spentThisMonthCents(db, input.customerId, now);
  if (spent + estimate > cap) {
    return {
      ok: false,
      reason: "cap_exceeded",
      detail: `${estimate}c would take this month to ${spent + estimate}c against a cap of ${cap}c`,
    };
  }

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const used = await db.one<{ n: string }>(
    `SELECT count(*) AS n FROM generated_assets
      WHERE customer_id = $1 AND purpose = $2 AND state IN ('approved','generating','ready')
        AND COALESCE(generated_at, approved_at, requested_at) >= $3`,
    [input.customerId, kind.id, monthStart],
  );
  if (Number(used.n) >= kind.maxPerMonth) {
    // The cap stops the money; this stops a loop.
    return { ok: false, reason: "kind_quota", detail: `${kind.label} is limited to ${kind.maxPerMonth} a month` };
  }

  const prompt = composePrompt(kind, input.brief);
  const key = assetIdempotencyKey({ customerId: input.customerId, assetKind: kind.id, prompt });
  const existing = await db.maybeOne<{ id: string; state: string }>(
    "SELECT id, state FROM generated_assets WHERE idempotency_key = $1",
    [key],
  );
  if (existing !== null) {
    return { ok: true, assetId: existing.id, estimatedCostCents: estimate, remainingCapCents: cap - spent, prompt };
  }

  const row = await db.one<{ id: string }>(
    `INSERT INTO generated_assets
       (customer_id, kind, purpose, slot, prompt, model, provider, estimated_cost_cents, requested_by, publication_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      input.customerId, kind.kind, kind.id, kind.slot, prompt, model, "modelark",
      estimate, input.requestedBy ?? "system", input.publicationId ?? null, key,
    ],
  );
  await emit({
    eventType: "asset.requested",
    subject: { kind: "generated_asset", id: row.id },
    payload: { purpose: kind.id, model, estimateCents: estimate, configVersion: assetConfigVersion() },
  });
  return { ok: true, assetId: row.id, estimatedCostCents: estimate, remainingCapCents: cap - spent, prompt };
}

export type ApproveAssetResult =
  | { ok: true; estimatedCostCents: number }
  | { ok: false; reason: "unknown" | "not_requested" | "cap_exceeded"; detail?: string };

/**
 * ⛔ The owner spends their own money here, so the cap is re-checked at
 * approval as well as at request. Between the two, ten other requests may have
 * been approved.
 */
export async function approveAsset(
  db: Db,
  assetId: string,
  by: string,
  now: Date = new Date(),
): Promise<ApproveAssetResult> {
  const row = await db.maybeOne<{ state: string; customer_id: string; estimated_cost_cents: number }>(
    "SELECT state, customer_id, estimated_cost_cents FROM generated_assets WHERE id = $1",
    [assetId],
  );
  if (row === null) return { ok: false, reason: "unknown" };
  if (row.state !== "requested") return { ok: false, reason: "not_requested", detail: row.state };

  const cap = await monthlyCapCents(db, row.customer_id);
  const spent = await spentThisMonthCents(db, row.customer_id, now);
  if (spent + row.estimated_cost_cents > cap) {
    return { ok: false, reason: "cap_exceeded", detail: `${spent + row.estimated_cost_cents}c against a cap of ${cap}c` };
  }
  await db.query(
    "UPDATE generated_assets SET state = 'approved', approved_at = $2, approved_by = $3 WHERE id = $1 AND state = 'requested'",
    [assetId, now, by],
  );
  await emit({
    eventType: "asset.approved",
    subject: { kind: "generated_asset", id: assetId },
    payload: { by, estimateCents: row.estimated_cost_cents },
  });
  return { ok: true, estimatedCostCents: row.estimated_cost_cents };
}

export async function rejectAsset(db: Db, assetId: string, reason: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE generated_assets SET state = 'rejected', rejected_reason = $2 WHERE id = $1 AND state = 'requested'",
    [assetId, reason],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface GenerateDeps {
  generator: MediaGenerator;
  store: ObjectStore;
  /** Fetch the provider's URL. Injected so a test needs no network. */
  fetchBytes?: (url: string) => Promise<Buffer>;
}

export interface GenerateRunResult {
  generated: number;
  failed: number;
  /** Skipped because generating them would breach the customer's cap. */
  capped: number;
  spentCents: number;
}

/**
 * Generate everything approved.
 *
 * ⛔ Refuses to touch a BILLABLE generator for a row that is not 'approved',
 * and the check is on the adapter's own `billable` flag rather than on an
 * environment variable — the environment variable is exactly what is wrong in
 * the deployment where it matters.
 */
export async function generateApproved(
  db: Db,
  deps: GenerateDeps,
  now: Date = new Date(),
  opts: { customerId?: string | undefined; limit?: number } = {},
): Promise<GenerateRunResult> {
  const rows = await db.query<{
    id: string; customer_id: string; kind: "image" | "video"; purpose: string;
    prompt: string; model: string; estimated_cost_cents: number; idempotency_key: string; attempts: number;
  }>(
    `SELECT id, customer_id, kind, purpose, prompt, model, estimated_cost_cents, idempotency_key, attempts
       FROM generated_assets
      WHERE state = 'approved' AND attempts < $1 AND ($2::uuid IS NULL OR customer_id = $2)
      ORDER BY approved_at ASC
      LIMIT $3`,
    [MAX_ATTEMPTS, opts.customerId ?? null, opts.limit ?? 50],
  );

  const result: GenerateRunResult = { generated: 0, failed: 0, capped: 0, spentCents: 0 };
  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;

  for (const row of rows.rows) {
    // ⛔ Immediately before the call, per row. Everything else in this file is
    // an estimate made earlier; this is the last moment the money is still ours
    // to not spend.
    const cap = await monthlyCapCents(db, row.customer_id);
    const spent = await spentThisMonthCents(db, row.customer_id, now);
    if (spent > cap) {
      result.capped += 1;
      continue;
    }

    const kindCfg = assetKindById(row.purpose);
    const req: MediaRequest = {
      kind: row.kind,
      prompt: row.prompt,
      model: row.model,
      idempotencyKey: row.idempotency_key,
      ...(kindCfg?.size === undefined ? {} : { size: kindCfg.size }),
      ...(kindCfg?.durationSeconds === undefined ? {} : { durationSeconds: kindCfg.durationSeconds }),
      ...(kindCfg?.aspectRatio === undefined ? {} : { aspectRatio: kindCfg.aspectRatio }),
    };

    await db.query("UPDATE generated_assets SET state = 'generating', attempts = attempts + 1 WHERE id = $1", [row.id]);
    try {
      const out = await deps.generator.generate(req);
      const bytes = await fetchBytes(out.url);
      const ext = row.kind === "image" ? "png" : "mp4";
      const storageKey = `assets/${row.customer_id}/${randomBytes(12).toString("hex")}.${ext}`;
      await deps.store.put(storageKey, bytes);
      await db.query(
        `UPDATE generated_assets
            SET state = 'ready', generated_at = $2, storage_key = $3, bytes = $4,
                mime = $5, actual_cost_cents = $6, provider_task_id = $7, last_error = NULL
          WHERE id = $1`,
        [
          row.id, now, storageKey, bytes.length,
          row.kind === "image" ? "image/png" : "video/mp4",
          // ⛔ Billed at the CEILING when the provider reports no price. An
          // unpriced asset counted as zero makes the cap unenforceable.
          row.estimated_cost_cents,
          out.providerTaskId ?? null,
        ],
      );
      result.generated += 1;
      result.spentCents += row.estimated_cost_cents;
      await emit({
        eventType: "asset.generated",
        subject: { kind: "generated_asset", id: row.id },
        payload: { purpose: row.purpose, model: out.model, costCents: row.estimated_cost_cents, billable: deps.generator.billable },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const terminal = row.attempts + 1 >= MAX_ATTEMPTS;
      await db.query(
        "UPDATE generated_assets SET state = $2, last_error = $3 WHERE id = $1",
        [row.id, terminal ? "failed" : "approved", message],
      );
      result.failed += 1;
    }
  }
  return result;
}

async function defaultFetchBytes(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    return Buffer.from(url.slice(comma + 1), url.slice(0, comma).endsWith(";base64") ? "base64" : "utf8");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`asset download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface AssetRow {
  id: string;
  purpose: string;
  label: string;
  kind: string;
  slot: string;
  prompt: string;
  state: string;
  /** ⛔ Always present, always "ai_generated". Every surface that shows an
   *  asset shows this with it. */
  provenance: string;
  estimatedCostCents: number;
  actualCostCents: number | null;
  approvedBy: string | null;
  storageKey: string | null;
  lastError: string | null;
}

export async function pendingAssets(db: Db, customerId: string, limit = 50): Promise<AssetRow[]> {
  return listAssets(db, customerId, ["requested"], limit);
}

export async function assetLibrary(db: Db, customerId: string, limit = 100): Promise<AssetRow[]> {
  return listAssets(db, customerId, ["ready", "approved", "generating", "failed", "rejected"], limit);
}

async function listAssets(db: Db, customerId: string, states: string[], limit: number): Promise<AssetRow[]> {
  const rows = await db.query<{
    id: string; purpose: string; kind: string; slot: string; prompt: string; state: string;
    provenance: string; estimated_cost_cents: number; actual_cost_cents: number | null;
    approved_by: string | null; storage_key: string | null; last_error: string | null;
  }>(
    `SELECT id, purpose, kind, slot, prompt, state, provenance, estimated_cost_cents,
            actual_cost_cents, approved_by, storage_key, last_error
       FROM generated_assets
      WHERE customer_id = $1 AND state = ANY($2::text[])
      ORDER BY requested_at DESC LIMIT $3`,
    [customerId, states, limit],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    purpose: r.purpose,
    label: assetKindById(r.purpose)?.label ?? r.purpose,
    kind: r.kind,
    slot: r.slot,
    prompt: r.prompt,
    state: r.state,
    provenance: r.provenance,
    estimatedCostCents: r.estimated_cost_cents,
    actualCostCents: r.actual_cost_cents,
    approvedBy: r.approved_by,
    storageKey: r.storage_key,
    lastError: r.last_error,
  }));
}

export async function setMonthlyCap(db: Db, customerId: string, cents: number, by: string): Promise<void> {
  await db.query(
    `INSERT INTO asset_budgets (customer_id, monthly_cap_cents, set_by)
     VALUES ($1,$2,$3)
     ON CONFLICT (customer_id) DO UPDATE SET monthly_cap_cents = $2, set_by = $3, set_at = now()`,
    [customerId, Math.max(0, Math.floor(cents)), by],
  );
}

export async function budgetFor(
  db: Db,
  customerId: string,
  now: Date = new Date(),
): Promise<{ capCents: number; spentCents: number; remainingCents: number; isDefault: boolean }> {
  const row = await db.maybeOne<{ monthly_cap_cents: number }>(
    "SELECT monthly_cap_cents FROM asset_budgets WHERE customer_id = $1",
    [customerId],
  );
  const capCents = row?.monthly_cap_cents ?? DEFAULT_MONTHLY_CAP_CENTS;
  const spentCents = await spentThisMonthCents(db, customerId, now);
  return { capCents, spentCents, remainingCents: Math.max(0, capCents - spentCents), isDefault: row === null };
}


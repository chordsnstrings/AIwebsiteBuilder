// The enterprise deal object.
//
// ⛔ Stages advance only forward through the track's own order, and only when
// the gate guarding the destination has its evidence. Both halves matter: a
// pipeline where anything can jump to "Agreement signed" is a pipeline that
// reports revenue that does not exist, and a gate that opens without evidence
// is a checkbox.

import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { segmentOf } from "@adw/taxonomy";
import { gateById, trackFor, trackVersion, type Track } from "./tracks.ts";

export interface OpenOpportunityInput {
  businessId: string;
  vertical: string;
  targetFunction?: string | undefined;
  namedContactRole?: string | undefined;
  ownerEmail?: string | undefined;
}

export type OpenResult =
  | { ok: true; opportunityId: string; created: boolean; track: Track }
  | { ok: false; reason: "wrong_segment"; detail: string };

/**
 * ⛔ Refuses an SMB business. The SMB motion is the lead workflow, and an
 * opportunity row for a plumber would sit in an enterprise pipeline being
 * counted, chased and forecast by people who cannot sell to them.
 */
export async function openOpportunity(db: Db, input: OpenOpportunityInput): Promise<OpenResult> {
  const segment = segmentOf(input.vertical);
  if (segment !== "enterprise_global") {
    return {
      ok: false,
      reason: "wrong_segment",
      detail: `"${input.vertical}" is ${segment ?? "unclassified"}; the SMB motion is the lead pipeline`,
    };
  }
  const track = trackFor(input.vertical);
  const existing = await db.maybeOne<{ id: string }>("SELECT id FROM opportunities WHERE business_id = $1", [
    input.businessId,
  ]);
  if (existing !== null) return { ok: true, opportunityId: existing.id, created: false, track };

  const evidence: Record<string, unknown> = {};
  if (input.targetFunction !== undefined) evidence["target_function"] = input.targetFunction;
  if (input.namedContactRole !== undefined) evidence["named_contact_role"] = input.namedContactRole;

  const row = await db.one<{ id: string }>(
    `INSERT INTO opportunities (business_id, segment, vertical, stage, target_function, named_contact_role, evidence, owner_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      input.businessId, segment, input.vertical, track.stages[0]!.key,
      input.targetFunction ?? null, input.namedContactRole ?? null,
      JSON.stringify(evidence), input.ownerEmail ?? null,
    ],
  );
  await db.query(
    "INSERT INTO opportunity_events (opportunity_id, to_stage, actor, note) VALUES ($1,$2,$3,$4)",
    [row.id, track.stages[0]!.key, input.ownerEmail ?? "system", `opened on ${trackVersion()}`],
  );
  await emit({
    eventType: "opportunity.opened",
    subject: { kind: "opportunity", id: row.id },
    payload: { vertical: input.vertical, segment },
  });
  return { ok: true, opportunityId: row.id, created: true, track };
}

/** Record a piece of gate evidence. Merged, never replaced wholesale. */
export async function recordEvidence(
  db: Db,
  opportunityId: string,
  evidence: Record<string, unknown>,
  actor: string,
): Promise<boolean> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(evidence)) {
    // ⛔ An empty string is not evidence. Without this, "reviewed_by: ''"
    // satisfies a gate that exists precisely to record who looked.
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    clean[k] = typeof v === "string" ? v.trim() : v;
  }
  if (Object.keys(clean).length === 0) return false;
  const res = await db.query(
    "UPDATE opportunities SET evidence = evidence || $2::jsonb, updated_at = now() WHERE id = $1 AND closed_at IS NULL",
    [opportunityId, JSON.stringify(clean)],
  );
  if ((res.rowCount ?? 0) === 0) return false;
  await db.query(
    "INSERT INTO opportunity_events (opportunity_id, to_stage, actor, note) SELECT id, stage, $2, $3 FROM opportunities WHERE id = $1",
    [opportunityId, actor, `evidence: ${Object.keys(clean).sort().join(", ")}`],
  );
  return true;
}

export interface GateCheck {
  open: boolean;
  gate?: string;
  missing: string[];
}

/** What the gate guarding a stage still needs. */
export async function checkGate(db: Db, opportunityId: string, toStage: string): Promise<GateCheck> {
  const row = await db.maybeOne<{ vertical: string; evidence: Record<string, unknown> }>(
    "SELECT vertical, evidence FROM opportunities WHERE id = $1",
    [opportunityId],
  );
  if (row === null) return { open: false, missing: ["unknown opportunity"] };
  const stage = trackFor(row.vertical).stages.find((s) => s.key === toStage);
  if (stage === undefined) return { open: false, missing: [`unknown stage ${toStage}`] };
  if (stage.gate === undefined) return { open: true, missing: [] };
  const gate = gateById(stage.gate);
  if (gate === undefined) return { open: false, gate: stage.gate, missing: [`unknown gate ${stage.gate}`] };
  const evidence = row.evidence ?? {};
  const missing = gate.requires.filter((k) => {
    const v = evidence[k];
    return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  });
  return { open: missing.length === 0, gate: stage.gate, missing };
}

export type AdvanceResult =
  | { ok: true; stage: string }
  | { ok: false; reason: "unknown" | "unknown_stage" | "backwards" | "gate_closed" | "closed"; missing?: string[]; detail?: string };

/**
 * Move an opportunity forward.
 *
 * ⛔ Forward only, and only through the stages this track defines. A deal that
 * can be dragged to "Agreement signed" from anywhere is a forecast; the whole
 * point of the object is that the stage means the gates behind it were passed.
 * `closed_lost` is the one exception — a deal can be lost from anywhere.
 */
export async function advanceOpportunity(
  db: Db,
  opportunityId: string,
  toStage: string,
  actor: string,
  note?: string,
): Promise<AdvanceResult> {
  const row = await db.maybeOne<{ vertical: string; stage: string; closed_at: Date | null }>(
    "SELECT vertical, stage, closed_at FROM opportunities WHERE id = $1",
    [opportunityId],
  );
  if (row === null) return { ok: false, reason: "unknown" };
  if (row.closed_at !== null) return { ok: false, reason: "closed" };

  const track = trackFor(row.vertical);
  const stages = track.stages;
  const fromIndex = stages.findIndex((s) => s.key === row.stage);
  const toIndex = stages.findIndex((s) => s.key === toStage);
  if (toIndex === -1) return { ok: false, reason: "unknown_stage", detail: toStage };

  const target = stages[toIndex]!;
  const isLoss = toStage === "closed_lost";
  if (!isLoss && toIndex <= fromIndex) {
    return { ok: false, reason: "backwards", detail: `${row.stage} → ${toStage}` };
  }

  if (!isLoss) {
    const gate = await checkGate(db, opportunityId, toStage);
    if (!gate.open) {
      return { ok: false, reason: "gate_closed", missing: gate.missing, ...(gate.gate === undefined ? {} : { detail: gate.gate }) };
    }
  }

  await db.tx(async (tx) => {
    await tx.query(
      `UPDATE opportunities SET stage = $2, updated_at = now(),
              closed_at = CASE WHEN $3 THEN now() ELSE closed_at END
        WHERE id = $1`,
      [opportunityId, toStage, target.terminal],
    );
    await tx.query(
      "INSERT INTO opportunity_events (opportunity_id, from_stage, to_stage, gate, actor, note) VALUES ($1,$2,$3,$4,$5,$6)",
      [opportunityId, row.stage, toStage, target.gate ?? null, actor, note ?? null],
    );
  });
  await emit({
    eventType: "opportunity.advanced",
    subject: { kind: "opportunity", id: opportunityId },
    payload: { from: row.stage, to: toStage, gate: target.gate ?? null },
  });
  return { ok: true, stage: toStage };
}

export type QuoteResult = { ok: true } | { ok: false; reason: "not_quoted_segment" | "unknown" | "no_approver" };

/**
 * ⛔ There is no band to read. `pricing.yaml` holds the SMB setup fee and MRR,
 * and reading one for an enterprise account is the category error this whole
 * track exists to avoid — so the amount arrives from a human with their name
 * against it, and this function will not accept one without.
 */
export async function recordQuote(
  db: Db,
  opportunityId: string,
  quote: { amountCents: number; currency: string; reference: string; approvedBy: string },
): Promise<QuoteResult> {
  const row = await db.maybeOne<{ vertical: string }>("SELECT vertical FROM opportunities WHERE id = $1", [opportunityId]);
  if (row === null) return { ok: false, reason: "unknown" };
  if (trackFor(row.vertical).pricingModel !== "quoted") return { ok: false, reason: "not_quoted_segment" };
  if (quote.approvedBy.trim() === "" || quote.reference.trim() === "") return { ok: false, reason: "no_approver" };

  await db.query(
    `UPDATE opportunities
        SET quote_amount_cents = $2, quote_currency = $3, updated_at = now(),
            evidence = evidence || jsonb_build_object('quote_ref', $4::text, 'quote_amount_cents', $2::bigint, 'approved_by', $5::text)
      WHERE id = $1`,
    [opportunityId, Math.round(quote.amountCents), quote.currency, quote.reference.trim(), quote.approvedBy.trim()],
  );
  return { ok: true };
}

export interface OpportunityRow {
  id: string;
  businessId: string;
  vertical: string;
  stage: string;
  stageLabel: string;
  targetFunction: string | null;
  quoteAmountCents: number | null;
  ownerEmail: string | null;
  nextStage: string | null;
  nextGate: string | null;
  missingEvidence: string[];
  updatedAt: Date;
}

export async function pipeline(db: Db, limit = 100): Promise<OpportunityRow[]> {
  const rows = await db.query<{
    id: string; business_id: string; vertical: string; stage: string; target_function: string | null;
    quote_amount_cents: string | null; owner_email: string | null; evidence: Record<string, unknown>; updated_at: Date;
  }>(
    `SELECT id, business_id, vertical, stage, target_function, quote_amount_cents, owner_email, evidence, updated_at
       FROM opportunities WHERE closed_at IS NULL ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
  return rows.rows.map((r) => {
    const stages = trackFor(r.vertical).stages;
    const index = stages.findIndex((s) => s.key === r.stage);
    const next = index >= 0 ? stages[index + 1] : undefined;
    const gate = next?.gate === undefined ? undefined : gateById(next.gate);
    const evidence = r.evidence ?? {};
    return {
      id: r.id,
      businessId: r.business_id,
      vertical: r.vertical,
      stage: r.stage,
      stageLabel: stages[index]?.label ?? r.stage,
      targetFunction: r.target_function,
      quoteAmountCents: r.quote_amount_cents === null ? null : Number(r.quote_amount_cents),
      ownerEmail: r.owner_email,
      nextStage: next?.key ?? null,
      nextGate: next?.gate ?? null,
      // ⛔ Shown on the pipeline, not only on a failed attempt. A deal stuck for
      // three weeks because nobody recorded the DPA reference should say so on
      // the board rather than when somebody tries to move it.
      missingEvidence: (gate?.requires ?? []).filter((k) => {
        const v = evidence[k];
        return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
      }),
      updatedAt: new Date(r.updated_at),
    };
  });
}

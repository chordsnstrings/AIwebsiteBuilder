// What an enterprise account receives INSTEAD of a speculative preview.
//
// ⛔ A document about their problem, addressed to the function that owns it —
// not a copy of their brand hosted on our domain. That distinction is the whole
// reason this file exists, and it is the difference between an unsolicited
// business case (ordinary B2B, mildly annoying at worst) and passing off (a
// trademark complaint with a legal department already attached).
//
// ⛔ Every figure traces to a deterministic finding, the same rule the SMB
// audit follows. An enterprise buyer forwards this to somebody who will check
// it, and one invented number ends the conversation and the account.

import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { trackFor } from "./tracks.ts";

export interface CaseFinding {
  /** What was checked, in the words of the check. */
  check: string;
  /** What was observed. Never a projection, never an estimate. */
  observed: string;
  /** Why it matters to the target function. */
  soWhat: string;
}

export interface DraftBusinessCaseInput {
  opportunityId: string;
  targetFunction: string;
  findings: CaseFinding[];
  auditId?: string | undefined;
  /** Optional narrative. Claims in it are checked against the findings. */
  body?: string | undefined;
}

export type DraftCaseResult =
  | { ok: true; caseId: string; body: string }
  | { ok: false; reason: "unknown_opportunity" | "wrong_track" | "no_findings" | "unsupported_claim"; detail: string };

/** Numbers that appear in prose but in none of the findings. */
export function unsupportedFigures(body: string, findings: CaseFinding[]): string[] {
  const supported = findings.flatMap((f) => `${f.check} ${f.observed} ${f.soWhat}`.match(/\d[\d,.]*/g) ?? []);
  const supportedSet = new Set(supported.map((n) => n.replace(/[,.]$/, "")));
  const used = body.match(/\d[\d,.]*%?/g) ?? [];
  return used
    .map((n) => n.replace(/[,.]$/, ""))
    .filter((n) => n.replace(/%$/, "").length > 1)
    .filter((n) => !supportedSet.has(n) && !supportedSet.has(n.replace(/%$/, "")));
}

export async function draftBusinessCase(
  db: Db,
  input: DraftBusinessCaseInput,
): Promise<DraftCaseResult> {
  const opp = await db.maybeOne<{ vertical: string }>("SELECT vertical FROM opportunities WHERE id = $1", [
    input.opportunityId,
  ]);
  if (opp === null) return { ok: false, reason: "unknown_opportunity", detail: input.opportunityId };
  const track = trackFor(opp.vertical);
  if (track.outreachArtefact !== "business_case") {
    return { ok: false, reason: "wrong_track", detail: `${track.label} accounts receive a ${track.outreachArtefact}` };
  }
  if (input.findings.length === 0) {
    // ⛔ A business case with no findings is a brochure, and an unsolicited
    // brochure to a named individual is the thing everyone's spam filter and
    // everyone's procurement policy exists to stop.
    return { ok: false, reason: "no_findings", detail: "a business case with no observed findings is a brochure" };
  }

  const body = input.body ?? renderCase(input.targetFunction, input.findings);
  const unsupported = unsupportedFigures(body, input.findings);
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: "unsupported_claim",
      detail: `figures with no finding behind them: ${unsupported.join(", ")}`,
    };
  }

  const row = await db.one<{ id: string }>(
    `INSERT INTO business_cases (opportunity_id, target_function, findings, audit_id, body)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (opportunity_id, target_function)
       DO UPDATE SET findings = EXCLUDED.findings, body = EXCLUDED.body
     RETURNING id`,
    [input.opportunityId, input.targetFunction, JSON.stringify(input.findings), input.auditId ?? null, body],
  );
  await emit({
    eventType: "business_case.drafted",
    subject: { kind: "business_case", id: row.id },
    payload: { opportunityId: input.opportunityId, findings: input.findings.length },
  });
  return { ok: true, caseId: row.id, body };
}

function renderCase(targetFunction: string, findings: CaseFinding[]): string {
  const lines = [
    `Prepared for: ${targetFunction}`,
    "",
    "What we observed on your public surfaces:",
    "",
  ];
  for (const f of findings) {
    lines.push(`- ${f.check}: ${f.observed}. ${f.soWhat}`);
  }
  lines.push(
    "",
    // ⛔ Said in the artefact itself. An enterprise recipient is entitled to
    // know how a stranger came to be writing to them about their systems.
    "Everything above was observed from publicly available pages. We have not",
    "accessed any system of yours and this document contains no projection.",
  );
  return lines.join("\n");
}

export type ApproveCaseResult = { ok: true } | { ok: false; reason: "unknown" | "not_draft" };

/**
 * ⛔ A human on OUR side signs a business case off before it is sent, the same
 * way an owner signs off a Q&A pack. An enterprise buyer forwards this
 * internally; whatever is in it is what we said about them, in writing.
 */
export async function approveBusinessCase(db: Db, caseId: string, by: string): Promise<ApproveCaseResult> {
  const row = await db.maybeOne<{ state: string }>("SELECT state FROM business_cases WHERE id = $1", [caseId]);
  if (row === null) return { ok: false, reason: "unknown" };
  if (row.state !== "draft") return { ok: false, reason: "not_draft" };
  await db.query(
    "UPDATE business_cases SET state = 'approved', approved_at = now(), approved_by = $2 WHERE id = $1 AND state = 'draft'",
    [caseId, by],
  );
  return { ok: true };
}

export interface BusinessCaseRow {
  id: string;
  targetFunction: string;
  state: string;
  approvedBy: string | null;
  findings: CaseFinding[];
  body: string;
}

export async function casesFor(db: Db, opportunityId: string): Promise<BusinessCaseRow[]> {
  const rows = await db.query<{
    id: string; target_function: string; state: string; approved_by: string | null;
    findings: CaseFinding[]; body: string;
  }>(
    "SELECT id, target_function, state, approved_by, findings, body FROM business_cases WHERE opportunity_id = $1 ORDER BY created_at",
    [opportunityId],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    targetFunction: r.target_function,
    state: r.state,
    approvedBy: r.approved_by,
    findings: r.findings ?? [],
    body: r.body,
  }));
}

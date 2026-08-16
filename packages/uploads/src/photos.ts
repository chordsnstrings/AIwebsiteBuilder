// Photo assessment (catalogue MF9 — 12 units).
//
// `photo_assessments` existed as a table from the first v3 migration and had
// ZERO writers, because nothing could receive a photograph. This is the writer.
//
// ⛔ "Assesses, never prices" is the catalogue's own wording and it is
// structural here rather than instructed: `photoTriageAgent`'s output schema has
// no price field, and `price_cents` on the row is written only by the owner.
// A constraint expressed as a missing field cannot be talked past by a clever
// prompt; a constraint expressed as "please do not quote" can.

import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";

export interface PhotoAssessment {
  whatItIs: string;
  apparentScope: string;
  visibleComplications: string[];
  /** ⛔ What the photograph does NOT show. Stating this is the difference
   *  between an assessment and a guess, and it is required, not optional. */
  notDeterminable: string[];
  urgent: boolean;
  suggestedReply: string;
}

export interface RecordAssessmentInput {
  uploadId: string;
  assessment: PhotoAssessment;
  customerId?: string | undefined;
  sessionId?: string | undefined;
}

export async function recordAssessment(db: Db, input: RecordAssessmentInput): Promise<string> {
  const upload = await db.maybeOne<{ storage_key: string; kind: string }>(
    "SELECT storage_key, kind FROM uploads WHERE id = $1 AND deleted_at IS NULL",
    [input.uploadId],
  );
  if (upload === null) throw new Error(`No such upload: ${input.uploadId}`);
  // ⛔ A PDF is not a photograph. Assessing one would mean the vision path ran
  // against something it cannot see, and produced confident prose about it.
  if (upload.kind !== "photo") throw new Error(`Upload ${input.uploadId} is a ${upload.kind}, not a photograph`);

  if (input.assessment.notDeterminable.length === 0) {
    throw new Error(
      "An assessment with nothing in notDeterminable is a guess wearing an assessment's clothes. " +
        "A photograph always fails to show something — say what.",
    );
  }

  const row = await db.one<{ id: string }>(
    `INSERT INTO photo_assessments (customer_id, session_id, image_r2_key, assessment, not_determinable, urgent)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      input.customerId ?? null,
      input.sessionId ?? null,
      upload.storage_key,
      JSON.stringify(input.assessment),
      input.assessment.notDeterminable,
      input.assessment.urgent,
    ],
  );
  await emit({
    eventType: "photo.assessed",
    subject: { kind: "customer", id: input.customerId ?? "unknown" },
    // ⛔ Never the assessment text. It describes someone's home.
    payload: { urgent: input.assessment.urgent, notDeterminableCount: input.assessment.notDeterminable.length },
  });
  return row.id;
}

/**
 * The owner prices it. ⛔ The only writer of `price_cents`, and it takes an
 * operator identity precisely so no automated path can reach it.
 */
export async function ownerPrices(
  db: Db,
  assessmentId: string,
  priceCents: number,
  by: string,
): Promise<boolean> {
  const res = await db.query(
    "UPDATE photo_assessments SET price_cents = $2, owner_replied_at = now() WHERE id = $1 AND owner_replied_at IS NULL",
    [assessmentId, priceCents],
  );
  if ((res.rowCount ?? 0) > 0) {
    await emit({ eventType: "photo.priced", subject: { kind: "assessment", id: assessmentId }, payload: { by } });
    return true;
  }
  return false;
}

/**
 * Record consent for a photograph to be used in marketing.
 *
 * ⛔ Explicit and separate from possessing the file. Someone who sent a picture
 * of their flooded kitchen so it could be fixed has not agreed to it appearing
 * on a website, and a portfolio built from unconsented customer photographs is
 * a complaint that arrives with a solicitor's letter attached.
 */
export async function grantMarketingConsent(db: Db, uploadId: string, by: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE uploads SET marketing_consent_at = now(), marketing_consent_by = $2 WHERE id = $1 AND marketing_consent_at IS NULL",
    [uploadId, by],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Photographs the business may actually publish.
 *
 * ⛔ Consent is a WHERE clause, not a filter the caller is trusted to apply.
 * The portfolio query cannot accidentally include an unconsented photo because
 * there is no query that returns one.
 */
export async function consentedPhotos(db: Db, customerId: string): Promise<{ id: string; storageKey: string }[]> {
  const rows = await db.query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM uploads
      WHERE customer_id = $1 AND kind = 'photo' AND deleted_at IS NULL
        AND scan_status = 'clean' AND marketing_consent_at IS NOT NULL
      ORDER BY created_at DESC`,
    [customerId],
  );
  return rows.rows.map((r) => ({ id: r.id, storageKey: r.storage_key }));
}

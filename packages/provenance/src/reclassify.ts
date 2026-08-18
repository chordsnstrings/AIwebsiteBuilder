// Re-running the subscriber-type classification over contacts already held.
//
// ⛔ WHY A SECOND PASS EXISTS. Classification happens once, inside
// `ingestRecord`, at the instant a contact is created. That is the only place
// it ever ran. So a contact ingested while the classifier could not answer is
// stuck at "unknown" for the rest of its life, and "unknown" denies at the gate
// under PECR — permanently, silently, with the row looking perfectly healthy.
//
// Two things make that a live defect rather than a hypothetical:
//
//   * Every GB and IE contact in the database was ingested against a stub that
//     returned "unknown" unconditionally. Fixing the classifier does nothing
//     for any of them without this pass.
//   * The whole vendor architecture is "deposit a credential, the adapter flips
//     mock→real". Depositing a Companies House key upgrades the classifier from
//     name-suffix evidence to an actual registry lookup — and that upgrade is
//     worthless if it only applies to contacts ingested after the deposit.
//
// So this runs on a schedule, and it is the mechanism by which improving the
// classifier improves the database rather than only the next batch.

import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import type { RegistryLookup } from "./index.ts";

/** Only these jurisdictions use the corporate/sole-trader distinction. */
const CLASSIFIED_COUNTRIES = ["GB", "IE"];

export interface ReclassifyOptions {
  /** Cap per run. The pass is idempotent, so a backlog drains over several runs. */
  readonly limit: number;
  readonly now?: () => Date;
}

export interface ReclassifyOutcome {
  /** Contacts examined — the denominator. Zero means nothing was checked, not that nothing was wrong. */
  readonly considered: number;
  /** Contacts whose classification moved off "unknown". */
  readonly resolved: number;
  /** Still unresolved after the pass. Not a failure: it is the honest answer. */
  readonly unresolved: number;
  /** Resolved counts by the answer written. */
  readonly byType: Record<string, number>;
  /** Contacts remaining unclassified across the whole population, after this run. */
  readonly backlog: number;
  readonly errors: number;
}

interface Row {
  contact_id: string;
  business_name: string;
  country_code: string;
}

/**
 * Reclassify GB/IE contacts whose subscriber type is unresolved.
 *
 * ⛔ NEVER DOWNGRADES. The selection covers only NULL and "unknown", and the
 * write is additionally guarded on the same predicate, so a concurrent ingest
 * that resolved the row cannot be clobbered back to "unknown" by a pass that
 * read it a moment earlier. A classifier that can erase a known-good corporate
 * classification would take mailable contacts OUT of the pipeline every time it
 * ran, which is the same silent-shrink failure this pass exists to undo.
 */
export async function reclassifySubscribers(
  db: Db,
  registry: RegistryLookup,
  opts: ReclassifyOptions,
): Promise<ReclassifyOutcome> {
  const limit = Math.max(0, Math.floor(opts.limit));
  const byType: Record<string, number> = {};
  let resolved = 0;
  let errors = 0;

  const rows: Row[] = limit === 0 ? [] : (await db.query<Row>(
    `SELECT c.id AS contact_id, b.name AS business_name, b.country_code
       FROM contacts c
       JOIN businesses b ON b.id = c.business_id
      WHERE b.country_code = ANY($1)
        AND (c.subscriber_type IS NULL OR c.subscriber_type = 'unknown')
      ORDER BY c.created_at
      LIMIT $2`,
    [CLASSIFIED_COUNTRIES, limit],
  )).rows;

  for (const row of rows) {
    let answer;
    try {
      answer = await registry.classify(row.business_name, row.country_code);
    } catch {
      // A registry outage must not be recorded as "we checked and found
      // nothing" — that is indistinguishable from a real negative and would
      // stop the row ever being retried if this pass ever learned to skip.
      errors += 1;
      continue;
    }
    if (answer.subscriberType === "unknown") continue;

    await db.query(
      `UPDATE contacts
          SET subscriber_type = $2, registry_ref = $3
        WHERE id = $1
          AND (subscriber_type IS NULL OR subscriber_type = 'unknown')`,
      [row.contact_id, answer.subscriberType, answer.ref],
    );
    resolved += 1;
    byType[answer.subscriberType] = (byType[answer.subscriberType] ?? 0) + 1;
  }

  const remaining = await db.one<{ n: string }>(
    `SELECT count(*) AS n
       FROM contacts c
       JOIN businesses b ON b.id = c.business_id
      WHERE b.country_code = ANY($1)
        AND (c.subscriber_type IS NULL OR c.subscriber_type = 'unknown')`,
    [CLASSIFIED_COUNTRIES],
  );

  const outcome: ReclassifyOutcome = {
    considered: rows.length,
    resolved,
    unresolved: rows.length - resolved - errors,
    byType,
    backlog: Number(remaining.n),
    errors,
  };

  if (rows.length > 0) {
    await emit({ eventType: "provenance.subscriber_type.reclassified", payload: { ...outcome } });
  }
  return outcome;
}

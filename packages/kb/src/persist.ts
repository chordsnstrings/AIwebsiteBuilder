// Persistence against the frozen v3 tables: knowledge_bases, kb_facts,
// kb_conflicts. Row ids are content-derived (see deterministicUuid), so writing
// the same KB twice is a no-op rather than a duplicate — re-running A4 after a
// timeout must not double the pack.
import type { Db } from "@adw/db";
import type { KbConflict, KbFact, KbFactStatus, KbFactType, KnowledgeBase } from "./types.ts";
import { FACT_TYPES } from "./types.ts";
import { computeGaps } from "./extract.ts";

export interface PersistResult {
  kbId: string;
  factsWritten: number;
  /** Facts dropped for missing provenance. Non-zero means an extractor is
   *  misbehaving upstream and the count belongs in the caller's telemetry. */
  factsRejected: number;
  conflictsWritten: number;
}

const FACT_TYPE_SET = new Set<string>(FACT_TYPES);
const STATUSES = new Set<string>(["verified", "claimed_unverified", "stale", "inferred"]);

function hasProvenance(fact: KbFact): boolean {
  return (
    typeof fact.sourceUrl === "string" &&
    fact.sourceUrl.trim().length > 0 &&
    fact.retrievedAt instanceof Date &&
    Number.isFinite(fact.retrievedAt.getTime())
  );
}

/**
 * Write a KB and everything under it in one transaction. A fact missing either
 * half of its provenance is NOT written — the DB columns are NOT NULL for the
 * same reason, and this check exists so the rejection is countable rather than
 * a constraint violation that takes the whole batch down.
 */
export async function persistKnowledgeBase(db: Db, kb: KnowledgeBase): Promise<PersistResult> {
  const writable = kb.facts.filter(hasProvenance);
  const rejected = kb.facts.length - writable.length;
  const writableIds = new Set(writable.map((f) => f.id));

  return db.tx(async (tx) => {
    await tx.query(
      `INSERT INTO knowledge_bases (id, business_id, customer_id, version, site_hash, gbp_hash, thin, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING`,
      [kb.id, kb.businessId, kb.customerId ?? null, kb.version, kb.siteHash, kb.gbpHash, kb.thin, kb.createdAt],
    );

    for (const fact of writable) {
      await tx.query(
        `INSERT INTO kb_facts (id, kb_id, fact_key, type, value, source_url, retrieved_at, confidence, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING`,
        [fact.id, kb.id, fact.factKey, fact.type, fact.value, fact.sourceUrl, fact.retrievedAt, fact.confidence, fact.status],
      );
    }

    let conflictsWritten = 0;
    for (const conflict of kb.conflicts) {
      // A conflict pointing at a fact we refused to write would be unreadable.
      const ids = conflict.factIds.filter((id) => writableIds.has(id));
      if (ids.length < 2) continue;
      await tx.query(
        `INSERT INTO kb_conflicts (id, kb_id, fact_ids, description, resolved_at, resolved_value)
         VALUES ($1,$2,$3::uuid[],$4,$5,$6)
         ON CONFLICT DO NOTHING`,
        [conflict.id, kb.id, ids, conflict.description, conflict.resolvedAt ?? null, conflict.resolvedValue ?? null],
      );
      conflictsWritten++;
    }

    return { kbId: kb.id, factsWritten: writable.length, factsRejected: rejected, conflictsWritten };
  });
}

interface KbRow {
  id: string;
  business_id: string;
  customer_id: string | null;
  version: number;
  site_hash: string | null;
  gbp_hash: string | null;
  thin: boolean;
  created_at: Date;
}

interface FactRow {
  id: string;
  fact_key: string;
  type: string;
  value: string;
  source_url: string;
  retrieved_at: Date;
  confidence: string;
  status: string;
}

interface ConflictRow {
  id: string;
  fact_ids: string[];
  description: string;
  resolved_at: Date | null;
  resolved_value: string | null;
}

/** Language is carried in fact_key (`type:lang:slug`) because kb_facts has no
 *  language column and the schema is frozen. */
function langOf(factKey: string): string {
  return factKey.split(":")[1] ?? "en";
}

export async function loadKnowledgeBase(db: Db, kbId: string): Promise<KnowledgeBase | null> {
  const row = await db.maybeOne<KbRow>(
    `SELECT id, business_id, customer_id, version, site_hash, gbp_hash, thin, created_at
       FROM knowledge_bases WHERE id = $1`,
    [kbId],
  );
  if (row === null) return null;

  const factRows = await db.query<FactRow>(
    `SELECT id, fact_key, type, value, source_url, retrieved_at, confidence, status
       FROM kb_facts WHERE kb_id = $1 ORDER BY fact_key, id`,
    [kbId],
  );
  const facts: KbFact[] = factRows.rows
    .filter((f) => FACT_TYPE_SET.has(f.type) && STATUSES.has(f.status))
    .map((f) => ({
      id: f.id,
      factKey: f.fact_key,
      type: f.type as KbFactType,
      value: f.value,
      lang: langOf(f.fact_key),
      sourceUrl: f.source_url,
      retrievedAt: f.retrieved_at,
      confidence: Number(f.confidence),
      status: f.status as KbFactStatus,
    }));

  const conflictRows = await db.query<ConflictRow>(
    `SELECT id, fact_ids, description, resolved_at, resolved_value
       FROM kb_conflicts WHERE kb_id = $1 ORDER BY id`,
    [kbId],
  );
  const conflicts: KbConflict[] = conflictRows.rows.map((c) => ({
    id: c.id,
    factIds: c.fact_ids,
    description: c.description,
    ...(c.resolved_at === null ? {} : { resolvedAt: c.resolved_at }),
    ...(c.resolved_value === null ? {} : { resolvedValue: c.resolved_value }),
  }));

  // The gap list is derived, not stored: it must never drift from the facts it
  // describes. The vertical comes from the A3 manifest this KB was built for.
  const manifest = await db.maybeOne<{ vertical: string }>(
    `SELECT vertical FROM delivery_manifests WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [row.business_id],
  );

  return {
    id: row.id,
    businessId: row.business_id,
    ...(row.customer_id === null ? {} : { customerId: row.customer_id }),
    version: Number(row.version),
    siteHash: row.site_hash ?? "",
    gbpHash: row.gbp_hash ?? "",
    thin: row.thin,
    facts,
    conflicts,
    gaps: computeGaps(facts, conflicts, manifest?.vertical),
    createdAt: row.created_at,
  };
}

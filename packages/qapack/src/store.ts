// Persistence for qa_packs / qa_pairs (migration 0009). Writes are idempotent on
// the deterministic ids from ids.ts, so a retried A5 updates the pack it already
// wrote instead of creating a second one.
import type { Db } from "@adw/db";
import { deserialiseEmbedding, EMBEDDING_DIMS, serialiseEmbedding } from "./embedding.ts";
import type { ExcludedPair, PackCoverage, QAPack, QAPair, QAPairSource } from "./types.ts";

interface PackRow {
  id: string;
  kb_id: string;
  business_id: string;
  customer_id: string | null;
  version: number;
  pair_count: number;
  coverage: unknown;
  template_fallbacks: unknown;
  thin: boolean;
  approved_at: Date | null;
  approved_by: string | null;
  created_at: Date;
}

interface PairRow {
  id: string;
  question: string;
  answer: string;
  source_fact_ids: string[] | null;
  embedding: Buffer | null;
  embedding_dims: number | null;
  confidence: string | number;
  source: string;
  approved_at: Date | null;
  approved_by: string | null;
}

// qa_packs has no column for gaps, excluded, vertical or the provenance of the
// build itself, and adding columns to a frozen migration is not on the table.
// They ride in the coverage JSONB, which is where the pack's own metadata
// belongs — and loadQAPack reads them back, so the row round-trips.
interface CoverageJson extends PackCoverage {
  vertical: string;
  playbookVersion: string;
  embeddingProvider: string;
  extendedOnboarding: boolean;
  gaps: string[];
  excluded: ExcludedPair[];
}

function isPairSource(value: string): value is QAPairSource {
  return value === "generated" || value === "template_refusal" || value === "promoted_fallback";
}

/**
 * Write the pack and its pairs. Throws before touching the database if any
 * generated pair lacks a source fact: the DB CHECK catches that too, but code
 * that relies on a constraint to enforce the product's central rule has already
 * lost the argument about where the rule lives.
 */
export async function persistQAPack(db: Db, pack: QAPack): Promise<void> {
  for (const pair of pack.pairs) {
    if (pair.source === "generated" && pair.sourceFactIds.length === 0) {
      throw new Error(`Refusing to persist pair with no source fact: "${pair.question}"`);
    }
    if (pair.embedding.length !== EMBEDDING_DIMS) {
      throw new Error(`Pair "${pair.question}" has ${pair.embedding.length} dims, expected ${EMBEDDING_DIMS}`);
    }
  }

  const coverage: CoverageJson = {
    ...pack.coverage,
    vertical: pack.vertical,
    playbookVersion: pack.playbookVersion,
    embeddingProvider: pack.embeddingProvider,
    extendedOnboarding: pack.extendedOnboarding,
    gaps: pack.gaps,
    excluded: pack.excluded,
  };

  await db.tx(async (tx) => {
    await tx.query(
      `INSERT INTO qa_packs
         (id, kb_id, business_id, customer_id, version, pair_count, coverage, template_fallbacks, thin)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
       ON CONFLICT (id) DO UPDATE SET
         pair_count = EXCLUDED.pair_count,
         coverage = EXCLUDED.coverage,
         template_fallbacks = EXCLUDED.template_fallbacks,
         thin = EXCLUDED.thin`,
      [
        pack.id,
        pack.kbId,
        pack.businessId,
        pack.customerId ?? null,
        pack.version,
        pack.pairs.length,
        JSON.stringify(coverage),
        JSON.stringify(pack.templateFallbacks),
        pack.thin,
      ],
    );

    for (const pair of pack.pairs) {
      await tx.query(
        `INSERT INTO qa_pairs
           (id, pack_id, question, answer, source_fact_ids, embedding, embedding_dims, confidence, source, approved_at, approved_by)
         VALUES ($1,$2,$3,$4,$5::uuid[],$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET
           question = EXCLUDED.question,
           answer = EXCLUDED.answer,
           source_fact_ids = EXCLUDED.source_fact_ids,
           embedding = EXCLUDED.embedding,
           embedding_dims = EXCLUDED.embedding_dims,
           confidence = EXCLUDED.confidence,
           source = EXCLUDED.source`,
        [
          pair.id,
          pack.id,
          pair.question,
          pair.answer,
          pair.sourceFactIds,
          serialiseEmbedding(pair.embedding),
          pair.embedding.length,
          pair.confidence,
          pair.source,
          pair.approvedAt ?? null,
          pair.approvedBy ?? null,
        ],
      );
    }
  });
}

/** Read a pack back whole. Returns null when the pack id is unknown. */
export async function loadQAPack(db: Db, id: string): Promise<QAPack | null> {
  const row = await db.maybeOne<PackRow>(`SELECT * FROM qa_packs WHERE id = $1`, [id]);
  if (row === null) return null;

  const coverage = (row.coverage ?? {}) as Partial<CoverageJson>;
  // Ordered by id rather than insertion: retrieval brute-force scans the whole
  // pack, so the only thing order has to be is stable across reads.
  const pairRows = await db.query<PairRow>(
    `SELECT id, question, answer, source_fact_ids, embedding, embedding_dims,
            confidence, source, approved_at, approved_by
       FROM qa_pairs WHERE pack_id = $1 ORDER BY id`,
    [id],
  );

  const pairs: QAPair[] = pairRows.rows.map((pair) => ({
    id: pair.id,
    question: pair.question,
    answer: pair.answer,
    sourceFactIds: pair.source_fact_ids ?? [],
    embedding: pair.embedding === null ? new Float32Array(0) : deserialiseEmbedding(pair.embedding),
    confidence: Number(pair.confidence),
    source: isPairSource(pair.source) ? pair.source : "generated",
    ...(pair.approved_at === null ? {} : { approvedAt: pair.approved_at }),
    ...(pair.approved_by === null ? {} : { approvedBy: pair.approved_by }),
  }));

  return {
    id: row.id,
    kbId: row.kb_id,
    businessId: row.business_id,
    ...(row.customer_id === null ? {} : { customerId: row.customer_id }),
    version: row.version,
    vertical: coverage.vertical ?? "",
    playbookVersion: coverage.playbookVersion ?? "",
    embeddingProvider: coverage.embeddingProvider ?? "",
    pairs,
    coverage: {
      byTopic: coverage.byTopic ?? {},
      byVerticalTemplate: coverage.byVerticalTemplate ?? { answered: 0, total: 0, ratio: 0 },
      factsUsed: coverage.factsUsed ?? 0,
      factsAvailable: coverage.factsAvailable ?? 0,
    },
    templateFallbacks: Array.isArray(row.template_fallbacks) ? (row.template_fallbacks as string[]) : [],
    gaps: coverage.gaps ?? [],
    excluded: coverage.excluded ?? [],
    thin: row.thin,
    extendedOnboarding: coverage.extendedOnboarding ?? row.thin,
    ...(row.approved_at === null ? {} : { approvedAt: row.approved_at }),
    ...(row.approved_by === null ? {} : { approvedBy: row.approved_by }),
    createdAt: row.created_at,
  };
}

export interface PackApproval {
  packId: string;
  approvedAt: Date;
  approvedBy: string;
  pairsApproved: number;
}

/**
 * The owner signs off the pack before go-live (§21.3). First approval wins: a
 * second call returns the original approver and timestamp rather than
 * overwriting them, because the approval is the evidence that makes a stored
 * answer defensible and evidence is not editable.
 */
export async function approvePack(db: Db, id: string, approver: string, at?: Date): Promise<PackApproval> {
  return db.tx(async (tx) => {
    const pack = await tx.maybeOne<{ approved_at: Date | null }>(
      `SELECT approved_at FROM qa_packs WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (pack === null) throw new Error(`No such Q&A pack: ${id}`);

    const stamped = await tx.one<{ approved_at: Date; approved_by: string }>(
      `UPDATE qa_packs
          SET approved_at = COALESCE(approved_at, $2), approved_by = COALESCE(approved_by, $3)
        WHERE id = $1
        RETURNING approved_at, approved_by`,
      [id, at ?? new Date(), approver],
    );

    // Pairs carry the approval too: a pair promoted into this pack later is
    // unapproved until its own sign-off, and the difference has to be visible
    // per row, not inferred from the pack.
    const pairs = await tx.query(
      `UPDATE qa_pairs
          SET approved_at = $2, approved_by = $3
        WHERE pack_id = $1 AND approved_at IS NULL`,
      [id, stamped.approved_at, stamped.approved_by],
    );

    return {
      packId: id,
      approvedAt: stamped.approved_at,
      approvedBy: stamped.approved_by,
      pairsApproved: pairs.rowCount,
    };
  });
}

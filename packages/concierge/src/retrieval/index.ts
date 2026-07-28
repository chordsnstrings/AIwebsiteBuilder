// Hybrid retrieval (§39.1). Two rankings, fused; two gates, both mandatory.
//
// ⛔ The guarantee is that a returned answer is a STORED answer. Nothing here
// composes text. `retrieve` selects a QAPair or it selects nothing — and
// selecting nothing is a normal, frequent, designed outcome that ends in a gap
// row rather than an improvisation.
//
// Ranking:  reciprocal-rank fusion of the cosine ranking and the BM25 ranking.
// Gating:   the winner's COSINE against the config thresholds, then coverage.
//
// The split matters. RRF scores have no absolute meaning — with rrf_k = 60 a
// perfect match scores 0.033, so comparing one to `verbatim_min: 0.82` would be
// nonsense. Fusion decides WHICH pair; cosine decides WHETHER it is close
// enough; coverage decides whether it is about the same thing. Only the second
// and third can refuse.
//
// The scan is exhaustive. pgvector is not present in this environment and a
// pack is 150–250 pairs, so an ANN index would trade exactness for a
// microsecond nobody would notice. `EmbeddingProvider` and this scan are the
// documented swap point when a pack outgrows that — the interface does not
// change.

import { config } from "@adw/config";
import { cosine, deserialiseEmbedding, embedText, EMBEDDING_DIMS, type QAPack, type QAPair } from "@adw/qapack";
import { bm25Score, buildBm25 } from "./bm25.ts";
import { missingTerms, stemSet } from "./coverage.ts";
import type { PackIndex, RetrievalOutcome, RetrievalThresholds, ScoredPair } from "../types.ts";

/** How far down the fused ranking to look for a pair that clears both gates. */
const RERANK_DEPTH = 5;

export { BM25_B, BM25_K1, bm25Score, buildBm25 } from "./bm25.ts";
export { missingTerms, narrowingTerms, stem, stemSet } from "./coverage.ts";

/**
 * Thresholds come from config/playbooks.yaml, never from a literal here. They
 * are a compliance-owned number: lowering `verbatim_min` makes the agent bolder
 * about someone else's business, and that decision is a reviewed config change
 * rather than something a developer tunes to make a test pass.
 */
export function thresholds(): RetrievalThresholds {
  const r = config.playbooks().data.retrieval as Record<string, number>;
  const need = (key: string): number => {
    const value = r[key];
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new Error(`config/playbooks.yaml: retrieval.${key} is missing or not a number`);
    }
    return value;
  };
  return {
    verbatimMin: need("verbatim_min"),
    hedgedMin: need("hedged_min"),
    rrfK: need("rrf_k"),
    vectorWeight: need("vector_weight"),
    bm25Weight: need("bm25_weight"),
  };
}

/** Question + answer, because the answer carries the fact text a visitor's
 *  wording often matches better than the generated question does. */
function docText(pair: QAPair): string {
  return `${pair.question} ${pair.answer}`;
}

export function buildPackIndex(pack: QAPack): PackIndex {
  const texts = pack.pairs.map(docText);
  return {
    packId: pack.id,
    vertical: pack.vertical,
    embeddingProvider: pack.embeddingProvider,
    pairs: pack.pairs,
    texts,
    bm25: buildBm25(texts),
  };
}

/**
 * Rebuild an index from rows read straight out of qa_pairs. Used by the API,
 * which loads a pack per turn rather than holding whole packs in memory.
 */
export function indexFromRows(
  packId: string,
  vertical: string,
  embeddingProvider: string,
  rows: { id: string; question: string; answer: string; embedding: Buffer | null; source_fact_ids: string[] | null }[],
): PackIndex {
  const pairs: QAPair[] = rows.map((r) => ({
    id: r.id,
    question: r.question,
    answer: r.answer,
    sourceFactIds: r.source_fact_ids ?? [],
    embedding: r.embedding === null ? new Float32Array(EMBEDDING_DIMS) : deserialiseEmbedding(r.embedding),
    confidence: 1,
    source: "generated" as const,
  }));
  const texts = pairs.map(docText);
  return { packId, vertical, embeddingProvider, pairs, texts, bm25: buildBm25(texts) };
}

function rankOf(order: number[], docIndex: number): number {
  const at = order.indexOf(docIndex);
  return at < 0 ? order.length : at;
}

/**
 * Score every pair, fuse the two rankings, then walk the fused order and return
 * the first pair that clears BOTH gates.
 *
 * Walking rather than taking the single winner is deliberate: fusion can float
 * a lexically strong pair above a semantically better one, and if the top pair
 * fails coverage there may be a correct pair one place below it. Refusing
 * outright there would throw away an answer the business did publish.
 */
export function retrieve(index: PackIndex, question: string, limits: RetrievalThresholds = thresholds()): RetrievalOutcome {
  if (index.pairs.length === 0) return { hit: false, reason: "empty_pack", ranked: [] };

  const queryVec = embedText(question);
  const cosines: number[] = [];
  const bm25s: number[] = [];

  for (let i = 0; i < index.pairs.length; i++) {
    const pair = index.pairs[i]!;
    // A pair whose vector was never written, or was written by a provider with
    // different geometry, scores zero on the vector side rather than throwing.
    // BM25 still ranks it, so the pack degrades to lexical rather than dying.
    const vec = pair.embedding;
    cosines.push(vec.length === queryVec.length ? cosine(queryVec, vec) : 0);
    bm25s.push(bm25Score(index.bm25, question, i));
  }

  const all = index.pairs.map((_, i) => i);
  const byCosine = [...all].sort((a, b) => (cosines[b] ?? 0) - (cosines[a] ?? 0));
  const byBm25 = [...all].sort((a, b) => (bm25s[b] ?? 0) - (bm25s[a] ?? 0));

  const ranked: ScoredPair[] = all
    .map((i) => {
      const rrf =
        limits.vectorWeight / (limits.rrfK + rankOf(byCosine, i) + 1) +
        // A pair no query term touches gets no lexical vote at all. Without
        // this, every zero-scoring pair would still contribute 1/(k+rank),
        // which turns BM25 into a tie-break on array order.
        (bm25s[i] === 0 ? 0 : limits.bm25Weight / (limits.rrfK + rankOf(byBm25, i) + 1));
      return {
        pair: index.pairs[i]!,
        cosine: cosines[i] ?? 0,
        bm25: bm25s[i] ?? 0,
        rrf,
        missingTerms: missingTerms(question, stemSet(index.texts[i] ?? "")),
      };
    })
    .sort((a, b) => b.rrf - a.rrf || b.cosine - a.cosine);

  let best: ScoredPair | undefined;
  let blockedByCoverage = false;

  for (const candidate of ranked.slice(0, RERANK_DEPTH)) {
    if (best === undefined || candidate.cosine > best.cosine) best = candidate;
    if (candidate.cosine < limits.hedgedMin) continue;
    if (candidate.missingTerms.length > 0) {
      // Close enough to answer, about something else. This is the near-miss the
      // coverage guard exists for, and it is recorded as such so the gap list
      // can show WHY rather than just "no answer".
      blockedByCoverage = true;
      continue;
    }
    return {
      hit: true,
      mode: candidate.cosine >= limits.verbatimMin ? "verbatim" : "hedged",
      pair: candidate.pair,
      score: candidate.cosine,
      ranked,
    };
  }

  return {
    hit: false,
    reason: blockedByCoverage ? "coverage" : "below_threshold",
    ...(best === undefined ? {} : { best }),
    ranked,
  };
}

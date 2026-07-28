// BM25 — the lexical half of hybrid retrieval (§39.1).
//
// The embedding is good at concepts and blind to rare words. "Deira", "NICEIC",
// "Vaillant", a model number: those carry almost no concept mass and are hashed
// into the same 384 dimensions as everything else, so a question that turns on
// one of them can be out-ranked by a pair that shares only its shape. BM25
// inverts that — a term appearing in one pair out of two hundred gets a large
// IDF and dominates. Neither ranking is reliable alone, which is why both are
// computed and fused.
//
// k1 and b are the standard values. They are not tuned: with 150–250 pairs
// there is no held-out set to tune against, and inventing constants that look
// tuned would be worse than using the ones the literature settled on.

import { stem } from "./coverage.ts";
import type { Bm25Index } from "../types.ts";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0)
    .map(stem);
}

export function buildBm25(docs: readonly string[]): Bm25Index {
  const tf: Map<string, number>[] = [];
  const lengths: number[] = [];
  const df = new Map<string, number>();

  for (const doc of docs) {
    const counts = new Map<string, number>();
    const list = terms(doc);
    for (const t of list) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    tf.push(counts);
    lengths.push(list.length);
  }

  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    // Robertson/Sparck-Jones with the +1 that keeps a term present in every
    // document at a small positive weight rather than a negative one. A pack is
    // small and homogeneous; negative IDF would let common words push relevant
    // pairs DOWN the ranking.
    idf.set(term, Math.log(1 + (n - freq + 0.5) / (freq + 0.5)));
  }

  const avgLength = n === 0 ? 0 : lengths.reduce((a, b) => a + b, 0) / n;
  return { idf, tf, lengths, avgLength };
}

/** Score one document against the query. Comparable only within one query. */
export function bm25Score(index: Bm25Index, query: string, docIndex: number): number {
  const counts = index.tf[docIndex];
  if (counts === undefined) return 0;
  const len = index.lengths[docIndex] ?? 0;
  const avg = index.avgLength === 0 ? 1 : index.avgLength;
  let score = 0;
  for (const term of terms(query)) {
    const f = counts.get(term);
    if (f === undefined) continue;
    const idf = index.idf.get(term) ?? 0;
    score += (idf * (f * (BM25_K1 + 1))) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (len / avg)));
  }
  return score;
}

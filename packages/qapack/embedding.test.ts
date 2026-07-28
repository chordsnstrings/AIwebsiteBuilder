import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cosine,
  deserialiseEmbedding,
  EMBEDDING_DIMS,
  embedText,
  localEmbeddingProvider,
  serialiseEmbedding,
} from "./src/embedding.ts";

// The baseline the spec argues against: character-trigram Dice, i.e. exactly the
// fuzzy string matching §39.1 forbids substituting for embeddings.
function trigramDice(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const padded = ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
    const out = new Set<string>();
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
    return out;
  };
  const [x, y] = [grams(a), grams(b)];
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return (2 * shared) / (x.size + y.size);
}

function norm(vec: Float32Array): number {
  let sum = 0;
  for (const v of vec) sum += v * v;
  return Math.sqrt(sum);
}

describe("embedText", () => {
  it("produces a unit-length vector of the declared width", () => {
    const vec = embedText("What areas do you cover?");
    expect(vec.length).toBe(EMBEDDING_DIMS);
    expect(norm(vec)).toBeCloseTo(1, 5);
  });

  it("is stable for the same input within a process", () => {
    expect(Array.from(embedText("Are you insured?"))).toEqual(Array.from(embedText("Are you insured?")));
  });

  it("embeds the same input to the same vector in a fresh process", () => {
    const text = "Do you cover Deira and Al Barsha?";
    const modulePath = fileURLToPath(new URL("./src/embedding.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
    const script = `import { embedText } from ${JSON.stringify(modulePath)};` +
      `process.stdout.write(Array.from(embedText(${JSON.stringify(text)})).join(","));`;
    const out = execFileSync(tsx, ["-e", script], { encoding: "utf8" });
    expect(out).toBe(Array.from(embedText(text)).join(","));
  });

  it("normalises case and punctuation away", () => {
    expect(cosine(embedText("What areas do you cover?"), embedText("what areas do you cover"))).toBeCloseTo(1, 6);
  });

  it("returns a zero vector for empty input rather than throwing", () => {
    const vec = embedText("   ");
    expect(vec.length).toBe(EMBEDDING_DIMS);
    expect(norm(vec)).toBe(0);
  });
});

describe("cosine", () => {
  it("scores a vector against itself at 1", () => {
    const vec = embedText("Do you install boilers?");
    expect(cosine(vec, vec)).toBeCloseTo(1, 6);
  });

  it("scores the same question phrased differently far above string similarity", () => {
    // The whole reason the pack is embedded rather than fuzzy-matched: these two
    // are the same question and share almost no characters.
    const a = "Do you work in Deira?";
    const b = "What areas do you cover?";
    const semantic = cosine(embedText(a), embedText(b));
    expect(semantic).toBeGreaterThan(0.6);
    expect(semantic).toBeGreaterThan(trigramDice(a, b) * 2);
  });

  it("keeps two different published services apart, below the dedupe threshold", () => {
    const score = cosine(embedText("Do you offer gutter cleaning?"), embedText("Do you offer chimney repair?"));
    expect(score).toBeLessThan(0.95);
  });

  it("scores unrelated questions near zero", () => {
    expect(cosine(embedText("What are your opening hours?"), embedText("Do you offer gutter cleaning?"))).toBeLessThan(0.2);
  });

  it("throws on a dimension mismatch instead of returning a comparable number", () => {
    expect(() => cosine(new Float32Array(4), new Float32Array(8))).toThrow(/dimension mismatch/);
  });
});

describe("serialisation", () => {
  it("round-trips a vector exactly", () => {
    const vec = embedText("Can I pay by bank transfer?");
    expect(Array.from(deserialiseEmbedding(serialiseEmbedding(vec)))).toEqual(Array.from(vec));
  });

  it("writes float32 little-endian, 4 bytes per dimension", () => {
    const vec = embedText("How much do you charge?");
    const buf = serialiseEmbedding(vec);
    expect(buf.length).toBe(EMBEDDING_DIMS * 4);
    expect(buf.readFloatLE(0)).toBe(vec[0]);
    expect(buf.readFloatLE(4)).toBe(vec[1]);
  });

  it("rejects a buffer that is not a whole number of float32s", () => {
    expect(() => deserialiseEmbedding(Buffer.alloc(9))).toThrow(/multiple of 4/);
  });
});

describe("localEmbeddingProvider", () => {
  it("declares its identity and width so a swapped provider is detectable", () => {
    expect(localEmbeddingProvider.dims).toBe(EMBEDDING_DIMS);
    expect(localEmbeddingProvider.id).toMatch(/\S/);
  });

  it("embeds a batch in order", async () => {
    const texts = ["Are you insured?", "What are your opening hours?"];
    const vectors = await localEmbeddingProvider.embed(texts);
    expect(vectors).toHaveLength(2);
    expect(Array.from(vectors[0] ?? new Float32Array())).toEqual(Array.from(embedText(texts[0] ?? "")));
    expect(Array.from(vectors[1] ?? new Float32Array())).toEqual(Array.from(embedText(texts[1] ?? "")));
  });
});

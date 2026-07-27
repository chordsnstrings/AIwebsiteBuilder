// Model price card (USD per 1M tokens) — verified against the financial model's
// LLM_Routing tab, 25 July 2026. Re-verify quarterly; roughly a third moved in
// the last six months. Tokenizer factors are provisional until measured on the
// real corpus (see evals/corpora/tokenizer).
export interface ModelPrice {
  input: number; // $ per 1M input tokens
  output: number; // $ per 1M output tokens
  cachedIn?: number;
  tokenizerFactor: number;
}

export const PRICE_CARD: Record<string, ModelPrice> = {
  "modelark/seed-2-0-mini": { input: 0.06, output: 0.6, cachedIn: 0.01, tokenizerFactor: 1 },
  "modelark/deepseek-v4-flash": { input: 0.14, output: 0.28, cachedIn: 0.02, tokenizerFactor: 1 },
  "google/gemini-flash-lite": { input: 0.25, output: 1.5, cachedIn: 0.025, tokenizerFactor: 1 },
  "modelark/seed-2-0-lite": { input: 0.25, output: 2.0, cachedIn: 0.03, tokenizerFactor: 1 },
  "modelark/deepseek-v4-pro": { input: 0.45, output: 0.88, cachedIn: 0.06, tokenizerFactor: 1 },
  "modelark/seed-2-0-pro": { input: 0.67, output: 3.36, cachedIn: 0.08, tokenizerFactor: 1 },
  "modelark/seed-2-1-pro": { input: 1.1, output: 4.41, cachedIn: 0.13, tokenizerFactor: 1 },
  "modelark/glm-5-2": { input: 1.4, output: 4.4, cachedIn: 0.26, tokenizerFactor: 1 },
  "google/gemini-3-6-flash": { input: 1.5, output: 7.5, cachedIn: 0.15, tokenizerFactor: 1 },
  "google/gemini-3-1-pro": { input: 2.0, output: 12.0, cachedIn: 0.2, tokenizerFactor: 1 },
  "anthropic/sonnet-5": { input: 3.0, output: 15.0, cachedIn: 0.3, tokenizerFactor: 1.15 },
  "anthropic/opus-5": { input: 5.0, output: 25.0, cachedIn: 0.5, tokenizerFactor: 1.15 },
};

/** Cost in cents for a completion. Applies the tokenizer factor to output. */
export function priceFor(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICE_CARD[model] ?? { input: 1, output: 5, tokenizerFactor: 1 };
  const dollars = (tokensIn * p.input + tokensOut * p.output * p.tokenizerFactor) / 1_000_000;
  return dollars * 100;
}

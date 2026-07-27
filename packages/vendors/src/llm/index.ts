// The LLM rail capability. One normalized interface; three real adapter shapes
// (OpenAI-shape for ModelArk, Google, Anthropic) plus a deterministic mock rail.
// The gateway is the only caller. Model routing is decided upstream by the
// registry — a rail is handed an explicit model id, never a role.
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  model: string; // e.g. "modelark/seed-2-0-pro"
  messages: LlmMessage[];
  maxTokensOut: number;
  seed?: string;
  // Demo-mode deterministic responder. Ignored by real adapters. Its return is
  // JSON-serialised as the completion text.
  simulate?: () => unknown;
  // Explicit failure injection for escalation/first-pass-rate tests (mock only).
  failMode?: "parse" | "timeout" | "refuse";
}

export interface LlmResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

export interface LlmRail {
  readonly kind: "modelark" | "google" | "anthropic" | "mock";
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** Cheap liveness probe: a 2-token completion that validates response shape. */
  probe(model: string): Promise<boolean>;
}

export { MockLlmRail } from "./mock.ts";
export { OpenAiShapeRail } from "./adapters/openai-shape.ts";
export { GoogleRail } from "./adapters/google.ts";
export { AnthropicRail } from "./adapters/anthropic.ts";
export { resolveRail, railKind } from "./resolve.ts";
export { PRICE_CARD, priceFor, type ModelPrice } from "./pricing.ts";

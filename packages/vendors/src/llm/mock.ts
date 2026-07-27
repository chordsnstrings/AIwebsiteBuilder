// Deterministic mock LLM rail. In demo mode this stands in for every model. It
// is seeded by hash(model + input) so identical calls return identical output —
// which makes evals, gates and the escalation ladder reproducible. When a
// `simulate` responder is provided (the agent's demo behaviour) its JSON is
// returned; otherwise a generic acknowledgement is produced. Failure injection
// knobs exercise the escalation and first-pass-rate paths.
import { createHash } from "node:crypto";
import type { LlmRail, LlmRequest, LlmResponse } from "./index.ts";

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class MockLlmRail implements LlmRail {
  readonly kind = "mock" as const;

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (req.failMode === "timeout") {
      throw new Error("MOCK_TIMEOUT");
    }
    if (req.failMode === "refuse") {
      return this.wrap(req, "I can't help with that.");
    }

    let text: string;
    if (req.failMode === "parse") {
      text = "{ this is not valid json";
    } else if (req.simulate) {
      text = JSON.stringify(req.simulate());
    } else {
      const seed = createHash("sha256")
        .update(req.model + (req.seed ?? "") + req.messages.map((m) => m.content).join("\n"))
        .digest("hex")
        .slice(0, 8);
      text = `Acknowledged (${seed}).`;
    }
    return this.wrap(req, text);
  }

  private wrap(req: LlmRequest, text: string): LlmResponse {
    const tokensIn = req.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    return { text, tokensIn, tokensOut: estimateTokens(text), model: req.model };
  }

  async probe(): Promise<boolean> {
    return true;
  }
}

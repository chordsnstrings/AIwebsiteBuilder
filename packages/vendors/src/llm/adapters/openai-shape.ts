// OpenAI-compatible rail adapter — covers BytePlus ModelArk (Seed, GLM,
// DeepSeek, gpt-oss all reach one endpoint). This is one of the only places a
// vendor SDK may be imported (lint-enforced). The real HTTP call is behind a
// credential resolved at call time; with no credential the gateway never
// constructs this adapter (it uses the mock rail instead).
import type { LlmRail, LlmRequest, LlmResponse } from "../index.ts";

export interface OpenAiShapeConfig {
  baseUrl: string; // e.g. https://ark.ap-southeast.bytepluses.com/api/v3
  apiKey: string;
}

export class OpenAiShapeRail implements LlmRail {
  readonly kind = "modelark" as const;
  constructor(private readonly cfg: OpenAiShapeConfig) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // Wire format is the OpenAI Chat Completions shape. Kept minimal and
    // dependency-free (fetch) so no SDK is pinned.
    const modelId = req.model.split("/").slice(1).join("/") || req.model;
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: req.messages,
        max_tokens: req.maxTokensOut,
      }),
    });
    if (!res.ok) throw new Error(`modelark ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      text: data.choices[0]?.message.content ?? "",
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
      model: req.model,
    };
  }

  async probe(model: string): Promise<boolean> {
    try {
      await this.complete({ model, messages: [{ role: "user", content: "ok" }], maxTokensOut: 2 });
      return true;
    } catch {
      return false;
    }
  }
}

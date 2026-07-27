// Anthropic rail adapter — pinned on the CEO and Sentinel roles with no failover
// to the primary rail (spec §12.6: the control plane must not run on the rail it
// supervises). Vendor-SDK-boundary file. Minimal fetch-based implementation.
import type { LlmRail, LlmRequest, LlmResponse } from "../index.ts";

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
}

export class AnthropicRail implements LlmRail {
  readonly kind = "anthropic" as const;
  constructor(private readonly cfg: AnthropicConfig) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const base = this.cfg.baseUrl ?? "https://api.anthropic.com/v1";
    const modelId = req.model.split("/").slice(1).join("/") || req.model;
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: modelId, system, messages, max_tokens: req.maxTokensOut }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      content: { text: string }[];
      usage?: { input_tokens: number; output_tokens: number };
    };
    return {
      text: data.content[0]?.text ?? "",
      tokensIn: data.usage?.input_tokens ?? 0,
      tokensOut: data.usage?.output_tokens ?? 0,
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

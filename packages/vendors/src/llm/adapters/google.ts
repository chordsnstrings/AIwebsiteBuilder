// Google Gemini rail adapter (the independent fallback). Vendor-SDK-boundary
// file. Minimal fetch-based implementation; no credential ⇒ never constructed.
import type { LlmRail, LlmRequest, LlmResponse } from "../index.ts";

export interface GoogleConfig {
  apiKey: string;
  baseUrl?: string;
}

export class GoogleRail implements LlmRail {
  readonly kind = "google" as const;
  constructor(private readonly cfg: GoogleConfig) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const base = this.cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const modelId = req.model.split("/").slice(1).join("/") || req.model;
    const contents = req.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const res = await fetch(`${base}/models/${modelId}:generateContent?key=${this.cfg.apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: req.maxTokensOut } }),
    });
    if (!res.ok) throw new Error(`google ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      candidates: { content: { parts: { text: string }[] } }[];
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
    };
    return {
      text: data.candidates[0]?.content.parts[0]?.text ?? "",
      tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
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

// BytePlus ModelArk — Seedream (image) and Seedance (video).
//
// One of the few places a vendor wire format may be written (lint-enforced).
// Dependency-free `fetch`, same as the LLM rail, so no SDK is pinned.
//
// ⛔ `billable = true`. The mock says false. @adw/assets refuses to generate
// against a billable generator without a stored owner approval, and that flag
// is how it tells the difference — not an environment variable, which is the
// thing that is wrong in exactly the deployment where it matters.

import type { MediaGenerator, MediaRequest, MediaResult } from "./types.ts";

export interface ModelArkMediaConfig {
  baseUrl: string;
  apiKey: string;
  /** How long to wait for a video task before giving up. */
  taskTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 5_000;

export class ModelArkMediaGenerator implements MediaGenerator {
  readonly vendorId = "modelark";
  readonly billable = true;

  constructor(private readonly cfg: ModelArkMediaConfig) {}

  async generate(req: MediaRequest): Promise<MediaResult> {
    return req.kind === "image" ? this.image(req) : this.video(req);
  }

  private headers(req: MediaRequest): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.cfg.apiKey}`,
      // Sent whether or not the provider honours it. If it does, a retry after
      // a network timeout costs nothing; if it does not, the caller's own
      // idempotency row is still the backstop.
      "x-idempotency-key": req.idempotencyKey,
    };
  }

  private async image(req: MediaRequest): Promise<MediaResult> {
    const res = await fetch(`${this.cfg.baseUrl}/images/generations`, {
      method: "POST",
      headers: this.headers(req),
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        size: req.size ?? "2048x2048",
        response_format: "url",
        // ⛔ Watermarked. An AI image published in a business's name should
        // carry the provider's mark; the alternative is a picture nobody
        // downstream can tell from a photograph.
        watermark: true,
        ...(req.seed === undefined ? {} : { seed: req.seed }),
        ...(req.referenceUrl === undefined ? {} : { image: req.referenceUrl }),
      }),
    });
    if (!res.ok) throw new Error(`modelark image ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      model?: string;
      usage?: { total_tokens?: number };
      data?: { url?: string }[];
    };
    const url = data.data?.[0]?.url;
    if (typeof url !== "string" || url.length === 0) {
      // ⛔ A 200 with no image is a failure. The LLM rail learned this the hard
      // way — HTTP 200 with empty content read as success for weeks.
      throw new Error("modelark image returned 200 with no url");
    }
    return {
      url,
      kind: "image",
      model: data.model ?? req.model,
      provenance: "ai_generated",
      tokens: data.usage?.total_tokens ?? 0,
    };
  }

  private async video(req: MediaRequest): Promise<MediaResult> {
    // Seedance takes its parameters as flags inside the prompt text.
    const flags = [
      req.aspectRatio === undefined ? "" : `--ratio ${req.aspectRatio}`,
      req.durationSeconds === undefined ? "" : `--duration ${req.durationSeconds}`,
      "--watermark true",
      req.seed === undefined ? "" : `--seed ${req.seed}`,
    ].filter((f) => f.length > 0);
    const content: unknown[] = [{ type: "text", text: `${req.prompt} ${flags.join(" ")}`.trim() }];
    if (req.referenceUrl !== undefined) {
      content.push({ type: "image_url", image_url: { url: req.referenceUrl } });
    }

    const created = await fetch(`${this.cfg.baseUrl}/contents/generations/tasks`, {
      method: "POST",
      headers: this.headers(req),
      body: JSON.stringify({ model: req.model, content }),
    });
    if (!created.ok) throw new Error(`modelark video ${created.status}: ${await created.text()}`);
    const task = (await created.json()) as { id?: string };
    const taskId = task.id;
    if (typeof taskId !== "string") throw new Error("modelark video returned no task id");

    const deadline = Date.now() + (this.cfg.taskTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    const sleep = this.cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // ⛔ Bounded. An unbounded poll on a task the provider has silently dropped
    // holds a worker slot forever, and the symptom is a queue that stops moving
    // with nothing in the logs.
    for (;;) {
      const res = await fetch(`${this.cfg.baseUrl}/contents/generations/tasks/${taskId}`, {
        headers: { authorization: `Bearer ${this.cfg.apiKey}` },
      });
      if (!res.ok) throw new Error(`modelark task ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as {
        status?: string;
        error?: { message?: string };
        content?: { video_url?: string };
        usage?: { total_tokens?: number };
      };
      const status = body.status ?? "unknown";
      if (status === "succeeded") {
        const url = body.content?.video_url;
        if (typeof url !== "string" || url.length === 0) {
          throw new Error("modelark video succeeded with no url");
        }
        return {
          url, kind: "video", model: req.model, provenance: "ai_generated",
          tokens: body.usage?.total_tokens ?? 0, providerTaskId: taskId,
        };
      }
      if (status === "failed" || status === "cancelled") {
        throw new Error(`modelark video ${status}: ${body.error?.message ?? "no detail"}`);
      }
      if (Date.now() >= deadline) throw new Error(`modelark video task ${taskId} timed out in state "${status}"`);
      await sleep(this.cfg.pollIntervalMs ?? DEFAULT_POLL_MS);
    }
  }
}

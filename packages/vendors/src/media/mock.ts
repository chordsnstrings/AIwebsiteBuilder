// The simulator. Deterministic, free, and honest about being free.
//
// ⛔ `billable = false` is the single most important line in this file.
// @adw/assets refuses to generate against a BILLABLE generator without a stored
// owner approval; if the mock claimed to be billable the demo would demand
// approvals it cannot get, and if the real one claimed not to be, a deployment
// with a live key would generate unapproved paid assets. The flag lives on the
// adapter rather than on an environment variable precisely because the
// environment variable is the thing that is wrong in the deployment where it
// matters.

import { createHash } from "node:crypto";
import type { MediaGenerator, MediaRequest, MediaResult } from "./types.ts";

export class MockMediaGenerator implements MediaGenerator {
  readonly vendorId = "modelark_mock";
  readonly billable = false;

  private readonly issued = new Map<string, MediaResult>();

  async generate(req: MediaRequest): Promise<MediaResult> {
    const replay = this.issued.get(req.idempotencyKey);
    if (replay !== undefined) return replay;
    const digest = createHash("sha256").update(`${req.idempotencyKey}|${req.prompt}`).digest("hex").slice(0, 16);
    const result: MediaResult = {
      // A data: URL, so a demo run needs no network and stores real bytes.
      url: req.kind === "image" ? pngDataUrl(digest) : mp4DataUrl(digest),
      kind: req.kind,
      model: req.model,
      provenance: "ai_generated",
      tokens: 0,
    };
    this.issued.set(req.idempotencyKey, result);
    return result;
  }

  /** Test hook: what has been asked for. */
  requests(): number {
    return this.issued.size;
  }
}

/** A 1×1 PNG, tinted by the digest so two prompts differ byte-for-byte. */
function pngDataUrl(digest: string): string {
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex"),
    Buffer.from("0000000a4944415478da63" + digest.slice(0, 6) + "0001", "hex"),
    Buffer.from("0000000049454e44ae426082", "hex"),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** A minimal MP4 container header. Not playable; it is a placeholder with a
 *  correct magic number so the sniffing layer classifies it as video. */
function mp4DataUrl(digest: string): string {
  const mp4 = Buffer.concat([
    Buffer.from("0000001c667479706d70343200000000", "hex"),
    Buffer.from("6d70343269736f6d", "hex"),
    Buffer.from(digest, "hex"),
  ]);
  return `data:video/mp4;base64,${mp4.toString("base64")}`;
}

let singleton: MockMediaGenerator | null = null;
export function getMediaGenerator(): MockMediaGenerator {
  if (singleton === null) singleton = new MockMediaGenerator();
  return singleton;
}

export function resetMediaGenerator(): void {
  singleton = null;
}

// The MediaGenerator capability — image and video from a prompt.
//
// ⛔ Unlike every other vendor capability in this package, a call here SPENDS
// MONEY PER CALL on a per-asset basis rather than per token, and the spend is
// not recoverable. Every guard in @adw/assets exists because of that: approval
// before generation, a hard per-customer cap checked before the call, and an
// idempotency key so a retried request cannot be charged twice.
//
// ⛔ And a generated image is NOT a photograph. The adapter returns
// `provenance: "ai_generated"` on every result and there is no field a caller
// can set to say otherwise, because an AI render of a finished roof placed in a
// roofer's "our work" gallery is a false statement about work they did.

export type MediaKind = "image" | "video";

export interface MediaRequest {
  kind: MediaKind;
  prompt: string;
  /** Provider model id, e.g. "seedream-5-0-260128". */
  model: string;
  /** "1024x1024" for images; ignored for video. */
  size?: string | undefined;
  /** Seconds. Video only. */
  durationSeconds?: number | undefined;
  aspectRatio?: string | undefined;
  /** Deterministic re-generation, where the provider supports it. */
  seed?: number | undefined;
  /** A reference image URL, for image-to-image or image-to-video. */
  referenceUrl?: string | undefined;
  /** Provider-side idempotency, where supported. Always sent. */
  idempotencyKey: string;
}

export interface MediaResult {
  /** Downloadable URL, generally short-lived — callers must persist the bytes. */
  url: string;
  kind: MediaKind;
  model: string;
  /** ⛔ Always "ai_generated". Not a parameter, not overridable. */
  provenance: "ai_generated";
  /** Provider-reported cost signal where available; 0 when unknown. */
  tokens: number;
  providerTaskId?: string | undefined;
}

export interface MediaGenerator {
  readonly vendorId: string;
  /** True when this generator will actually reach a paid API. */
  readonly billable: boolean;
  generate(req: MediaRequest): Promise<MediaResult>;
}

/**
 * Cost per asset in integer minor units (USD cents).
 *
 * ⛔ Deliberately a table of CEILINGS rather than the provider's exact price. A
 * cap enforced against an underestimate is not a cap, and the failure mode of
 * over-estimating is that a customer is asked to approve slightly more than
 * they are charged — which is the safe direction.
 */
export const MEDIA_COST_CEILING_CENTS: Record<string, number> = {
  "seedream-5-0-260128": 6,
  "seedream-4-0-250828": 4,
  "seedance-1-0-pro-fast-251015": 120,
  "seedance-1-0-lite-t2v-250428": 60,
};

export const DEFAULT_MEDIA_MODELS: Record<MediaKind, string> = {
  image: "seedream-5-0-260128",
  video: "seedance-1-0-pro-fast-251015",
};

/** Ceiling for a model we do not have a price for. ⛔ Pessimistic on purpose. */
export const UNKNOWN_MODEL_CEILING_CENTS = 200;

export function costCeilingCents(model: string): number {
  return MEDIA_COST_CEILING_CENTS[model] ?? UNKNOWN_MODEL_CEILING_CENTS;
}

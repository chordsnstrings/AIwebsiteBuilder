// Visual-regression surface (spec §59). There is no screenshot differ in the
// build; the guarantee instead comes from content hashing every fixture render.
// A template change that alters any shipped document changes that document's
// hash, and the diff shows up as a failing hash in review rather than as a
// surprise on a customer's live site.
//
// Bump SNAPSHOT_VERSION when a change to the renderer is intentional and the
// stored hashes are expected to move — that bump is the reviewable signal.
import { createHash } from "node:crypto";
import { RENDER_FIXTURES, renderFixture, type RenderFixture } from "./fixtures/index.ts";
import { weightKb } from "./render.ts";

export const SNAPSHOT_VERSION = "site-templates-snapshot-v1";

export interface RenderSnapshot {
  id: string;
  html: string;
  contentHash: string;
  weightKb: number;
}

/** sha256 of a rendered document, hex. */
export function contentHash(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}

/** Render one fixture and hash it. */
export function snapshotFixture(f: RenderFixture): RenderSnapshot {
  const html = renderFixture(f);
  return { id: f.id, html, contentHash: contentHash(html), weightKb: weightKb(html) };
}

/**
 * Render every fixture. Deterministic: no clock, no randomness, fixture order
 * fixed, so two runs on the same source produce identical hashes.
 */
export function renderAllFixtures(): RenderSnapshot[] {
  return RENDER_FIXTURES.map(snapshotFixture);
}

export interface SnapshotManifest {
  version: string;
  entries: { id: string; contentHash: string; weightKb: number }[];
  /** One hash over the whole suite — the single number a reviewer compares. */
  suiteHash: string;
}

/** The hash-only manifest (no HTML bodies), suitable for storing next to a build. */
export function snapshotManifest(): SnapshotManifest {
  const entries = renderAllFixtures().map((s) => ({
    id: s.id,
    contentHash: s.contentHash,
    weightKb: s.weightKb,
  }));
  const suiteHash = createHash("sha256")
    .update(SNAPSHOT_VERSION)
    .update(entries.map((e) => `${e.id}:${e.contentHash}`).join("\n"))
    .digest("hex");
  return { version: SNAPSHOT_VERSION, entries, suiteHash };
}

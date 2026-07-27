// WCAG relative-luminance contrast, used by the a11y baseline attached to every
// render fixture. Deterministic maths over the family's colour tokens — the
// accessibility claim is checked in CI, not asserted in prose.
import type { ColorSystem } from "./types.ts";

/** Text colour the renderer paints on top of `primary` (CTA button / header chip). */
export const ON_PRIMARY = "#ffffff";

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA threshold for normal-size body text. */
export const AA_CONTRAST_MIN = 4.5;

/**
 * Resolve a fixture's contrast-pair name (e.g. `"primary:surface"`) against a
 * colour system. `onPrimary` is the fixed white the CTA paints on `primary`.
 */
export function resolveContrastPair(cs: ColorSystem, pair: string): [string, string] {
  const parts = pair.split(":");
  if (parts.length !== 2) throw new Error(`contrast pair must be "a:b", got ${pair}`);
  const pick = (token: string): string => {
    switch (token) {
      case "primary":
        return cs.primary;
      case "accent":
        return cs.accent;
      case "surface":
        return cs.surface;
      case "text":
        return cs.text;
      case "onPrimary":
        return ON_PRIMARY;
      default:
        throw new Error(`unknown colour token ${token}`);
    }
  };
  return [pick(parts[0]!), pick(parts[1]!)];
}

/** Contrast ratio for a named pair against a colour system. */
export function pairContrast(cs: ColorSystem, pair: string): number {
  const [a, b] = resolveContrastPair(cs, pair);
  return contrastRatio(a, b);
}

// Localisation tests (spec §60). The point of these is the failure mode: a legal
// string must never be produced by guesswork. Missing locale, missing key or an
// unfilled placeholder all raise — none of them quietly ship English.
import { describe, expect, it } from "vitest";
import {
  LEGAL_BLOCK_KEYS,
  LEGAL_LAYERS,
  MODEL_GENERATED_LAYERS,
  MissingLegalTextError,
  NEVER_MODEL_GENERATED_LAYERS,
  RTL_LOCALES,
  hasBidiControls,
  isRtlLocale,
  legalBlock,
  legalLayer,
  legalLocales,
  localeVariants,
  localesMissingLegalText,
  normalizeBidi,
} from "./src/index.ts";

describe("the four text layers", () => {
  it("documents all four and which of them a model may write", () => {
    expect(LEGAL_LAYERS).toHaveLength(4);
    expect(LEGAL_LAYERS.map((l) => l.id).sort()).toEqual([
      "conversation",
      "legal_text",
      "site_copy",
      "ui_strings",
    ]);
    // Site copy and conversation are model-generated.
    expect([...MODEL_GENERATED_LAYERS].sort()).toEqual(["conversation", "site_copy"]);
    // Legal text and UI strings never are.
    expect([...NEVER_MODEL_GENERATED_LAYERS].sort()).toEqual(["legal_text", "ui_strings"]);
    expect(legalLayer("legal_text").modelGenerated).toBe(false);
    expect(legalLayer("site_copy").modelGenerated).toBe(true);
    for (const layer of LEGAL_LAYERS) {
      expect(layer.source.length).toBeGreaterThan(0);
      expect(layer.rationale.length).toBeGreaterThan(0);
    }
  });
});

describe("legalBlock substitutes variables", () => {
  it("fills {entity}, {unsub_url} and friends from the caller's vars", () => {
    const text = legalBlock("en-US", "unsubscribe", {
      unsub_url: "https://app.adwsites.com/u/abc123",
    });
    expect(text).toContain("https://app.adwsites.com/u/abc123");
    expect(text).not.toContain("{unsub_url}");

    const disclaimer = legalBlock("en-GB", "preview_disclaimer", { entity: "Contoso Studios Ltd" });
    expect(disclaimer).toContain("Contoso Studios Ltd");
    expect(disclaimer).not.toContain("{entity}");
  });

  it("falls back only to the reviewed defaults in config/legal_text.yaml", () => {
    // No entity passed: the PR-gated default is used, not a guess and not a model.
    const disclaimer = legalBlock("en-US", "preview_disclaimer", {});
    expect(disclaimer).toContain("ADW Foundry Ltd");
    expect(disclaimer).not.toMatch(/\{[a-z_]+\}/);
  });

  it("renders every declared key for every declared locale", () => {
    const locales = legalLocales();
    expect(locales).toEqual(["en-AU", "en-GB", "en-US"]);
    for (const locale of locales) {
      for (const key of LEGAL_BLOCK_KEYS) {
        const text = legalBlock(locale, key, { unsub_url: "https://app.adwsites.com/u/x" });
        expect(text.length, `${locale}/${key}`).toBeGreaterThan(0);
        expect(text, `${locale}/${key}`).not.toMatch(/\{[a-z_]+\}/);
      }
    }
  });

  it("keeps jurisdictions distinct — en-GB is not en-US", () => {
    const us = legalBlock("en-US", "unsubscribe", { unsub_url: "https://app.adwsites.com/u/x" });
    const gb = legalBlock("en-GB", "unsubscribe", { unsub_url: "https://app.adwsites.com/u/x" });
    const au = legalBlock("en-AU", "unsubscribe", { unsub_url: "https://app.adwsites.com/u/x" });
    expect(new Set([us, gb, au]).size).toBe(3);
    expect(gb).toContain("corporate subscriber");
  });
});

describe("legalBlock fails closed", () => {
  it("throws on a missing locale instead of falling back to English", () => {
    expect(() => legalBlock("de-DE", "unsubscribe", { unsub_url: "https://x.test/u" })).toThrow(
      MissingLegalTextError,
    );
    expect(() => legalBlock("fr-FR", "guarantee", {})).toThrow(MissingLegalTextError);
    expect(() => legalBlock("", "guarantee", {})).toThrow(MissingLegalTextError);
    // And the message says which locale, so the failure is diagnosable.
    expect(() => legalBlock("de-DE", "unsubscribe", {})).toThrow(/de-DE/);
  });

  it("throws rather than shipping an unfilled placeholder", () => {
    // The unsubscribe block needs {unsub_url}; there is no default for it.
    expect(() => legalBlock("en-US", "unsubscribe", {})).toThrow(MissingLegalTextError);
    expect(() => legalBlock("en-US", "unsubscribe", {})).toThrow(/unsub_url/);
    // An empty string is not a value.
    expect(() => legalBlock("en-US", "unsubscribe", { unsub_url: "" })).toThrow(MissingLegalTextError);
  });

  it("throws on an unknown layer id", () => {
    // @ts-expect-error — deliberately out of the union, to prove the runtime guard exists.
    expect(() => legalLayer("marketing_email")).toThrow(MissingLegalTextError);
  });
});

describe("bidi handling", () => {
  it("recognises right-to-left locales", () => {
    expect(isRtlLocale("ar-AE")).toBe(true);
    expect(isRtlLocale("ar")).toBe(true);
    expect(isRtlLocale("he-IL")).toBe(true);
    expect(isRtlLocale("fa-IR")).toBe(true);
    expect(isRtlLocale("ur-PK")).toBe(true);
    expect(isRtlLocale("AR-ae")).toBe(true);
    expect(isRtlLocale("ar_EG")).toBe(true);
    expect(isRtlLocale("en-US")).toBe(false);
    expect(isRtlLocale("en-GB")).toBe(false);
    expect(isRtlLocale("de-DE")).toBe(false);
    expect(RTL_LOCALES).toContain("ar");
    expect(RTL_LOCALES).toContain("he");
    expect(RTL_LOCALES).not.toContain("en");
  });

  it("strips the RTL override and other bidi controls", () => {
    // U+202E is the classic display-spoofing character.
    const spoofed = "Unsubscribe ‮gro.recnac//:sptth";
    expect(hasBidiControls(spoofed)).toBe(true);
    const cleaned = normalizeBidi(spoofed);
    expect(cleaned).not.toContain("‮");
    expect(hasBidiControls(cleaned)).toBe(false);
    expect(cleaned).toBe("Unsubscribe gro.recnac//:sptth");

    // Every control in the class goes.
    for (const ch of ["؜", "​", "‎", "‏", "‪", "‭", "⁦", "⁩", "﻿"]) {
      expect(normalizeBidi(`a${ch}b`), `U+${ch.codePointAt(0)!.toString(16)}`).toBe("ab");
    }
  });

  it("leaves genuine right-to-left script completely intact", () => {
    const arabic = "مرحبا بالعالم";
    expect(normalizeBidi(arabic)).toBe(arabic);
    expect(hasBidiControls(arabic)).toBe(false);
    expect(arabic).toHaveLength(13); // nothing dropped, nothing normalised away

    const hebrew = "שלום עולם";
    expect(normalizeBidi(hebrew)).toBe(hebrew);

    // Arabic text carrying an override: script survives, control does not.
    const mixed = `‮${arabic}`;
    expect(normalizeBidi(mixed)).toBe(arabic);

    // Plain text is untouched.
    expect(normalizeBidi("Reply STOP to opt out.")).toBe("Reply STOP to opt out.");
    expect(normalizeBidi("")).toBe("");
  });
});

describe("locale variants per template family", () => {
  it("reads the shipped locales from config/templates.yaml", () => {
    expect(localeVariants("trades")).toEqual(["en-US", "en-GB", "en-AU"]);
    expect(localeVariants("personal_services")).toEqual(["en-US", "en-GB", "en-AU"]);
    expect(localeVariants("food_hospitality")).toEqual(["en-US", "en-GB", "en-AU"]);
  });

  it("throws for a family that does not exist", () => {
    expect(() => localeVariants("aerospace")).toThrow(MissingLegalTextError);
  });

  it("confirms every shipped family locale has reviewed legal text", () => {
    for (const family of ["trades", "personal_services", "food_hospitality"]) {
      expect(localesMissingLegalText(family), family).toEqual([]);
    }
  });
});

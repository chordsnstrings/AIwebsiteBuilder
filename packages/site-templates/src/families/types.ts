// Template-family data model (spec §59). A family is DATA, not code: layouts,
// section order, colour systems, type pairings and per-slot copy guidance. The
// single renderer in ../render.ts consumes these, so adding a family is adding a
// data file — never copying a renderer.

/** Layout variants shipped across the families. Each renders a different section order/markup. */
export type LayoutId =
  | "hero-services-about-contact"
  | "hero-gallery-contact"
  | "hero-menu-about-contact";

/** The copy slots a model is allowed to fill (char ranges live in config/templates.yaml). */
export type CopySlotName = "headline" | "service_blurb" | "about" | "cta";

/** A colour system is four tokens; the renderer emits them as CSS custom properties. */
export interface ColorSystem {
  id: string;
  primary: string;
  accent: string;
  surface: string;
  text: string;
}

/** A type pairing is two font stacks plus a modular scale ratio. System stacks only — no external font requests. */
export interface TypePairing {
  id: string;
  headingStack: string;
  bodyStack: string;
  scale: number;
}

export interface TemplateFamily {
  id: string;
  label: string;
  layouts: LayoutId[];
  /** Default section order (the family's first layout). */
  sectionOrder: string[];
  tokens: { colorSystems: ColorSystem[]; typePairings: TypePairing[] };
  copyGuidance: Record<CopySlotName, string>;
}

/** Section order per layout. The renderer walks this list — layouts are not `if` branches over one blob. */
export const LAYOUT_SECTIONS: Record<LayoutId, readonly string[]> = {
  "hero-services-about-contact": ["hero", "services", "about", "contact"],
  "hero-gallery-contact": ["hero", "gallery", "contact"],
  "hero-menu-about-contact": ["hero", "menu", "about", "contact"],
};

/** The layout `renderSite` uses when no family/layout is supplied (pre-§59 behaviour). */
export const DEFAULT_LAYOUT: LayoutId = "hero-services-about-contact";

/** Raised when a caller asks for a colour system / type pairing / layout the family does not have. */
export class TemplateVariantError extends Error {}

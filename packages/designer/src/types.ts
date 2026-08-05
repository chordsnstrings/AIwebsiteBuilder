// The design manifest — what the Designer decides, before a line of CSS exists.
//
// It is deliberately small and structured. A design decision that lives inside
// a 19KB prose brief cannot be stored, compared, or checked for repetition; one
// that is nine fields can be all three. That is the whole reason this step is
// separate from generation.

export type HeroArchetype = "split" | "stage" | "frame" | "typographic" | "ledger";
export type MotionVocabulary = "still" | "hairline" | "measured" | "photographic" | "mechanical";
export type Density = "airy" | "balanced" | "dense";

export interface TypePairing {
  id: string;
  display: string;
  text: string;
  note?: string;
}

export interface PaletteDecision {
  /** `brand_derived` when extraction found something; otherwise the vertical's
   *  register default — and the site must SAY which in a comment. */
  strategy: "brand_derived" | "register_default";
  seed?: string | undefined;
  /** Where the accent is permitted to appear. The §3 budget caps the area; this
   *  names the elements, so a reviewer can see the intent as well as the number. */
  accentUsage: string[];
}

export interface DesignManifest {
  id?: string;
  businessId: string;
  vertical: string;
  heroArchetype: HeroArchetype;
  typePairing: TypePairing;
  motion: MotionVocabulary;
  parallax: boolean;
  density: Density;
  palette: PaletteDecision;
  /** Section order below the hero. Varying it is most of what stops two sites
   *  in one vertical reading as the same page with different words. */
  sectionOrder: string[];
  /** One or two sentences. Stored, not just emitted into a CSS comment — the
   *  reasoning is what a human reviews when a design is questioned later. */
  rationale: string;
  catalogueVersion: string;
}

/** ⛔ A design token absent from config/design-catalogue.yaml. */
export class DesignCatalogueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignCatalogueError";
  }
}

/** ⛔ A manifest that repeats a recent one in the same vertical. */
export class DesignRepetitionError extends Error {
  constructor(
    message: string,
    readonly clash: { heroArchetype: string; typePairing: string },
  ) {
    super(message);
    this.name = "DesignRepetitionError";
  }
}

export interface DesignerInput {
  businessId: string;
  vertical: string;
  businessName: string;
  /** Free text the Designer reads for register cues — what they actually do,
   *  how they talk about it. Never used to invent facts. */
  about: string;
  brandPrimary?: string | undefined;
  brandSecondary?: string | undefined;
  /** How many usable photographs exist. Zero forces a photography-free
   *  archetype, whatever the register would otherwise prefer. */
  imageCount: number;
  /** True when the trade publishes real figures — pushes toward `ledger`. */
  publishesPrices: boolean;
  /** Prior choices in this vertical, newest first, for the diversity guard. */
  history?: { heroArchetype: string; typePairingId: string }[];
}

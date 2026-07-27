// Trades family (spec §59). Plumbers, sparkies, roofers: the buyer wants a phone
// number, a price signal and proof you turn up. Layouts lead with the call to
// action; the gallery variant exists for trades whose work photographs well.
import type { TemplateFamily } from "./types.ts";

export const trades: TemplateFamily = {
  id: "trades",
  label: "Trades",
  layouts: ["hero-services-about-contact", "hero-gallery-contact"],
  sectionOrder: ["hero", "services", "about", "contact"],
  tokens: {
    // Six colour systems. Every `primary` clears 4.5:1 against white so the CTA
    // button and link text are AA at body size (see contrast.ts + the a11y baseline).
    colorSystems: [
      { id: "steel-blue", primary: "#14496b", accent: "#8a3f06", surface: "#ffffff", text: "#12202c" },
      { id: "slate-copper", primary: "#2f4858", accent: "#7d3f1f", surface: "#f7f7f5", text: "#1b2830" },
      { id: "deep-navy", primary: "#123057", accent: "#6d4610", surface: "#ffffff", text: "#0f1c2e" },
      { id: "forest-brass", primary: "#1f4634", accent: "#6b4d0f", surface: "#f6f8f6", text: "#14251c" },
      { id: "graphite-amber", primary: "#33383d", accent: "#6f4900", surface: "#fafafa", text: "#1c1f22" },
      { id: "oxide-teal", primary: "#0e4f52", accent: "#7a3a18", surface: "#ffffff", text: "#10262a" },
    ],
    // Four type pairings. System stacks only — a generated site makes zero external requests.
    typePairings: [
      {
        id: "condensed-workhorse",
        headingStack: '"Arial Narrow",Helvetica,Arial,sans-serif',
        bodyStack: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
        scale: 1.25,
      },
      {
        id: "grotesk-plain",
        headingStack: '"Helvetica Neue",Helvetica,Arial,sans-serif',
        bodyStack: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
        scale: 1.2,
      },
      {
        id: "slab-utility",
        headingStack: 'Rockwell,"Roboto Slab",Georgia,serif',
        bodyStack: '"Segoe UI",system-ui,-apple-system,Roboto,sans-serif',
        scale: 1.333,
      },
      {
        id: "system-native",
        headingStack: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
        bodyStack: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
        scale: 1.2,
      },
    ],
  },
  copyGuidance: {
    headline: "Trade + city + the outcome the customer wants. No superlatives, no awards you cannot evidence.",
    service_blurb: "One concrete job type, what is included, and the turnaround. Plain language a homeowner uses.",
    about: "Years in the area, licensing/insurance if stated in the source record, and who actually shows up. Never invent credentials.",
    cta: "An action, not a slogan: request a quote, book a call-out, check availability.",
  },
};

// Personal services family (spec §59). Salons, spas, trainers, groomers: the
// buyer is choosing a person, so the gallery layout is a first-class variant and
// the copy guidance pushes towards specifics over adjectives.
import type { TemplateFamily } from "./types.ts";

export const personalServices: TemplateFamily = {
  id: "personal_services",
  label: "Personal services",
  layouts: ["hero-services-about-contact", "hero-gallery-contact"],
  sectionOrder: ["hero", "services", "about", "contact"],
  tokens: {
    colorSystems: [
      { id: "plum-blush", primary: "#6b2359", accent: "#8a2f4a", surface: "#fdf8fb", text: "#2a1425" },
      { id: "rose-sand", primary: "#8a2f4a", accent: "#6f4620", surface: "#fffaf7", text: "#2e1620" },
      { id: "sage-clay", primary: "#2c4a37", accent: "#7d4325", surface: "#f9fbf8", text: "#1a2a20" },
      { id: "indigo-peony", primary: "#333369", accent: "#7d2c50", surface: "#fbfaff", text: "#1e1e38" },
      { id: "mocha-rose", primary: "#5a3826", accent: "#8a2f45", surface: "#fdfaf7", text: "#2b1d14" },
      { id: "teal-orchid", primary: "#14555a", accent: "#6b3364", surface: "#f7fcfc", text: "#10282b" },
    ],
    typePairings: [
      {
        id: "serif-editorial",
        headingStack: 'Georgia,"Times New Roman",Times,serif',
        bodyStack: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
        scale: 1.333,
      },
      {
        id: "humanist-soft",
        headingStack: '"Segoe UI",Optima,Candara,system-ui,sans-serif',
        bodyStack: '"Segoe UI",system-ui,-apple-system,Roboto,sans-serif',
        scale: 1.25,
      },
      {
        id: "geometric-clean",
        headingStack: 'Futura,"Century Gothic","Trebuchet MS",system-ui,sans-serif',
        bodyStack: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
        scale: 1.2,
      },
      {
        id: "didone-accent",
        headingStack: 'Didot,"Bodoni MT","Playfair Display",Georgia,serif',
        bodyStack: 'Verdana,system-ui,-apple-system,"Segoe UI",sans-serif',
        scale: 1.414,
      },
    ],
  },
  copyGuidance: {
    headline: "Service + city + who it is for. Say the treatment, not the vibe.",
    service_blurb: "Treatment name, roughly how long it takes, and who it suits. No medical or outcome claims.",
    about: "How long the studio has operated, the team size, and the booking rhythm. Never claim certifications absent from the source record.",
    cta: "Book, check availability, or ask about a slot — one clear next step.",
  },
};

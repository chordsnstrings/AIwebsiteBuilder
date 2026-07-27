// Food & hospitality family (spec §59). Cafés, bakeries, bars: the page is a
// menu with a map link attached, so this family's default layout is the menu
// variant and the gallery variant carries the room/food photography.
import type { TemplateFamily } from "./types.ts";

export const foodHospitality: TemplateFamily = {
  id: "food_hospitality",
  label: "Food & hospitality",
  layouts: ["hero-menu-about-contact", "hero-gallery-contact"],
  sectionOrder: ["hero", "menu", "about", "contact"],
  tokens: {
    colorSystems: [
      { id: "tomato-cream", primary: "#8f2a1e", accent: "#6b4f10", surface: "#fffdf7", text: "#2c140f" },
      { id: "olive-ember", primary: "#414a1c", accent: "#8a3d13", surface: "#fbfbf4", text: "#232712" },
      { id: "espresso-gold", primary: "#43291a", accent: "#6b4d0c", surface: "#fdfaf5", text: "#241609" },
      { id: "basil-brick", primary: "#1f4d34", accent: "#8a3220", surface: "#f7fcf8", text: "#12281c" },
      { id: "merlot-wheat", primary: "#6b1f38", accent: "#6f4c10", surface: "#fffaf9", text: "#2a0f1c" },
      { id: "charcoal-saffron", primary: "#2c2c2c", accent: "#6f4800", surface: "#fafaf8", text: "#1a1a1a" },
    ],
    typePairings: [
      {
        id: "menu-serif",
        headingStack: '"Palatino Linotype",Palatino,Georgia,serif',
        bodyStack: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
        scale: 1.333,
      },
      {
        id: "chalkboard-sans",
        headingStack: '"Trebuchet MS",Tahoma,Verdana,system-ui,sans-serif',
        bodyStack: 'Verdana,Tahoma,system-ui,-apple-system,sans-serif',
        scale: 1.25,
      },
      {
        id: "market-slab",
        headingStack: 'Rockwell,"Roboto Slab","Courier New",Georgia,serif',
        bodyStack: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
        scale: 1.2,
      },
      {
        id: "bistro-mixed",
        headingStack: 'Baskerville,"Times New Roman",Georgia,serif',
        bodyStack: '"Segoe UI",system-ui,-apple-system,Roboto,sans-serif',
        scale: 1.414,
      },
    ],
  },
  copyGuidance: {
    headline: "What you serve + the neighbourhood. Name the food, not the ambience.",
    service_blurb: "A menu section or signature item, what is in it, and when it is available. No allergen or dietary claims.",
    about: "Opening year, who cooks, and the room. Never invent awards, ratings or press mentions.",
    cta: "See the menu, book a table, or order ahead — one action.",
  },
};

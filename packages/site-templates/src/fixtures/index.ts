// Deterministic render fixtures (spec §59). Twenty documents spanning the three
// families, every layout variant and all three locales. They are the input to
// the visual-regression hashes AND the corpus the reviewer gate runs against in
// CI: if a template change breaks a gate, it breaks here first.
//
// Nothing in this file is model-generated. The copy is fixed text that sits
// inside the slot ranges in config/templates.yaml, so `validateSlots` passes for
// every fixture and a slot-range change fails the suite loudly.
import { FAMILIES } from "../families/index.ts";
import type { LayoutId, TemplateFamily } from "../families/types.ts";
import { renderSite, type BusinessRecord, type CopySlots } from "../render.ts";

/**
 * The accessibility floor each fixture must hold. axe counts are hard zeroes
 * (the reviewer gate fails on any critical or serious finding); the contrast
 * pairs name colour tokens resolved against the fixture's colour system and
 * checked with the WCAG maths in ../families/contrast.ts.
 */
export interface A11yBaseline {
  axeCriticalMax: 0;
  axeSeriousMax: 0;
  minContrastPairs: string[];
}

export interface RenderFixture {
  id: string;
  familyId: string;
  layout: LayoutId;
  locale: string;
  colorSystem: string;
  typePairing: string;
  mode: "preview" | "full";
  business: BusinessRecord;
  copy: CopySlots;
  a11y: A11yBaseline;
}

/** Every fixture holds the same floor: no axe critical/serious, AA on the text pairs. */
const BASELINE: A11yBaseline = {
  axeCriticalMax: 0,
  axeSeriousMax: 0,
  minContrastPairs: ["text:surface", "primary:surface", "accent:surface", "onPrimary:primary"],
};

/** Fixed render inputs shared by every fixture — no clocks, no randomness. */
export const FIXTURE_FORM_ACTION = "https://app.adwsites.com/form";
export const FIXTURE_LEGAL_ENTITY = "ADW Foundry Ltd";
export const FIXTURE_LEGAL_ADDRESS = "123 Example Street, Suite 400, Toronto, ON M5V 0A1, Canada";
export const FIXTURE_LABEL_VERSION = "label-v1";
export const FIXTURE_CLAIM_TOKEN = "fixture-claim-token";

export const RENDER_FIXTURES: RenderFixture[] = [
  // --- Trades · hero-services-about-contact · 3 locales -----------------------
  {
    id: "trades-services-en-US",
    familyId: "trades",
    layout: "hero-services-about-contact",
    locale: "en-US",
    colorSystem: "steel-blue",
    typePairing: "condensed-workhorse",
    mode: "preview",
    business: { name: "Bright Plumbing", category: "plumber", city: "Denver", phone: "+13035551234", rating: 4.8, reviewCount: 120 },
    copy: {
      headline: "Bright Plumbing — trusted plumber in Denver",
      services: [
        { title: "Leak repair", blurb: "Fast, reliable leak detection and repair for homes and businesses across the Denver metro area." },
        { title: "Water heaters", blurb: "Installation and servicing of tanked and tankless water heaters, done right the first time." },
        { title: "Drain cleaning", blurb: "Professional drain and sewer cleaning that clears the blockage and keeps it clear." },
      ],
      about: "Bright Plumbing has served the Denver metro for over a decade with dependable, on-time plumbing work backed by a satisfaction guarantee. Family-owned, fully local, and reachable on the phone by a person.",
      cta: "Get a free quote",
    },
    a11y: BASELINE,
  },
  {
    id: "trades-services-en-GB",
    familyId: "trades",
    layout: "hero-services-about-contact",
    locale: "en-GB",
    colorSystem: "slate-copper",
    typePairing: "grotesk-plain",
    mode: "preview",
    business: { name: "Halliwell Electrical", category: "electrician", city: "Leeds", phone: "+441132960100", rating: 4.7, reviewCount: 94 },
    copy: {
      headline: "Halliwell Electrical — approved electricians in Leeds",
      services: [
        { title: "Fuse board upgrades", blurb: "Consumer unit replacements and upgrades carried out to current wiring regulations." },
        { title: "Fault finding", blurb: "Tracing intermittent faults, tripping circuits and dead sockets without guesswork." },
        { title: "EICR reports", blurb: "Electrical installation condition reports for landlords and commercial premises." },
      ],
      about: "Halliwell Electrical has worked across Leeds and West Yorkshire for eighteen years, handling everything from a single socket to a full rewire. Every job is quoted before work starts and left tidy afterwards.",
      cta: "Request a quotation",
    },
    a11y: BASELINE,
  },
  {
    id: "trades-services-en-AU",
    familyId: "trades",
    layout: "hero-services-about-contact",
    locale: "en-AU",
    colorSystem: "deep-navy",
    typePairing: "slab-utility",
    mode: "preview",
    business: { name: "Cooper Roofing", category: "roofer", city: "Brisbane", phone: "+61732005500", rating: 4.9, reviewCount: 61 },
    copy: {
      headline: "Cooper Roofing — roof repairs across Brisbane",
      services: [
        { title: "Storm damage repair", blurb: "Emergency make-safe and permanent repairs after hail, wind and heavy rain events." },
        { title: "Roof restoration", blurb: "Cleaning, re-bedding, repointing and coating to add years to an ageing tile roof." },
        { title: "Gutter replacement", blurb: "Guttering and downpipe replacement sized for Brisbane summer downpours." },
      ],
      about: "Cooper Roofing works across greater Brisbane on tile and metal roofs, from a handful of cracked tiles to a full restoration. Quotes are itemised, and the crew that quotes the job is the crew that does it.",
      cta: "Book a roof inspection",
    },
    a11y: BASELINE,
  },

  // --- Trades · hero-gallery-contact · 3 locales ------------------------------
  {
    id: "trades-gallery-en-US",
    familyId: "trades",
    layout: "hero-gallery-contact",
    locale: "en-US",
    colorSystem: "forest-brass",
    typePairing: "system-native",
    mode: "preview",
    business: { name: "Marchetti Landscaping", category: "landscaper", city: "Portland", phone: "+15035558800", rating: 4.6, reviewCount: 143 },
    copy: {
      headline: "Marchetti Landscaping — garden design in Portland",
      services: [
        { title: "Patios and paths", blurb: "Flagstone patios, gravel paths and retaining walls built to drain properly in wet winters." },
        { title: "Planting plans", blurb: "Planting schemes chosen for Pacific Northwest soil, shade and rainfall, then installed." },
        { title: "Seasonal upkeep", blurb: "Scheduled pruning, bed maintenance and leaf clearance on a plan that suits the garden." },
      ],
      about: "Marchetti Landscaping designs and builds gardens across Portland, favouring hardy planting and stonework that stays put. Every project starts with a site visit and a drawing you get to keep whether or not you hire us.",
      cta: "See recent projects",
    },
    a11y: BASELINE,
  },
  {
    id: "trades-gallery-en-GB",
    familyId: "trades",
    layout: "hero-gallery-contact",
    locale: "en-GB",
    colorSystem: "graphite-amber",
    typePairing: "condensed-workhorse",
    mode: "preview",
    business: { name: "Ardley Carpentry", category: "carpenter", city: "Bristol", phone: "+441179250400", rating: 4.9, reviewCount: 77 },
    copy: {
      headline: "Ardley Carpentry — bespoke joinery in Bristol",
      services: [
        { title: "Fitted wardrobes", blurb: "Alcove and full-wall wardrobes built to the millimetre for awkward Victorian bedrooms." },
        { title: "Staircases", blurb: "Replacement treads, balustrades and complete staircases in oak, ash and painted softwood." },
        { title: "Kitchen carcassing", blurb: "Hand-built kitchen units and worktop fitting for rooms no flat-pack range will fit." },
      ],
      about: "Ardley Carpentry is a two-person workshop in south Bristol making fitted furniture and staircases from solid timber. Work is measured on site, built in the workshop and installed by the people who made it.",
      cta: "Discuss a project",
    },
    a11y: BASELINE,
  },
  {
    id: "trades-gallery-en-AU",
    familyId: "trades",
    layout: "hero-gallery-contact",
    locale: "en-AU",
    colorSystem: "oxide-teal",
    typePairing: "grotesk-plain",
    mode: "preview",
    business: { name: "Sandoval Painting", category: "painter", city: "Adelaide", phone: "+61882005150", rating: 4.5, reviewCount: 52 },
    copy: {
      headline: "Sandoval Painting — house painters in Adelaide",
      services: [
        { title: "Interior repaints", blurb: "Walls, ceilings and trim prepared properly, cut in by hand and finished in low-odour paint." },
        { title: "Exterior work", blurb: "Rendered and weatherboard exteriors prepped, primed and coated for Adelaide summers." },
        { title: "Heritage detail", blurb: "Careful repainting of pressed-metal ceilings, fretwork and period timber mouldings." },
      ],
      about: "Sandoval Painting has repainted homes across the Adelaide suburbs since 2009, working to a written scope so there is no argument about what was included. Furniture is covered, and the site is left clean each evening.",
      cta: "Ask for a written quote",
    },
    a11y: BASELINE,
  },

  // --- Personal services · hero-services-about-contact · 3 locales ------------
  {
    id: "personal-services-en-US",
    familyId: "personal_services",
    layout: "hero-services-about-contact",
    locale: "en-US",
    colorSystem: "plum-blush",
    typePairing: "serif-editorial",
    mode: "preview",
    business: { name: "Juniper Hair Studio", category: "salon", city: "Nashville", phone: "+16155552200", rating: 4.8, reviewCount: 210 },
    copy: {
      headline: "Juniper Hair Studio — colour and cuts in Nashville",
      services: [
        { title: "Cut and finish", blurb: "A consultation, a precision cut and a finish you can actually recreate at home." },
        { title: "Colour work", blurb: "Balayage, root touch-ups and full-head colour, with a strand test before anything permanent." },
        { title: "Treatments", blurb: "Conditioning and bond-building treatments booked alongside a cut or on their own." },
      ],
      about: "Juniper Hair Studio is a four-chair salon off Charlotte Avenue. Appointments run to time, every colour service starts with a consultation, and we will tell you honestly when an idea will not suit your hair.",
      cta: "Book an appointment",
    },
    a11y: BASELINE,
  },
  {
    id: "personal-services-en-GB",
    familyId: "personal_services",
    layout: "hero-services-about-contact",
    locale: "en-GB",
    colorSystem: "rose-sand",
    typePairing: "humanist-soft",
    mode: "preview",
    business: { name: "Northgate Barbers", category: "barber", city: "Manchester", phone: "+441612960880", rating: 4.7, reviewCount: 168 },
    copy: {
      headline: "Northgate Barbers — traditional barbering in Manchester",
      services: [
        { title: "Skin fades", blurb: "Clipper work taken down to the skin and blended by hand, finished with a hot towel." },
        { title: "Beard trims", blurb: "Shaping, lining and a straight-razor finish, with or without a cut on the same visit." },
        { title: "Kids cuts", blurb: "Quick, patient cuts for children, booked into quieter slots earlier in the day." },
      ],
      about: "Northgate Barbers has been on the same street corner since 2011. Walk-ins are welcome before eleven and after four; the rest of the day runs on bookings so nobody sits waiting with wet hair.",
      cta: "Check availability",
    },
    a11y: BASELINE,
  },
  {
    id: "personal-services-en-AU",
    familyId: "personal_services",
    layout: "hero-services-about-contact",
    locale: "en-AU",
    colorSystem: "sage-clay",
    typePairing: "geometric-clean",
    mode: "preview",
    business: { name: "Still Point Massage", category: "massage", city: "Hobart", phone: "+61362005400", rating: 4.9, reviewCount: 88 },
    copy: {
      headline: "Still Point Massage — remedial massage in Hobart",
      services: [
        { title: "Remedial sessions", blurb: "Sixty or ninety minute sessions focused on the areas you point at, not a fixed routine." },
        { title: "Sports recovery", blurb: "Pre-event and recovery work for runners, rowers and cyclists around the Hobart clubs." },
        { title: "Relaxation massage", blurb: "Slower full-body work booked in the evening, with no upsell at the end of the table." },
      ],
      about: "Still Point Massage is a single-room studio in North Hobart, open six days with evening slots on Tuesdays and Thursdays. Sessions start on time and finish on time, and the room is quiet by design.",
      cta: "Book a session",
    },
    a11y: BASELINE,
  },

  // --- Personal services · hero-gallery-contact · 3 locales -------------------
  {
    id: "personal-gallery-en-US",
    familyId: "personal_services",
    layout: "hero-gallery-contact",
    locale: "en-US",
    colorSystem: "indigo-peony",
    typePairing: "didone-accent",
    mode: "preview",
    business: { name: "Ink & Compass Tattoo", category: "tattoo", city: "Providence", phone: "+14015553300", rating: 4.9, reviewCount: 132 },
    copy: {
      headline: "Ink & Compass — custom tattoo studio in Providence",
      services: [
        { title: "Custom design", blurb: "A drawing made for you from a consultation, revised before any needle touches skin." },
        { title: "Cover-ups", blurb: "Reworking older tattoos into something you want to look at, planned across sessions." },
        { title: "Fine line work", blurb: "Small-scale linework and lettering, booked as short appointments on weekday mornings." },
      ],
      about: "Ink & Compass is a private studio on Westminster Street with three resident artists. Consultations are free and unhurried, deposits come off the final price, and nobody is talked into a design on the day.",
      cta: "Book a consultation",
    },
    a11y: BASELINE,
  },
  {
    id: "personal-gallery-en-GB",
    familyId: "personal_services",
    layout: "hero-gallery-contact",
    locale: "en-GB",
    colorSystem: "mocha-rose",
    typePairing: "serif-editorial",
    mode: "preview",
    business: { name: "Willow Lane Grooming", category: "pet_grooming", city: "Edinburgh", phone: "+441312960660", rating: 4.8, reviewCount: 96 },
    copy: {
      headline: "Willow Lane Grooming — dog groomers in Edinburgh",
      services: [
        { title: "Full groom", blurb: "Bath, dry, clip and nail trim, one dog at a time so nothing waits in a cage." },
        { title: "Puppy introductions", blurb: "Short, gentle first visits that get a young dog used to the table and the dryer." },
        { title: "De-shedding", blurb: "Undercoat work for double-coated breeds, finished with a check for skin problems." },
      ],
      about: "Willow Lane Grooming is a one-groomer salon in Leith working strictly by appointment. Your dog is with the same person from arrival to collection, and you get a short note on skin, coat and nails afterwards.",
      cta: "Arrange a groom",
    },
    a11y: BASELINE,
  },
  {
    id: "personal-gallery-en-AU",
    familyId: "personal_services",
    layout: "hero-gallery-contact",
    locale: "en-AU",
    colorSystem: "teal-orchid",
    typePairing: "humanist-soft",
    mode: "preview",
    business: { name: "Barre & Bell", category: "fitness_trainer", city: "Perth", phone: "+61892005700", rating: 4.7, reviewCount: 74 },
    copy: {
      headline: "Barre & Bell — small group training in Perth",
      services: [
        { title: "Strength blocks", blurb: "Eight-week barbell programmes for groups of six, with your numbers written down each week." },
        { title: "Mobility classes", blurb: "Forty-minute sessions aimed at desk-bound hips and shoulders, no equipment needed." },
        { title: "One-to-one coaching", blurb: "Individual sessions for returning from injury or preparing for a specific event." },
      ],
      about: "Barre & Bell runs out of a converted warehouse in Leederville with a hard cap of six people per session. Programmes are written for the group in front of the coach, and memberships can be paused any month.",
      cta: "Try a class",
    },
    a11y: BASELINE,
  },

  // --- Food & hospitality · hero-menu-about-contact · 3 locales ---------------
  {
    id: "food-menu-en-US",
    familyId: "food_hospitality",
    layout: "hero-menu-about-contact",
    locale: "en-US",
    colorSystem: "tomato-cream",
    typePairing: "menu-serif",
    mode: "preview",
    business: { name: "Sunrise Cafe", category: "cafe", city: "Austin", phone: "+15125550100", rating: 4.6, reviewCount: 88 },
    copy: {
      headline: "Sunrise Cafe — coffee and breakfast in Austin",
      services: [
        { title: "Espresso bar", blurb: "Locally roasted beans pulled to order by baristas who care about the craft." },
        { title: "All-day breakfast", blurb: "Hearty breakfast plates and pastries made fresh in-house every single morning." },
        { title: "Catering", blurb: "Coffee and breakfast catering for offices and events across central Austin." },
      ],
      about: "Sunrise Cafe is a neighbourhood spot on East Cesar Chavez serving carefully sourced coffee and honest breakfast from six in the morning. The kitchen closes at two; the coffee keeps going until four.",
      cta: "See our menu",
    },
    a11y: BASELINE,
  },
  {
    id: "food-menu-en-GB",
    familyId: "food_hospitality",
    layout: "hero-menu-about-contact",
    locale: "en-GB",
    colorSystem: "olive-ember",
    typePairing: "chalkboard-sans",
    mode: "preview",
    business: { name: "Thistle & Rye", category: "bakery", city: "Glasgow", phone: "+441412960220", rating: 4.9, reviewCount: 154 },
    copy: {
      headline: "Thistle & Rye — sourdough bakery in Glasgow",
      services: [
        { title: "Sourdough loaves", blurb: "Long-fermented loaves baked each morning and sold until the shelf is empty." },
        { title: "Morning pastries", blurb: "Laminated pastries rolled overnight and baked in batches through the morning." },
        { title: "Celebration cakes", blurb: "Cakes to order with a week of notice, decorated plainly and priced by size." },
      ],
      about: "Thistle & Rye is a small bakery in Dennistoun with a two-day dough process and no preservatives. We bake what we can sell in a day, so the shelves thin out by early afternoon and refill the next morning.",
      cta: "View today's bakes",
    },
    a11y: BASELINE,
  },
  {
    id: "food-menu-en-AU",
    familyId: "food_hospitality",
    layout: "hero-menu-about-contact",
    locale: "en-AU",
    colorSystem: "espresso-gold",
    typePairing: "market-slab",
    mode: "preview",
    business: { name: "Harbour Road Kitchen", category: "restaurant", city: "Newcastle", phone: "+61249005900", rating: 4.7, reviewCount: 199 },
    copy: {
      headline: "Harbour Road Kitchen — dinner in Newcastle",
      services: [
        { title: "Wood-fired mains", blurb: "Fish, lamb and vegetables cooked over ironbark, plated simply and served hot." },
        { title: "Shared plates", blurb: "Smaller dishes built for the middle of the table, changed as produce comes in." },
        { title: "Set lunch", blurb: "A two-course lunch served Thursday to Sunday, written fresh on the board each week." },
      ],
      about: "Harbour Road Kitchen opened in 2016 with one wood oven and a short menu that changes with what the growers and the boats bring in. Bookings are taken for dinner; lunch keeps a few tables back for walk-ins.",
      cta: "Book a table",
    },
    a11y: BASELINE,
  },

  // --- Food & hospitality · hero-gallery-contact · 3 locales ------------------
  {
    id: "food-gallery-en-US",
    familyId: "food_hospitality",
    layout: "hero-gallery-contact",
    locale: "en-US",
    colorSystem: "basil-brick",
    typePairing: "bistro-mixed",
    mode: "preview",
    business: { name: "Copper Kettle Catering", category: "caterer", city: "Milwaukee", phone: "+14145554400", rating: 4.8, reviewCount: 63 },
    copy: {
      headline: "Copper Kettle — event catering in Milwaukee",
      services: [
        { title: "Wedding service", blurb: "Plated or family-style service for up to a hundred and eighty guests, staff included." },
        { title: "Corporate lunches", blurb: "Delivered lunches on a standing weekly order, with a rotating menu and real cutlery." },
        { title: "Drop-off trays", blurb: "Cold and hot trays delivered ready to serve, with reheating notes on every lid." },
      ],
      about: "Copper Kettle Catering has cooked for Milwaukee events since 2014 out of a licensed commercial kitchen in Bay View. Menus are quoted per head with nothing hidden, and tastings happen before you sign anything.",
      cta: "Request a menu",
    },
    a11y: BASELINE,
  },
  {
    id: "food-gallery-en-GB",
    familyId: "food_hospitality",
    layout: "hero-gallery-contact",
    locale: "en-GB",
    colorSystem: "merlot-wheat",
    typePairing: "menu-serif",
    mode: "preview",
    business: { name: "The Fox & Anchor", category: "bar", city: "Sheffield", phone: "+441142960990", rating: 4.6, reviewCount: 241 },
    copy: {
      headline: "The Fox & Anchor — cask ale pub in Sheffield",
      services: [
        { title: "Cask line-up", blurb: "Six rotating cask lines from Yorkshire breweries, with tasters poured on request." },
        { title: "Sunday kitchen", blurb: "Roasts served from noon on Sundays until the beef runs out, which it usually does." },
        { title: "Back room hire", blurb: "A separate room for twenty-five people, free to book with a food or drinks order." },
      ],
      about: "The Fox & Anchor is a two-room pub near Kelham Island with no televisions and no music before six. The cellar is looked after properly, the lines are cleaned weekly, and the dog behind the bar is friendly.",
      cta: "See what's on",
    },
    a11y: BASELINE,
  },
  {
    id: "food-gallery-en-AU",
    familyId: "food_hospitality",
    layout: "hero-gallery-contact",
    locale: "en-AU",
    colorSystem: "charcoal-saffron",
    typePairing: "chalkboard-sans",
    mode: "preview",
    business: { name: "Two Streets Food Truck", category: "food_truck", city: "Geelong", phone: "+61352006200", rating: 4.5, reviewCount: 118 },
    copy: {
      headline: "Two Streets — wood-grilled food truck in Geelong",
      services: [
        { title: "Grilled rolls", blurb: "Chicken, mushroom and brisket rolls grilled to order over charcoal, wrapped to walk." },
        { title: "Loaded fries", blurb: "Hand-cut chips with a rotating topping that changes whenever the sauce pot empties." },
        { title: "Event bookings", blurb: "The truck parked at your event with a fixed menu and a set price agreed in advance." },
      ],
      about: "Two Streets is a single charcoal grill on the back of a truck, parked around Geelong five days a week and posted each morning. The menu is short on purpose so everything comes off the grill hot.",
      cta: "Find us today",
    },
    a11y: BASELINE,
  },

  // --- Full (post-claim) builds: no preview banner, no noindex ----------------
  {
    id: "trades-services-full-en-US",
    familyId: "trades",
    layout: "hero-services-about-contact",
    locale: "en-US",
    colorSystem: "graphite-amber",
    typePairing: "slab-utility",
    mode: "full",
    business: { name: "Dockery HVAC", category: "hvac", city: "Columbus", phone: "+16145556600", rating: 4.7, reviewCount: 187 },
    copy: {
      headline: "Dockery HVAC — heating and cooling in Columbus",
      services: [
        { title: "Furnace service", blurb: "Annual servicing and same-week repairs on gas furnaces through the Ohio winter." },
        { title: "AC installation", blurb: "System sizing, quoting and installation with the load calculation shown to you." },
        { title: "Maintenance plans", blurb: "Two visits a year, priority booking and no diagnostic fee on a call-out." },
      ],
      about: "Dockery HVAC has kept Columbus homes warm since 2005. Technicians arrive in the two-hour window they were booked for, quote before they start, and leave the old parts with you if you want them.",
      cta: "Schedule a service",
    },
    a11y: BASELINE,
  },
  {
    id: "food-gallery-full-en-GB",
    familyId: "food_hospitality",
    layout: "hero-gallery-contact",
    locale: "en-GB",
    colorSystem: "tomato-cream",
    typePairing: "market-slab",
    mode: "full",
    business: { name: "Perrin's Coffee House", category: "cafe", city: "Norwich", phone: "+441603960330", rating: 4.8, reviewCount: 145 },
    copy: {
      headline: "Perrin's Coffee House — coffee roasters in Norwich",
      services: [
        { title: "Filter and espresso", blurb: "Two roasts on the bar at all times, one bright and one heavy, both roasted upstairs." },
        { title: "Beans to take home", blurb: "Retail bags roasted on Mondays and Thursdays, ground to your brewer if you ask." },
        { title: "Brewing classes", blurb: "A two-hour Saturday session on grind, ratio and water, capped at eight people." },
      ],
      about: "Perrin's has roasted coffee above the shop on Magdalen Street since 2012. Beans are bought from the same handful of importers each year, and the roast date is printed on every bag rather than a best-before.",
      cta: "See opening hours",
    },
    a11y: BASELINE,
  },
];

/** The family definition a fixture renders with. */
export function fixtureFamily(f: RenderFixture): TemplateFamily {
  const fam = FAMILIES[f.familyId];
  if (!fam) throw new Error(`fixture ${f.id} references unknown family ${f.familyId}`);
  return fam;
}

/** Render a fixture to its HTML document. Pure — same fixture in, same bytes out. */
export function renderFixture(f: RenderFixture): string {
  return renderSite({
    family: f.familyId,
    familyDef: fixtureFamily(f),
    layout: f.layout,
    colorSystem: f.colorSystem,
    typePairing: f.typePairing,
    business: f.business,
    copy: f.copy,
    locale: f.locale,
    mode: f.mode,
    legalEntity: FIXTURE_LEGAL_ENTITY,
    legalAddress: FIXTURE_LEGAL_ADDRESS,
    labelVersion: FIXTURE_LABEL_VERSION,
    claimToken: FIXTURE_CLAIM_TOKEN,
    formAction: FIXTURE_FORM_ACTION,
  });
}

// Emit a site-generation brief for one vertical.
//
//   tsx scripts/gen-site-prompt.ts roofing out/roofing
//
// The fixtures below are one invented business per vertical. Brand seeds are
// deliberately awkward — a harsh red, a garish amber, one vertical with nothing
// extracted at all — because a palette rule that only works on tasteful input
// is not a rule. Real extraction hands you whatever the business chose in 2011.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSitePrompt,
  isSiteVertical,
  type SitePromptInput,
  type SiteVertical,
} from "../packages/site-templates/src/site-prompt.ts";

const REFUSAL =
  "That is not something I can answer for them — I would only be guessing, and I would rather " +
  "not. Your question has been passed on and someone will come back to you.";

type Fixture = Omit<SitePromptInput, "vertical" | "refusalText" | "pages" | "deliverable">;

const img = (path: string, w: number, h: number, description: string) => ({
  path,
  width: w,
  height: h,
  description,
});

const FIXTURES: Record<SiteVertical, Fixture> = {
  roofing: {
    business: {
      name: "Ridgeline Roofing", city: "Boise", region: "ID", postalCode: "83702",
      street: "1420 W Bannock St", phone: "+1 208 555 0142", email: "office@ridgelineroofing.example",
      since: 2009, teamSize: 14, hours: "Mon–Fri 7.00–18.00, Sat 8.00–13.00",
      areaServed: ["Boise", "Meridian", "Nampa", "Eagle", "Kuna"],
    },
    services: [
      { name: "Storm and hail repair", description: "Emergency tarping the same day, permanent repair once the weather clears" },
      { name: "Full roof replacement", description: "Tear-off, deck inspection, architectural shingles, old roof hauled away" },
      { name: "Gutters and flashing", description: "Where most leaks actually start — replaced or resealed" },
      { name: "Roof inspection", description: "Written condition report with photographs", price: "Free" },
    ],
    facts: ["Idaho contractor registration RCE-12345", "Same crew since 2014", "Insurance claim documentation provided"],
    qa: [
      { question: "Do you do emergency repairs?", answer: "Yes. We tarp storm damage the same day where we safely can, and book the permanent repair once the weather clears." },
      { question: "What areas do you cover?", answer: "Boise, Meridian, Nampa, Eagle and Kuna. Beyond that we will still look, but travel is quoted separately." },
      { question: "Do you work with insurance claims?", answer: "We document damage with photographs and measurements so your adjuster has what they need first time. We do not handle the claim itself." },
      { question: "How long does a roof replacement take?", answer: "Most single-family roofs are a two to three day job once materials are on site. Weather is the variable we cannot promise around." },
      { question: "How do I get a quote?", answer: "Book a free inspection. You get a written condition report with photographs, and a quote follows within two working days." },
      { question: "Do you offer a guarantee on the work?", answer: "Workmanship is covered for ten years. Manufacturer cover on the shingles themselves runs separately and we hand over the paperwork." },
    ],
    images: [
      img("img/roof-finished.jpg", 2000, 1125, "a finished shingle roof in raking late light, ridge line against a wide sky"),
      img("img/roof-crew.jpg", 1400, 1867, "PORTRAIT — a roofer working on a pitched roof seen from behind, no face visible"),
      img("img/roof-detail.jpg", 2000, 1125, "close detail of new architectural shingles and a clean lead valley"),
    ],
    brand: { primary: "#C8102E", secondary: "#2B2B2B", sourceUrl: "https://ridgelineroofing.example", extracted: true },
  },

  plumber: {
    business: {
      name: "Halliday & Sons", city: "Leeds", postalCode: "LS6 2AB", street: "42 Otley Road",
      phone: "+44 113 496 0188", email: "office@hallidayplumbing.example", since: 1998, teamSize: 9,
      hours: "Mon–Fri 8.00–18.00, emergency line 24h",
      areaServed: ["Leeds", "Headingley", "Horsforth", "Otley", "Wetherby"],
    },
    services: [
      { name: "Emergency callout", description: "Burst pipes, leaks and total loss of water, 24 hours", price: "£95 callout" },
      { name: "Boiler repair and servicing", description: "Repair, annual service and replacement", price: "£72/hour" },
      { name: "Bathroom installation", description: "Full fit from strip-out through to tiling" },
      { name: "Drainage", description: "Blocked drains cleared by rod and jet" },
    ],
    facts: ["Trading since 1998", "Nine engineers, all directly employed", "Unmarked vans on request"],
    qa: [
      { question: "Do you do emergency callouts?", answer: "Yes, 24 hours, for burst pipes, major leaks and total loss of water. The emergency line is answered by an engineer, not a call centre." },
      { question: "What is your callout charge?", answer: "£95 for the callout, which covers the first half hour on site. After that it is £72 an hour, charged in fifteen minute blocks." },
      { question: "What areas do you cover?", answer: "Leeds and the surrounding area — Headingley, Horsforth, Otley and Wetherby. Further out we will come for planned work but not emergencies." },
      { question: "Do you fix boilers?", answer: "We repair, service and replace boilers. If a repair is not economic we will say so rather than sell you the repair first and the replacement later." },
      { question: "How quickly can someone come out?", answer: "For an emergency, usually within two hours inside our core area. For planned work we are typically booking a week or so ahead." },
      { question: "Do you work weekends?", answer: "The emergency line runs through the weekend. Planned work is weekdays only." },
    ],
    images: [
      img("img/plumb-pipes.jpg", 2000, 1125, "a newly installed copper pipe run, clean and square, in a plant room"),
      img("img/plumb-arrival.jpg", 2000, 1125, "a work van and tool case at a residential doorstep, morning light"),
      img("img/plumb-bathroom.jpg", 1400, 1867, "PORTRAIT — a finished bathroom to a high standard, tiled, calm light"),
    ],
    brand: { primary: "#005EB8", secondary: "#8C8C8C", sourceUrl: "https://hallidayplumbing.example", extracted: true },
  },

  electrician: {
    business: {
      name: "Calder Electrical", city: "Bristol", postalCode: "BS1 5TR", street: "8 Redcliffe Parade",
      phone: "+44 117 496 0231", email: "hello@calderelectrical.example", since: 2012, teamSize: 7,
      hours: "Mon–Fri 8.00–17.00",
      areaServed: ["Bristol", "Clifton", "Bedminster", "Portishead", "Bath"],
    },
    services: [
      { name: "Fault finding and repair", description: "Tracing and fixing intermittent faults", price: "£85 callout" },
      { name: "Consumer unit replacement", description: "Full replacement, labelled and certified" },
      { name: "EV charge point installation", description: "Home charge points, surveyed and installed" },
      { name: "Full and partial rewires", description: "Whole-property rewiring, room by room where needed" },
    ],
    facts: ["Trading since 2012", "Seven electricians, directly employed", "Certificates issued on completion"],
    qa: [
      { question: "Do you do EV chargers?", answer: "Yes. We survey first — the answer depends on your incoming supply and where the car actually parks — then install and certify." },
      { question: "What is your callout charge?", answer: "£85, which covers the first hour on site. Most fault finding is resolved within that." },
      { question: "What areas do you cover?", answer: "Bristol and out to Clifton, Bedminster, Portishead and Bath. Beyond that we take planned work only." },
      { question: "Can you do a full rewire?", answer: "Yes, whole property or room by room. A full rewire on a three-bedroom house is usually five to eight days depending on access and whether it is occupied." },
      { question: "Do you handle emergency faults?", answer: "During working hours, yes, and we prioritise total loss of power. We are not a 24 hour service and would rather say so than not answer the phone at 2am." },
      { question: "How do I book?", answer: "Call or email with the address and a description of the fault. We will tell you whether it is a callout or needs a survey first." },
    ],
    images: [
      img("img/elec-unit.jpg", 2000, 1125, "a newly installed consumer unit, fully labelled, door open, neat wiring"),
      img("img/elec-lighting.jpg", 2000, 1125, "a lighting scheme at dusk in a finished domestic interior"),
      img("img/elec-detail.jpg", 1400, 1867, "PORTRAIT — close detail of neatly terminated cable in a back box"),
    ],
    brand: { primary: "#FFB81C", secondary: "#1C1C1C", sourceUrl: "https://calderelectrical.example", extracted: true },
  },

  hvac: {
    business: {
      name: "Northbourne Climate", city: "Auckland", postalCode: "1010", street: "116 Karangahape Road",
      phone: "+64 9 555 0177", email: "office@northbourneclimate.example", since: 2006, teamSize: 18,
      hours: "Mon–Fri 7.30–17.30",
      areaServed: ["Auckland", "North Shore", "Waitakere", "Manukau"],
    },
    services: [
      { name: "Heat pump installation", description: "Survey, supply and install, single or multi-room" },
      { name: "Ducted systems", description: "Whole-home ducted heating and cooling" },
      { name: "Service plan — Essential", description: "One service visit a year, priority booking", price: "$220/year" },
      { name: "Service plan — Complete", description: "Two visits a year, priority booking, no callout fee", price: "$390/year" },
    ],
    facts: ["Trading since 2006", "Eighteen staff", "Installs certified on handover"],
    qa: [
      { question: "Do you offer service plans?", answer: "Two. Essential is $220 a year for one service visit and priority booking. Complete is $390 for two visits, priority booking and no callout fee." },
      { question: "Do you install heat pumps?", answer: "Yes, single room through to whole-home ducted. We survey first because the right unit depends on the building, not the room count." },
      { question: "What areas do you cover?", answer: "Auckland, the North Shore, Waitakere and Manukau." },
      { question: "How often should a system be serviced?", answer: "Once a year for a domestic heat pump, twice for a ducted system or anything working hard year round." },
      { question: "Do you handle emergency breakdowns?", answer: "Plan holders get priority. Without a plan we will fit you in, but a plan holder with no heating in July goes first." },
      { question: "How do I get a quote?", answer: "Book a survey. We look at the building, ask how you actually live in it, and quote from that." },
    ],
    images: [
      img("img/hvac-indoor.jpg", 2000, 1125, "a wall-mounted indoor heat pump unit in a calm, well-lit living room"),
      img("img/hvac-outdoor.jpg", 2000, 1125, "an outdoor condenser unit on a neat plinth with planting around it"),
      img("img/hvac-interior.jpg", 1400, 1867, "PORTRAIT — a wide domestic interior in strong summer light, comfortable and airy"),
    ],
    brand: { primary: "#00A3E0", secondary: "#4A4A4A", sourceUrl: "https://northbourneclimate.example", extracted: true },
  },

  pest_control: {
    business: {
      name: "Marchmont Pest Solutions", city: "Edinburgh", postalCode: "EH9 1HW", street: "27 Marchmont Crescent",
      phone: "+44 131 496 0144", email: "office@marchmontpest.example", since: 2015, teamSize: 6,
      hours: "Mon–Sat 8.00–18.00",
      areaServed: ["Edinburgh", "Leith", "Musselburgh", "Livingston"],
    },
    services: [
      { name: "Domestic callout", description: "Survey and treatment for household infestations", price: "£85 callout" },
      { name: "Commercial contracts", description: "Scheduled visits for food premises and offices" },
      { name: "Proofing", description: "Sealing entry points so the problem does not return" },
      { name: "Follow-up visits", description: "Included where a treatment needs more than one visit" },
    ],
    facts: ["Trading since 2015", "Unmarked vehicles as standard", "Six technicians, directly employed"],
    qa: [
      { question: "What is your callout charge?", answer: "£85 for a domestic callout, which includes the survey and the first treatment. Follow-up visits on the same problem are included." },
      { question: "What areas do you cover?", answer: "Edinburgh, Leith, Musselburgh and Livingston." },
      { question: "How soon can someone come out?", answer: "Usually within 48 hours, and same day where we have a gap. Tell us what you have seen and we will tell you honestly how urgent it is." },
      { question: "Do you handle commercial premises?", answer: "Yes, including food premises, on scheduled contracts with documentation for your records." },
      { question: "Do you offer follow-up visits?", answer: "Where a treatment needs more than one visit, the follow-ups are included in the original price. We will say up front if that is likely." },
      { question: "Are your vehicles marked?", answer: "No. All our vehicles are unmarked as standard — we know most people would rather the street did not know." },
    ],
    images: [
      img("img/pest-exterior.jpg", 2000, 1125, "an ordinary well-kept residential exterior, calm daylight, nothing alarming"),
      img("img/pest-kit.jpg", 2000, 1125, "a technician's equipment case laid out neatly on a clean surface, unbranded"),
      img("img/pest-interior.jpg", 1400, 1867, "PORTRAIT — a tidy, bright domestic kitchen, spotless and reassuring"),
    ],
    brand: { primary: "#6A8A3F", secondary: "#3D3D3D", sourceUrl: "https://marchmontpest.example", extracted: true },
  },

  landscaping: {
    business: {
      name: "Alder & Stone", city: "Portland", region: "OR", postalCode: "97214",
      street: "812 SE Morrison St", phone: "+1 503 555 0148", email: "studio@alderandstone.example",
      since: 2009, teamSize: 11, hours: "Mon–Fri 8.00–17.30",
      areaServed: ["Portland", "Sellwood", "Laurelhurst", "Irvington", "Lake Oswego", "West Linn"],
    },
    services: [
      { name: "Site consultation", description: "Ninety minutes on site, written summary within a week", price: "$180" },
      { name: "Garden design", description: "Survey, concept, planting plan and construction drawings", price: "From $3,500" },
      { name: "Build", description: "Stone, timber, steel, drainage and planting by our own team" },
      { name: "Establishment care", description: "Two seasons of aftercare, then a written handover plan", price: "Included" },
    ],
    facts: ["Trading since 2009", "Eleven people, no subcontracted build", "About twelve gardens a year"],
    qa: [
      { question: "What areas do you cover?", answer: "Portland and the close-in suburbs — Sellwood, Laurelhurst, Irvington, Alameda, and out to Lake Oswego and West Linn. Beyond about 25 miles we take on design work only." },
      { question: "What does a garden design cost?", answer: "A full design for a typical city lot runs $3,500 to $6,000 depending on survey and level of detail. Build is quoted once the drawings are agreed." },
      { question: "How long does a project take?", answer: "Design takes six to ten weeks from the first site visit. Build depends on scope: three to four weeks for a terrace and planting, eight to twelve for a full garden." },
      { question: "Do you do the building as well as the design?", answer: "Yes. All hard landscaping is built by our own team, and the planting is ours too. We bring in specialists only for electrical work and anything needing an engineer's stamp." },
      { question: "Do you maintain gardens afterwards?", answer: "For the first two seasons, because that period decides whether a planting scheme establishes. After that we hand over with a written plan." },
      { question: "How do we start?", answer: "A site visit, about ninety minutes, on site with you. It is $180 and comes off the design fee if you go ahead." },
    ],
    images: [
      img("img/hero.jpg", 2000, 1125, "a courtyard garden at golden evening light: timber wall, bluestone paving, ornamental grasses, rust-red achillea, multi-stem birch"),
      img("img/path.jpg", 1400, 1867, "PORTRAIT — a gravel path curving between deep borders of frosted grasses in morning mist, pale and airy"),
      img("img/terrace.jpg", 1800, 1200, "a flagstone terrace at dusk, dry-stone wall uplit warm amber, timber bench, deep blue sky"),
      img("img/studio.jpg", 1800, 1350, "a garden studio clad in charred black timber, full-height glass door, stone threshold, ferns"),
      img("img/frost.jpg", 2000, 1125, "macro of frost on grass seed heads, backlit — bright frosted grass on the LEFT, dark blue-grey blur on the RIGHT"),
    ],
    // ⛔ Nothing extracted. Exercises the fallback: the model must say in a
    // comment that the palette is a register default, not their brand.
    brand: { extracted: false },
  },

  accountant: {
    business: {
      name: "Whitcombe & Reeve", city: "Dublin", postalCode: "D02 XY45", street: "14 Fitzwilliam Square",
      phone: "+353 1 555 0192", email: "office@whitcombereeve.example", since: 1994, teamSize: 22,
      hours: "Mon–Fri 9.00–17.30",
      areaServed: ["Dublin", "Dún Laoghaire", "Malahide", "Bray"],
    },
    services: [
      { name: "Annual accounts and filing", description: "Statutory accounts prepared and filed", price: "Fixed fee, agreed in advance" },
      { name: "Company secretarial", description: "Registered office, filings and statutory registers", price: "From €600/year" },
      { name: "Payroll", description: "Monthly payroll run and submissions", price: "Monthly, per employee" },
      { name: "First meeting", description: "An hour to understand the business and scope the work", price: "No charge" },
    ],
    facts: ["Established 1994", "Twenty-two staff", "Fees agreed in writing before work begins"],
    qa: [
      { question: "What are your fees?", answer: "Fixed fees agreed in writing before any work starts. Company secretarial begins at €600 a year; accounts and payroll are quoted once we understand the size of the job." },
      { question: "Do you work with limited companies?", answer: "Most of our clients are owner-managed limited companies, from first-year startups to groups." },
      { question: "Can you handle self-assessment?", answer: "Yes, for individuals and for directors alongside their company work." },
      { question: "How do we get started?", answer: "A first meeting, an hour, no charge. We look at what you have, what you need filed and when, and put a fixed fee in writing." },
      { question: "Do you offer a first meeting?", answer: "Yes, an hour with a partner, at no charge and with no obligation." },
      { question: "Where are you based?", answer: "14 Fitzwilliam Square, Dublin 2. We act for clients across Dublin, Dún Laoghaire, Malahide and Bray." },
    ],
    images: [
      img("img/acc-interior.jpg", 2000, 1125, "a calm professional interior with strong natural light, no people, architectural"),
      img("img/acc-facade.jpg", 1400, 1867, "PORTRAIT — a Georgian townhouse facade in soft daylight, restrained and formal"),
    ],
    brand: { primary: "#1B365D", secondary: "#B8A369", sourceUrl: "https://whitcombereeve.example", extracted: true },
  },

  lawyer: {
    business: {
      name: "Harrow Vance", city: "Melbourne", region: "VIC", postalCode: "3000",
      street: "Level 9, 200 Queen Street", phone: "+61 3 5550 0166", email: "reception@harrowvance.example",
      since: 1987, teamSize: 31, hours: "Mon–Fri 9.00–17.30",
      areaServed: ["Melbourne", "Geelong", "Ballarat"],
    },
    services: [
      { name: "Commercial and corporate", description: "Company transactions, shareholder matters and contracts" },
      { name: "Property", description: "Commercial and residential conveyancing and leasing" },
      { name: "Wills and estates", description: "Estate planning, probate and administration" },
      { name: "First consultation", description: "A meeting to understand the matter and explain the options" },
    ],
    facts: ["Established 1987", "Thirty-one staff including eleven partners"],
    qa: [
      { question: "What areas of law do you practise?", answer: "Commercial and corporate, property, and wills and estates. Where a matter falls outside those we will say so and refer you on." },
      { question: "Do you offer a first consultation?", answer: "Yes. A first meeting to understand the matter and explain the options open to you." },
      { question: "Where are you based?", answer: "Level 9, 200 Queen Street, Melbourne. We act for clients in Melbourne, Geelong and Ballarat." },
      { question: "How do I make an appointment?", answer: "Call reception or email, with a short description of the matter so we can put you with the right person." },
      { question: "Do you handle commercial matters?", answer: "Yes — company transactions, shareholder matters and commercial contracts are a substantial part of the practice." },
      { question: "What happens at a first meeting?", answer: "We listen, ask questions, and explain what the options are and roughly what each involves. You leave knowing what the process looks like." },
    ],
    images: [
      img("img/law-facade.jpg", 2000, 1125, "a restrained modern building facade in flat daylight, strong verticals, no people"),
      img("img/law-interior.jpg", 1400, 1867, "PORTRAIT — a quiet interior with a tall window and raking light, no people, no books"),
    ],
    brand: { primary: "#7A2E2E", secondary: "#2E2E2E", sourceUrl: "https://harrowvance.example", extracted: true },
  },

  auto_repair: {
    business: {
      name: "Tolman Motor Works", city: "Manchester", postalCode: "M15 4PX", street: "3 Chester Road",
      phone: "+44 161 496 0155", email: "bookings@tolmanmotor.example", since: 2004, teamSize: 12,
      hours: "Mon–Fri 8.00–18.00, Sat 8.00–13.00",
      areaServed: ["Manchester", "Salford", "Stretford", "Chorlton"],
    },
    services: [
      { name: "MOT test", description: "Class 4 MOT, while you wait", price: "£54.85" },
      { name: "Interim service", description: "Oil, filter and a 30-point check", price: "£139" },
      { name: "Full service", description: "Oil, all filters, fluids and a 60-point check", price: "£249" },
      { name: "Diagnostic", description: "Fault code read and investigation, first hour", price: "£65" },
    ],
    facts: ["Trading since 2004", "Twelve staff", "Courtesy cars available by arrangement"],
    qa: [
      { question: "How much is an MOT?", answer: "£54.85, which is the statutory maximum. We do not discount it and we do not use it as a loss leader." },
      { question: "Do you do servicing?", answer: "Interim service is £139 — oil, filter and a 30-point check. Full service is £249 and covers all filters, fluids and a 60-point check." },
      { question: "Can I book online?", answer: "Yes, pick a slot and we will confirm by text. If we cannot make the slot work we will call rather than move it silently." },
      { question: "What are your opening hours?", answer: "Monday to Friday 8.00 to 18.00, Saturday 8.00 to 13.00. Closed Sundays." },
      { question: "Do you offer courtesy cars?", answer: "By arrangement, subject to availability. Ask when you book rather than on the day." },
      { question: "How much is a diagnostic?", answer: "£65 for the first hour, which covers reading the codes and investigating what they actually mean. That comes off the repair if you go ahead with us." },
    ],
    images: [
      img("img/auto-bay.jpg", 2000, 1125, "a clean well-lit workshop bay with a car raised on a two-post lift"),
      img("img/auto-hands.jpg", 2000, 1125, "hands with a tool on an engine component, cropped at the forearms, no face"),
      img("img/auto-forecourt.jpg", 1400, 1867, "PORTRAIT — a tidy forecourt with finished cars in a row, early morning light"),
    ],
    brand: { primary: "#E4002B", secondary: "#141414", sourceUrl: "https://tolmanmotor.example", extracted: true },
  },
};

const PAGES = ["index.html", "work.html", "services.html", "about.html", "contact.html"];

const [, , verticalArg, outDir] = process.argv;
if (verticalArg === undefined || !isSiteVertical(verticalArg)) {
  console.error(`usage: gen-site-prompt.ts <vertical> <outdir>\nverticals: ${Object.keys(FIXTURES).join(", ")}`);
  process.exit(2);
}
const vertical: SiteVertical = verticalArg;
const fixture = FIXTURES[vertical];

const { system, user } = buildSitePrompt({
  ...fixture,
  vertical,
  refusalText: REFUSAL,
  pages: PAGES,
  deliverable: ["index.html", "assets/site.css", "assets/site.js"],
});

const dir = outDir ?? join("out", vertical);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "system.txt"), system);
writeFileSync(join(dir, "user.txt"), user);
console.log(`${vertical}: system ${system.length}B  user ${user.length}B  -> ${dir}`);

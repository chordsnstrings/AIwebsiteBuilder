// The vertical question template — the ~60 questions customers actually ask a
// business of this kind (§21.3, BUILD SPEC §5.4). It is deliberately a fixed
// list rather than a generated one: the template is what measures coverage, and
// a template that changes per business measures nothing.
//
// A template question is NOT an answer. It names the question and the kb_facts
// fact_keys that are allowed to answer it; if this business published none of
// them, the pair becomes an explicit refusal and the question goes on the gap
// list. Nothing here invents content.
import { config } from "@adw/config";

export interface TemplateQuestion {
  id: string;
  question: string;
  /** Coverage bucket. Reported per topic so a thin area is visible, not averaged away. */
  topic: string;
  /** kb_facts.fact_key values permitted to answer this. Order is preference order. */
  factKeys: readonly string[];
  /** Fixed lead-in. Fact values are quoted as published; the pack never paraphrases them. */
  lead: string;
  /** Overrides the topic default when "we don't publish this" needs specific wording. */
  refusal?: string;
}

/** A claim the agent may never assert for this vertical (config/playbooks.yaml). */
export interface RefusalRule {
  id: string;
  matches: readonly string[];
  reason: string;
}

export interface VerticalTemplate {
  vertical: string;
  label: string;
  /** Content-hashed playbooks version, stamped onto the pack it produced. */
  playbookVersion: string;
  bookingModel: string;
  pricing: string;
  photoTriage: boolean;
  questions: TemplateQuestion[];
  refusals: RefusalRule[];
  minPackPairs: number;
  targetPackPairs: number;
}

// One refusal sentence per topic. The wording matters: it says we do not publish
// it, never that it is not true, and it always offers the owner.
const TOPIC_REFUSALS: Record<string, string> = {
  hours: "We don't publish our opening hours, so I can't confirm them — I can pass your question to the owner.",
  service_area: "We don't publish our service area, so I can't confirm whether we cover you — I can ask the owner.",
  services: "That isn't listed among the services we publish, so I can't confirm it — I can ask the owner for you.",
  pricing: "We don't publish prices, so I can't quote you — the owner can give you a figure directly.",
  booking: "We don't publish how booking works, so I'd rather put you through to the owner than guess.",
  contact: "We don't publish that contact detail — I can take your details and have the owner reach you.",
  payment: "We don't publish our payment terms, so I can't confirm them — the owner can.",
  guarantee: "We don't publish guarantee terms, so I can't state any — please ask the owner directly.",
  credentials: "I can only confirm credentials we publish and have verified, and this isn't one — the owner can send you proof.",
  experience: "We don't publish that, so I can't confirm it — the owner can tell you.",
  process: "We don't publish how that works, so I can't describe it — I can ask the owner.",
  cancellation: "We don't publish a cancellation policy, so I can't state one — the owner can confirm.",
  access: "We don't publish that, so I can't confirm it — I can ask the owner.",
  language: "We don't publish which languages we work in, so I can't confirm — the owner can.",
  commercial: "We don't publish anything about that, so I can't confirm it — I can ask the owner.",
  emergency: "We don't publish an emergency service, so I can't promise one — I can pass this to the owner now.",
  photo: "We don't publish anything about photos, so I'll pass your message to the owner instead.",
};

const GENERIC_REFUSAL =
  "That isn't something we publish, so I can't answer it — I can pass your question to the owner.";

/** The refusal wording for a question that this business cannot answer. */
export function refusalFor(question: TemplateQuestion): string {
  return question.refusal ?? TOPIC_REFUSALS[question.topic] ?? GENERIC_REFUSAL;
}

const UNIVERSAL_QUESTIONS: readonly TemplateQuestion[] = [
  { id: "hours_general", question: "What are your opening hours?", topic: "hours", factKeys: ["hours"], lead: "Our published opening hours are:" },
  { id: "hours_weekend", question: "Are you open at weekends?", topic: "hours", factKeys: ["hours_weekend", "hours"], lead: "Our published hours cover:" },
  { id: "hours_holiday", question: "Are you open on public holidays?", topic: "hours", factKeys: ["hours_exception", "hours_holiday"], lead: "What we publish about holiday opening:" },
  { id: "hours_close", question: "What time do you close?", topic: "hours", factKeys: ["hours"], lead: "Our published hours are:" },
  { id: "hours_out_of_hours", question: "Do you work outside normal hours?", topic: "hours", factKeys: ["out_of_hours", "hours"], lead: "What we publish about out-of-hours work:" },

  { id: "area_general", question: "What areas do you cover?", topic: "service_area", factKeys: ["service_area"], lead: "We publish that we cover:" },
  { id: "area_travel", question: "How far will you travel?", topic: "service_area", factKeys: ["travel_radius", "service_area"], lead: "What we publish about how far we travel:" },
  { id: "area_travel_charge", question: "Do you charge extra to travel to me?", topic: "pricing", factKeys: ["travel_fee", "callout_fee"], lead: "What we publish about travel charges:" },
  { id: "area_base", question: "Where are you based?", topic: "service_area", factKeys: ["address", "service_area"], lead: "We're based at:" },

  { id: "services_list", question: "What services do you offer?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
  { id: "services_specialism", question: "What do you specialise in?", topic: "services", factKeys: ["specialism", "service"], lead: "We publish that we specialise in:" },
  { id: "services_exclusions", question: "Is there anything you don't do?", topic: "services", factKeys: ["service_exclusion"], lead: "What we publish about work we don't take on:" },
  { id: "services_commercial", question: "Do you work for businesses as well as homes?", topic: "commercial", factKeys: ["commercial", "service"], lead: "What we publish about commercial work:" },
  { id: "services_brands", question: "Which brands or products do you work with?", topic: "services", factKeys: ["brand", "product"], lead: "The brands and products we publish are:" },

  { id: "pricing_general", question: "How much do you charge?", topic: "pricing", factKeys: ["price", "price_structure"], lead: "The prices we publish are:" },
  { id: "pricing_quote", question: "Can I get a quote?", topic: "pricing", factKeys: ["quote_process", "booking", "contact_form"], lead: "How to get a quote from us:" },
  { id: "pricing_callout", question: "Is there a callout fee?", topic: "pricing", factKeys: ["callout_fee", "minimum_charge"], lead: "What we publish about callout charges:" },
  { id: "pricing_quote_free", question: "Are quotes free?", topic: "pricing", factKeys: ["quote_process", "callout_fee"], lead: "What we publish about quotes:" },
  { id: "pricing_minimum", question: "Do you have a minimum charge?", topic: "pricing", factKeys: ["minimum_charge", "price_structure"], lead: "What we publish about minimum charges:" },

  { id: "booking_how", question: "How do I book?", topic: "booking", factKeys: ["booking", "contact_phone", "contact_form"], lead: "How to book with us:" },
  { id: "booking_lead_time", question: "How soon can you come out?", topic: "booking", factKeys: ["lead_time", "response_time"], lead: "What we publish about how soon we can attend:" },
  { id: "booking_duration", question: "How long does the work usually take?", topic: "process", factKeys: ["duration", "lead_time"], lead: "What we publish about how long the work takes:" },
  { id: "booking_cancel", question: "What if I need to cancel or reschedule?", topic: "cancellation", factKeys: ["cancellation_policy"], lead: "Our published cancellation policy:" },

  { id: "contact_phone", question: "What's your phone number?", topic: "contact", factKeys: ["contact_phone"], lead: "You can call us on:" },
  { id: "contact_email", question: "What's your email address?", topic: "contact", factKeys: ["contact_email"], lead: "You can email us at:" },
  { id: "contact_whatsapp", question: "Can I message you on WhatsApp?", topic: "contact", factKeys: ["contact_whatsapp", "contact_phone"], lead: "The contact routes we publish are:" },
  { id: "contact_address", question: "What's your address?", topic: "contact", factKeys: ["address"], lead: "Our address is:" },

  { id: "payment_methods", question: "What payment methods do you accept?", topic: "payment", factKeys: ["payment_method"], lead: "The payment methods we publish are:" },
  { id: "payment_deposit", question: "Do you take a deposit?", topic: "payment", factKeys: ["deposit_policy", "payment_method"], lead: "What we publish about deposits:" },
  { id: "payment_when", question: "When do I pay?", topic: "payment", factKeys: ["payment_terms", "payment_method"], lead: "Our published payment terms:" },
  { id: "payment_invoice", question: "Can you invoice my company?", topic: "payment", factKeys: ["payment_terms", "commercial"], lead: "What we publish about invoicing:" },

  { id: "guarantee_work", question: "Do you guarantee your work?", topic: "guarantee", factKeys: ["guarantee", "warranty"], lead: "The guarantee we publish is:" },
  { id: "guarantee_length", question: "How long is the guarantee?", topic: "guarantee", factKeys: ["warranty", "guarantee"], lead: "What we publish about guarantee length:" },
  { id: "guarantee_problem", question: "What happens if something goes wrong afterwards?", topic: "guarantee", factKeys: ["warranty", "guarantee", "aftercare"], lead: "What we publish about aftercare:" },

  { id: "credentials_insured", question: "Are you insured?", topic: "credentials", factKeys: ["insurance"], lead: "What we publish about insurance:" },
  { id: "credentials_qualified", question: "Are you qualified and registered?", topic: "credentials", factKeys: ["certification", "membership"], lead: "The credentials we publish are:" },
  { id: "credentials_memberships", question: "Are you a member of any trade bodies?", topic: "credentials", factKeys: ["membership"], lead: "The memberships we publish are:" },
  { id: "credentials_checks", question: "Are your staff background-checked?", topic: "credentials", factKeys: ["staff_checks", "team"], lead: "What we publish about our staff:" },

  { id: "experience_years", question: "How long have you been trading?", topic: "experience", factKeys: ["established", "experience"], lead: "What we publish about how long we've traded:" },
  { id: "experience_reviews", question: "Can I see reviews?", topic: "experience", factKeys: ["review_url", "review"], lead: "Where our reviews are published:" },
  { id: "experience_examples", question: "Can I see examples of your work?", topic: "experience", factKeys: ["portfolio", "gallery_url"], lead: "Where our work is published:" },
  { id: "experience_references", question: "Can you provide references?", topic: "experience", factKeys: ["reference", "review_url"], lead: "What we publish about references:" },

  { id: "process_visit", question: "What happens when you come out?", topic: "process", factKeys: ["process"], lead: "The process we publish is:" },
  { id: "process_who", question: "Who will come to my property?", topic: "process", factKeys: ["team", "process"], lead: "What we publish about who attends:" },
  { id: "process_cleanup", question: "Do you clear up afterwards?", topic: "process", factKeys: ["process", "aftercare"], lead: "What we publish about clearing up:" },

  { id: "access_parking", question: "Do you need parking?", topic: "access", factKeys: ["parking", "process"], lead: "What we publish about parking:" },
  { id: "access_premises", question: "Is your premises accessible?", topic: "access", factKeys: ["accessibility", "address"], lead: "What we publish about access:" },
  { id: "language_spoken", question: "What languages do you speak?", topic: "language", factKeys: ["language"], lead: "The languages we publish are:" },
];

// Booking is where the transactability gap actually is, so the booking-model
// block is the part of the template most likely to convert a visitor.
const BOOKING_MODEL_QUESTIONS: Record<string, readonly TemplateQuestion[]> = {
  quote_request: [
    { id: "bm_quote_request", question: "How do I request a quote?", topic: "booking", factKeys: ["quote_process", "contact_form", "booking"], lead: "How to request a quote:" },
    { id: "bm_quote_visit", question: "Do you visit before quoting?", topic: "process", factKeys: ["quote_process", "process"], lead: "What we publish about site visits:" },
    { id: "bm_quote_time", question: "How long does a quote take?", topic: "booking", factKeys: ["quote_process", "lead_time"], lead: "What we publish about quote turnaround:" },
    { id: "bm_quote_fixed", question: "Is the quote fixed or an estimate?", topic: "pricing", factKeys: ["quote_process", "price_structure"], lead: "What we publish about how quotes work:" },
  ],
  consultation_slot: [
    { id: "bm_consult_book", question: "Can I book a consultation?", topic: "booking", factKeys: ["booking", "consultation"], lead: "How to book a consultation:" },
    { id: "bm_consult_free", question: "Is the first consultation free?", topic: "pricing", factKeys: ["consultation", "price_structure"], lead: "What we publish about the first consultation:" },
    { id: "bm_consult_length", question: "How long is a consultation?", topic: "process", factKeys: ["consultation", "duration"], lead: "What we publish about consultation length:" },
    { id: "bm_consult_remote", question: "Can we meet remotely?", topic: "process", factKeys: ["consultation", "process"], lead: "What we publish about remote meetings:" },
  ],
  callout_request: [
    { id: "bm_callout_today", question: "Can you come out today?", topic: "emergency", factKeys: ["response_time", "emergency"], lead: "What we publish about response times:" },
    { id: "bm_callout_charge", question: "Do you charge for the callout?", topic: "pricing", factKeys: ["callout_fee"], lead: "Our published callout charge:" },
    { id: "bm_callout_emergency", question: "Do you do emergency callouts?", topic: "emergency", factKeys: ["emergency", "out_of_hours"], lead: "What we publish about emergency work:" },
    { id: "bm_callout_response", question: "How quickly do you respond?", topic: "emergency", factKeys: ["response_time"], lead: "Our published response time:" },
  ],
  quote_plus_service_slot: [
    { id: "bm_service_book", question: "Can I book a service visit?", topic: "booking", factKeys: ["booking", "service_plan"], lead: "How to book a service visit:" },
    { id: "bm_service_plans", question: "Do you offer service plans?", topic: "services", factKeys: ["service_plan", "price_structure"], lead: "The service plans we publish are:" },
    { id: "bm_service_quote", question: "Do you quote before the work starts?", topic: "pricing", factKeys: ["quote_process"], lead: "What we publish about quoting:" },
    { id: "bm_service_includes", question: "What does a service visit include?", topic: "services", factKeys: ["service_plan", "service"], lead: "What we publish about service visits:" },
  ],
  instant_book: [
    { id: "bm_instant_online", question: "Can I book online?", topic: "booking", factKeys: ["booking", "booking_url"], lead: "How to book online:" },
    { id: "bm_instant_slots", question: "What slots do you have?", topic: "booking", factKeys: ["booking", "hours"], lead: "What we publish about availability:" },
    { id: "bm_instant_choose", question: "Can I choose a specific time?", topic: "booking", factKeys: ["booking", "hours"], lead: "What we publish about choosing a time:" },
    { id: "bm_instant_confirm", question: "Will I get a confirmation?", topic: "booking", factKeys: ["booking", "process"], lead: "What we publish about booking confirmations:" },
  ],
};

// Keyed on playbooks `pricing`. A vertical whose pricing is never_published will
// refuse most of these, which is the correct outcome and a measured one.
const PRICING_QUESTIONS: Record<string, readonly TemplateQuestion[]> = {
  never_published: [
    { id: "pr_rough_idea", question: "Can you give me a rough idea of the price?", topic: "pricing", factKeys: ["price", "price_structure"], lead: "The pricing we publish is:" },
    { id: "pr_depends", question: "What does the price depend on?", topic: "pricing", factKeys: ["price_structure", "quote_process"], lead: "What we publish about how price is worked out:" },
  ],
  rarely_published: [
    { id: "pr_typical", question: "What does a typical job cost?", topic: "pricing", factKeys: ["price", "price_structure"], lead: "The prices we publish are:" },
    { id: "pr_depends", question: "What does the price depend on?", topic: "pricing", factKeys: ["price_structure", "quote_process"], lead: "What we publish about how price is worked out:" },
  ],
  fee_structure_only: [
    { id: "pr_structure", question: "How is your fee structured?", topic: "pricing", factKeys: ["price_structure", "price"], lead: "Our published fee structure:" },
    { id: "pr_fixed_fee", question: "Do you offer fixed fees?", topic: "pricing", factKeys: ["price_structure", "price"], lead: "What we publish about fixed fees:" },
  ],
  callout_fee: [
    { id: "pr_callout_amount", question: "How much is the callout fee?", topic: "pricing", factKeys: ["callout_fee", "price"], lead: "Our published callout fee:" },
    { id: "pr_included", question: "Is the callout fee included in the job?", topic: "pricing", factKeys: ["callout_fee", "price_structure"], lead: "What we publish about the callout fee:" },
  ],
  callout_plus_hourly: [
    { id: "pr_hourly", question: "What is your hourly rate?", topic: "pricing", factKeys: ["price", "price_structure"], lead: "Our published rates:" },
    { id: "pr_callout_amount", question: "How much is the callout fee?", topic: "pricing", factKeys: ["callout_fee", "price"], lead: "Our published callout fee:" },
  ],
  service_plans: [
    { id: "pr_plan_cost", question: "What do your service plans cost?", topic: "pricing", factKeys: ["service_plan", "price"], lead: "Our published plan pricing:" },
    { id: "pr_plan_cancel", question: "Can I cancel a service plan?", topic: "cancellation", factKeys: ["cancellation_policy", "service_plan"], lead: "What we publish about cancelling a plan:" },
  ],
  menu_pricing: [
    { id: "pr_price_list", question: "Do you have a price list?", topic: "pricing", factKeys: ["price", "price_structure"], lead: "Our published prices:" },
    { id: "pr_parts", question: "Are parts included in the price?", topic: "pricing", factKeys: ["price_structure", "product"], lead: "What we publish about what's included:" },
  ],
  per_hour_or_room: [
    { id: "pr_hour_or_room", question: "Do you charge by the hour or by the room?", topic: "pricing", factKeys: ["price_structure", "price"], lead: "Our published pricing basis:" },
    { id: "pr_regular_discount", question: "Is a regular booking cheaper?", topic: "pricing", factKeys: ["price_structure", "service_plan"], lead: "What we publish about regular bookings:" },
  ],
};

const PHOTO_TRIAGE_QUESTIONS: readonly TemplateQuestion[] = [
  { id: "photo_send", question: "Can I send a photo of the problem?", topic: "photo", factKeys: ["photo_triage", "contact_whatsapp", "contact_email"], lead: "How to send us a photo:" },
  {
    id: "photo_price",
    question: "Can you tell me what it will cost from a photo?",
    topic: "photo",
    factKeys: ["photo_triage_pricing"],
    lead: "What we publish about pricing from photos:",
    // Never answered from a photo, even where a price fact exists: the owner
    // prices (§21, photo_assessments.price_cents is never agent-written).
    refusal: "I can't price from a photo — I'll pass it to the owner, who'll come back to you with a figure.",
  },
];

const VERTICAL_QUESTIONS: Record<string, readonly TemplateQuestion[]> = {
  roofing: [
    { id: "v_roof_leak", question: "Do you fix roof leaks?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_roof_flat", question: "Do you work on flat roofs?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_roof_emergency", question: "Do you do emergency roof repairs?", topic: "emergency", factKeys: ["emergency", "out_of_hours"], lead: "What we publish about emergency work:" },
    { id: "v_roof_insurance", question: "Do you handle insurance claims?", topic: "process", factKeys: ["insurance_claim", "process"], lead: "What we publish about insurance work:" },
    { id: "v_roof_scaffold", question: "Will you need scaffolding?", topic: "process", factKeys: ["process", "service"], lead: "What we publish about access equipment:" },
    { id: "v_roof_survey", question: "Do you offer a roof survey?", topic: "services", factKeys: ["service", "quote_process"], lead: "What we publish about surveys:" },
  ],
  accountant: [
    { id: "v_acc_self_assessment", question: "Do you handle self-assessment?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_acc_company", question: "Can you file company accounts?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_acc_payroll", question: "Do you offer payroll?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_acc_software", question: "Which accounting software do you work with?", topic: "services", factKeys: ["brand", "product"], lead: "The software we publish support for:" },
    { id: "v_acc_new_clients", question: "Are you taking on new clients?", topic: "process", factKeys: ["onboarding", "process"], lead: "What we publish about taking on clients:" },
    { id: "v_acc_ltd_fees", question: "What are your fees for a limited company?", topic: "pricing", factKeys: ["price_structure", "price"], lead: "Our published fees:" },
  ],
  lawyer: [
    { id: "v_law_areas", question: "What areas of law do you handle?", topic: "services", factKeys: ["service"], lead: "The areas we publish are:" },
    { id: "v_law_first_meeting", question: "Do you offer a first consultation?", topic: "booking", factKeys: ["consultation", "booking"], lead: "What we publish about first consultations:" },
    { id: "v_law_regulated", question: "Are you regulated?", topic: "credentials", factKeys: ["certification", "membership"], lead: "The regulatory details we publish are:" },
    { id: "v_law_fixed_fee", question: "Do you offer fixed fees?", topic: "pricing", factKeys: ["price_structure"], lead: "What we publish about fees:" },
    { id: "v_law_become_client", question: "How do I become a client?", topic: "process", factKeys: ["onboarding", "process"], lead: "The process we publish is:" },
    { id: "v_law_other_areas", question: "Can you help with a matter outside your usual areas?", topic: "services", factKeys: ["service", "service_exclusion"], lead: "The areas we publish are:" },
  ],
  pest_control: [
    { id: "v_pest_types", question: "What pests do you treat?", topic: "services", factKeys: ["service"], lead: "The treatments we publish are:" },
    { id: "v_pest_visits", question: "How many visits does treatment take?", topic: "process", factKeys: ["process", "service"], lead: "What we publish about treatment visits:" },
    { id: "v_pest_leave", question: "Do I need to leave the property?", topic: "process", factKeys: ["process"], lead: "What we publish about preparing for a visit:" },
    { id: "v_pest_commercial", question: "Do you treat commercial premises?", topic: "commercial", factKeys: ["commercial", "service"], lead: "What we publish about commercial work:" },
    { id: "v_pest_wasps", question: "Do you deal with wasp nests?", topic: "services", factKeys: ["service"], lead: "The treatments we publish are:" },
    { id: "v_pest_report", question: "Do you provide a report afterwards?", topic: "process", factKeys: ["process"], lead: "What we publish about reports:" },
  ],
  landscaping: [
    { id: "v_land_design", question: "Do you do garden design?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_land_maintenance", question: "Do you offer regular maintenance?", topic: "services", factKeys: ["service", "service_plan"], lead: "The services we publish are:" },
    { id: "v_land_waste", question: "Do you take the waste away?", topic: "process", factKeys: ["process", "service"], lead: "What we publish about waste:" },
    { id: "v_land_hard", question: "Do you do fencing and paving?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_land_winter", question: "Do you work through the winter?", topic: "hours", factKeys: ["hours", "service"], lead: "What we publish about seasonal work:" },
    { id: "v_land_examples", question: "Can I see gardens you've done?", topic: "experience", factKeys: ["portfolio", "gallery_url"], lead: "Where our work is published:" },
  ],
  electrician: [
    { id: "v_elec_rewire", question: "Do you do rewires?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_elec_certificate", question: "Do you issue a certificate for the work?", topic: "process", factKeys: ["certification", "process"], lead: "What we publish about certificates:" },
    { id: "v_elec_ev", question: "Do you install EV chargers?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_elec_fuseboard", question: "Do you upgrade fuse boards?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_elec_landlord", question: "Do you do landlord safety checks?", topic: "commercial", factKeys: ["service", "commercial"], lead: "The services we publish are:" },
    { id: "v_elec_emergency", question: "Do you cover electrical emergencies?", topic: "emergency", factKeys: ["emergency", "out_of_hours"], lead: "What we publish about emergency work:" },
  ],
  plumber: [
    { id: "v_plumb_leak", question: "Do you fix leaks?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_plumb_boiler", question: "Do you install boilers?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_plumb_bathroom", question: "Do you fit bathrooms?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_plumb_drains", question: "Do you unblock drains?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_plumb_emergency", question: "Do you cover emergencies out of hours?", topic: "emergency", factKeys: ["emergency", "out_of_hours"], lead: "What we publish about emergency work:" },
    { id: "v_plumb_service", question: "Do you service boilers?", topic: "services", factKeys: ["service", "service_plan"], lead: "The services we publish are:" },
  ],
  hvac: [
    { id: "v_hvac_install", question: "Do you install air conditioning?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_hvac_service", question: "Do you service existing units?", topic: "services", factKeys: ["service", "service_plan"], lead: "The services we publish are:" },
    { id: "v_hvac_heatpump", question: "Do you repair heat pumps?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_hvac_contract", question: "Do you offer maintenance contracts?", topic: "commercial", factKeys: ["service_plan", "commercial"], lead: "What we publish about maintenance contracts:" },
    { id: "v_hvac_brands", question: "Which brands do you install?", topic: "services", factKeys: ["brand", "product"], lead: "The brands we publish are:" },
    { id: "v_hvac_commercial", question: "Do you work on commercial systems?", topic: "commercial", factKeys: ["commercial", "service"], lead: "What we publish about commercial work:" },
  ],
  auto_repair: [
    { id: "v_auto_mot", question: "Do you do MOTs?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_auto_make", question: "Do you work on my make of car?", topic: "services", factKeys: ["brand", "service"], lead: "The makes we publish work on:" },
    { id: "v_auto_courtesy", question: "Do you offer a courtesy car?", topic: "services", factKeys: ["service", "process"], lead: "What we publish about courtesy cars:" },
    { id: "v_auto_wait", question: "Can I wait while the work is done?", topic: "process", factKeys: ["process", "hours"], lead: "What we publish about waiting:" },
    { id: "v_auto_diagnostics", question: "Do you do diagnostics?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_auto_parts", question: "Do you supply parts?", topic: "services", factKeys: ["product", "service"], lead: "What we publish about parts:" },
  ],
  cleaning: [
    { id: "v_clean_products", question: "Do you bring your own products?", topic: "process", factKeys: ["process", "service"], lead: "What we publish about equipment and products:" },
    { id: "v_clean_tenancy", question: "Do you do end-of-tenancy cleans?", topic: "services", factKeys: ["service"], lead: "The services we publish are:" },
    { id: "v_clean_regular", question: "Do you do regular weekly cleans?", topic: "services", factKeys: ["service", "service_plan"], lead: "The services we publish are:" },
    { id: "v_clean_insured", question: "Are your cleaners insured?", topic: "credentials", factKeys: ["insurance"], lead: "What we publish about insurance:" },
    { id: "v_clean_offices", question: "Do you clean offices?", topic: "commercial", factKeys: ["commercial", "service"], lead: "What we publish about commercial work:" },
    { id: "v_clean_home", question: "Do I need to be home?", topic: "process", factKeys: ["process"], lead: "What we publish about access on the day:" },
  ],
};

/**
 * How a single published fact becomes its own question. Only fact keys whose
 * values are noun phrases appear here — a published price line is answered by
 * the pricing block above, not bent into a question it does not fit. This is
 * where a rich KB gets from ~60 template pairs to the 150–250 target.
 */
export const FACT_QUESTION_FORMS: Record<string, { topic: string; question: (v: string) => string; lead: string }> = {
  service: { topic: "services", question: (v) => `Do you offer ${v}?`, lead: "Yes — this is one of the services we publish:" },
  service_area: { topic: "service_area", question: (v) => `Do you cover ${v}?`, lead: "Yes — this is in the service area we publish:" },
  payment_method: { topic: "payment", question: (v) => `Can I pay by ${v}?`, lead: "Yes — this is a payment method we publish:" },
  brand: { topic: "services", question: (v) => `Do you work with ${v}?`, lead: "Yes — we publish that we work with:" },
  product: { topic: "services", question: (v) => `Do you supply ${v}?`, lead: "Yes — we publish that we supply:" },
  language: { topic: "language", question: (v) => `Do you speak ${v}?`, lead: "Yes — we publish that we speak:" },
  specialism: { topic: "services", question: (v) => `Do you specialise in ${v}?`, lead: "Yes — we publish that we specialise in:" },
  service_plan: { topic: "services", question: (v) => `What is included in ${v}?`, lead: "What we publish about this plan:" },
};

interface YamlRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): YamlRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as YamlRecord) : {};
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function refusalRules(raw: unknown): RefusalRule[] {
  return asArray(raw).map((entry) => {
    const row = asRecord(entry);
    return {
      id: asString(row["id"], "unnamed_refusal"),
      matches: asArray(row["matches"]).map((m) => asString(m)).filter((m) => m.length > 0),
      reason: asString(row["reason"], "Prohibited claim for this vertical"),
    };
  });
}

/**
 * Compose the template for a vertical from config/playbooks.yaml. The playbook
 * decides which blocks apply; nothing here is inferred from the business.
 * A prohibited or unknown vertical throws — the Architect may only classify
 * AGAINST this file, and a pack for a vertical we refuse must not exist.
 */
export function loadVerticalTemplate(vertical: string): VerticalTemplate {
  const { data, version } = config.playbooks();
  const playbooks = asRecord(data);
  const verticals = asRecord(playbooks["verticals"]);
  const row = verticals[vertical];
  if (row === undefined) {
    const prohibited = asRecord(playbooks["prohibited"]);
    const why = prohibited[vertical] !== undefined
      ? asString(asRecord(prohibited[vertical])["reason"], "prohibited vertical")
      : "not in the playbooks";
    throw new Error(`No Q&A template for vertical '${vertical}': ${why}`);
  }
  const spec = asRecord(row);
  const bookingModel = asString(spec["booking_model"], "quote_request");
  const pricing = asString(spec["pricing"], "never_published");
  const photoTriage = spec["photo_triage"] === true;
  const agentEval = asRecord(playbooks["agent_eval"]);

  const questions: TemplateQuestion[] = [
    ...UNIVERSAL_QUESTIONS,
    ...(BOOKING_MODEL_QUESTIONS[bookingModel] ?? []),
    ...(PRICING_QUESTIONS[pricing] ?? []),
    ...(photoTriage ? PHOTO_TRIAGE_QUESTIONS : []),
    ...(VERTICAL_QUESTIONS[vertical] ?? []),
  ];

  return {
    vertical,
    label: asString(spec["label"], vertical),
    playbookVersion: version,
    bookingModel,
    pricing,
    photoTriage,
    questions,
    // Universal refusals first: the vertical set adds to them, never narrows them.
    refusals: [...refusalRules(playbooks["universal_refusals"]), ...refusalRules(spec["refusals"])],
    minPackPairs: asNumber(agentEval["min_pack_pairs"], 40),
    targetPackPairs: asNumber(agentEval["target_pack_pairs"], 150),
  };
}

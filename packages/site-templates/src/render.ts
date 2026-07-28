// Static-site generator (spec §19, §41, §59). The scaffold is deterministic;
// the model fills six copy slots only. Output is a single self-contained HTML
// document with inlined critical CSS and no external requests — under 50KB
// before images, so it renders in under 1s on 3G. Forms are real POST forms
// that work with JavaScript disabled (the site is statically readable — the
// AI-visibility claim depends on it). Preview mode adds the disclaimer banner,
// noindex, the consent checkbox and the "this isn't for me" suppression link.
import { config } from "@adw/config";
import { buildJsonLd, machineSurfaceHead, type MachineSurfaceInput } from "./machine-surface.ts";
import { agentWidget, agentWidgetCss, agentWidgetScript, type AgentWidgetOptions } from "./agent-widget.ts";
import {
  DEFAULT_LAYOUT,
  LAYOUT_SECTIONS,
  TemplateVariantError,
  type ColorSystem,
  type LayoutId,
  type TemplateFamily,
  type TypePairing,
} from "./families/types.ts";

export interface BusinessRecord {
  name: string;
  category: string;
  city: string;
  phone: string;
  hours?: string;
  reviewCount?: number;
  rating?: number;
}

export interface CopySlots {
  headline: string;
  services: { title: string; blurb: string }[];
  about: string;
  cta: string;
}

export interface RenderOptions {
  family: string;
  business: BusinessRecord;
  copy: CopySlots;
  locale: string;
  mode: "preview" | "full";
  legalEntity: string;
  legalAddress: string;
  labelVersion: string;
  claimToken?: string;
  formAction: string; // Cloudflare Worker endpoint (or demo host)
  // --- Template-family variants (spec §59). All optional: omitting every one of
  // them reproduces the pre-§59 output byte for byte, so existing callers and
  // their goldens are untouched. ---
  /**
   * Structured facts for the machine surface. Supplying it upgrades the page
   * from "has schema" to "is transactable" — Service per offering, Offer where
   * a price is published, hours, coverage, verified credentials.
   */
  machine?: MachineSurfaceInput;
  /**
   * The live agent. Supplying it is what makes a preview persuasive: an owner
   * asking their own receptionist what they charge and getting the right answer
   * is the hook the acquisition model rests on (§22.1).
   */
  agent?: AgentWidgetOptions;
  familyDef?: TemplateFamily;
  colorSystem?: string; // ColorSystem id within familyDef.tokens
  typePairing?: string; // TypePairing id within familyDef.tokens
  layout?: LayoutId;
}

export class SlotViolationError extends Error {}

/** Enforce the copy-slot character ranges before render (spec §59.2). */
export function validateSlots(copy: CopySlots): void {
  const slots = config.templates().data.copy_slots as Record<string, { min: number; max: number }>;
  const check = (name: string, value: string) => {
    const range = slots[name];
    if (!range) return;
    if (value.length < range.min || value.length > range.max) {
      throw new SlotViolationError(`slot ${name} length ${value.length} outside [${range.min}, ${range.max}]`);
    }
  };
  check("headline", copy.headline);
  check("about", copy.about);
  check("cta", copy.cta);
  for (const s of copy.services) check("service_blurb", s.blurb);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CRITICAL_CSS = `*{box-sizing:border-box;margin:0}html{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#1a2233}
body{max-width:920px;margin:0 auto;padding:0 16px}
a{color:#1155cc}img{max-width:100%;height:auto}
.hero{padding:48px 0 32px;text-align:center}.hero h1{font-size:clamp(1.6rem,5vw,2.6rem);line-height:1.15}
.hero p{color:#516;margin-top:12px;font-size:1.1rem;color:#556}
.cta{display:inline-block;margin-top:20px;background:#0a5;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600}
.services{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;padding:24px 0}
.card{border:1px solid #e3e8ef;border-radius:10px;padding:18px}.card h3{font-size:1.1rem;margin-bottom:6px}
.about{padding:24px 0;max-width:640px}
.contact{padding:24px 0;border-top:1px solid #eef}.contact label{display:block;margin:8px 0 4px;font-weight:600}
.contact input,.contact textarea{width:100%;padding:10px;border:1px solid #cfd8e3;border-radius:6px;font:inherit}
.banner{background:#fff8e1;border:1px solid #ffe082;padding:10px 14px;border-radius:8px;margin:12px 0;font-size:.92rem}
footer{padding:24px 0;color:#667;font-size:.86rem;border-top:1px solid #eef;margin-top:24px}
.consent{margin:12px 0;font-size:.92rem}.btn{background:#0a5;color:#fff;border:0;padding:12px 20px;border-radius:8px;font-weight:600;cursor:pointer}`;

// Layout-specific CSS. Appended only for the non-default layouts, so the default
// document is unchanged from before template families existed.
const LAYOUT_CSS: Partial<Record<LayoutId, string>> = {
  "hero-gallery-contact": `
.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px;padding:24px 0}
.gallery figure{margin:0;border:1px solid #e3e8ef;border-radius:10px;padding:16px}
.gallery figcaption{margin-top:6px;font-size:.95rem}
.gallery h3{font-size:1.05rem;margin-bottom:4px}
.hero-about{max-width:640px;margin:18px auto 0;text-align:left}`,
  "hero-menu-about-contact": `
.menu{padding:24px 0}.menu dl{margin:0}
.menu dt{font-weight:700;margin-top:16px;font-size:1.05rem}
.menu dd{margin:4px 0 0;padding-bottom:12px;border-bottom:1px dotted #d7dee8}`,
};

/**
 * The chosen colour system and type pairing as CSS custom properties, plus the
 * handful of rules that consume them. Custom properties (not find-and-replace)
 * so a family swap is one declaration block, and the tokens stay inspectable in
 * the shipped document.
 */
function tokenCss(color: ColorSystem | undefined, type: TypePairing | undefined): string {
  if (!color && !type) return "";
  const vars: string[] = [];
  if (color) {
    vars.push(
      `--adw-primary:${color.primary}`,
      `--adw-accent:${color.accent}`,
      `--adw-surface:${color.surface}`,
      `--adw-text:${color.text}`,
    );
  }
  if (type) {
    vars.push(`--adw-heading:${type.headingStack}`, `--adw-body:${type.bodyStack}`, `--adw-scale:${type.scale}`);
  }
  const rules: string[] = [`:root{${vars.join(";")}}`];
  if (color) {
    rules.push(
      `html{color:var(--adw-text);background:var(--adw-surface)}`,
      `a{color:var(--adw-primary)}`,
      `.hero p{color:var(--adw-text)}`,
      `.cta,.btn{background:var(--adw-primary);color:#fff}`,
      `.card,.gallery figure{border-color:var(--adw-accent)}`,
      `footer{color:var(--adw-text)}`,
    );
  }
  if (type) {
    rules.push(
      `html{font-family:var(--adw-body)}`,
      `h1,h2,h3{font-family:var(--adw-heading)}`,
      `h1{font-size:clamp(1.6rem,5vw,calc(1.6rem * var(--adw-scale)))}`,
    );
  }
  return "\n" + rules.join("\n");
}

/** Resolve the colour system for a render, defaulting to the family's first. */
function pickColor(fam: TemplateFamily | undefined, id: string | undefined): ColorSystem | undefined {
  if (!fam) return undefined;
  if (id === undefined) return fam.tokens.colorSystems[0];
  const found = fam.tokens.colorSystems.find((c) => c.id === id);
  if (!found) throw new TemplateVariantError(`family ${fam.id} has no colour system ${id}`);
  return found;
}

/** Resolve the type pairing for a render, defaulting to the family's first. */
function pickType(fam: TemplateFamily | undefined, id: string | undefined): TypePairing | undefined {
  if (!fam) return undefined;
  if (id === undefined) return fam.tokens.typePairings[0];
  const found = fam.tokens.typePairings.find((t) => t.id === id);
  if (!found) throw new TemplateVariantError(`family ${fam.id} has no type pairing ${id}`);
  return found;
}

/** Resolve the layout: explicit > family default > pre-§59 default. */
function pickLayout(fam: TemplateFamily | undefined, id: LayoutId | undefined): LayoutId {
  if (id !== undefined) {
    if (fam && !fam.layouts.includes(id)) {
      throw new TemplateVariantError(`family ${fam.id} does not offer layout ${id}`);
    }
    return id;
  }
  return fam?.layouts[0] ?? DEFAULT_LAYOUT;
}

/** Render a complete self-contained HTML document. */
export function renderSite(opts: RenderOptions): string {
  validateSlots(opts.copy);
  const b = opts.business;
  const isPreview = opts.mode === "preview";

  // The machine surface is the product (§38.3). When the caller supplies the
  // structured facts the knowledge base extracted — offerings, hours, coverage,
  // verified credentials — we emit the full graph: one Service per offering,
  // Offer only where a price was genuinely published. Without them we fall back
  // to the bare LocalBusiness node, which is what the market already has and
  // what the Reviewer's machine-surface gates will flag.
  const schema = opts.machine
    ? buildJsonLd({
        ...opts.machine,
        name: opts.machine.name || b.name,
        category: opts.machine.category || b.category,
        city: opts.machine.city || b.city,
        phone: opts.machine.phone || b.phone,
        ...(opts.machine.rating === undefined && b.rating !== undefined ? { rating: b.rating } : {}),
        ...(opts.machine.reviewCount === undefined && b.reviewCount !== undefined
          ? { reviewCount: b.reviewCount }
          : {}),
      })
    : {
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        name: b.name,
        telephone: b.phone,
        address: { "@type": "PostalAddress", addressLocality: b.city },
        ...(b.rating ? { aggregateRating: { "@type": "AggregateRating", ratingValue: b.rating, reviewCount: b.reviewCount ?? 0 } } : {}),
      };

  const banner = isPreview
    ? `<div class="banner" data-label-version="${esc(opts.labelVersion)}">Unofficial preview created by ${esc(opts.legalEntity)} — not affiliated with this business. You pay nothing until you approve this. 30-day money-back guarantee.</div>`
    : "";

  const consent = isPreview
    ? `<div class="consent"><label><input type="checkbox" name="sms_consent" value="1"> Text me updates about my website</label>
       <label for="phone">Your phone</label><input id="phone" name="phone" type="tel" autocomplete="tel"></div>
       <p style="margin-top:10px"><a href="${esc(opts.formAction)}?action=not_for_me&token=${esc(opts.claimToken ?? "")}">This isn't for me</a></p>`
    : "";

  const layout = pickLayout(opts.familyDef, opts.layout);
  const color = pickColor(opts.familyDef, opts.colorSystem);
  const type = pickType(opts.familyDef, opts.typePairing);
  const sections = LAYOUT_SECTIONS[layout];

  // --- Section builders. The layout picks which ones run and in what order;
  // each emits genuinely different markup, not a re-skin of one blob. ---

  // The gallery layout drops the standalone About section, so the about copy
  // rides in the hero instead — no layout ever silently discards a copy slot.
  const heroAbout =
    layout === "hero-gallery-contact" ? `\n<p class="hero-about">${esc(opts.copy.about)}</p>` : "";

  const hero = `<header class="hero">
<h1>${esc(opts.copy.headline)}</h1>
<p>${esc(b.category)} in ${esc(b.city)}${b.rating ? ` · ${b.rating}★ (${b.reviewCount} reviews)` : ""}</p>${heroAbout}
<a class="cta" href="#contact">${esc(opts.copy.cta)}</a>
</header>`;

  const servicesSection = `<section class="services" aria-label="Services">${opts.copy.services
    .map((s) => `<div class="card"><h3>${esc(s.title)}</h3><p>${esc(s.blurb)}</p></div>`)
    .join("")}</section>`;

  const gallerySection = `<section class="gallery" aria-label="Our work">${opts.copy.services
    .map(
      (s) =>
        `<figure><h3>${esc(s.title)}</h3><figcaption>${esc(s.blurb)}</figcaption></figure>`,
    )
    .join("")}</section>`;

  const menuSection = `<section class="menu" aria-label="Menu">
<h2>Menu</h2>
<dl>${opts.copy.services.map((s) => `<dt>${esc(s.title)}</dt><dd>${esc(s.blurb)}</dd>`).join("")}</dl>
</section>`;

  const aboutSection = `<section class="about"><h2>About</h2><p>${esc(opts.copy.about)}</p></section>`;

  const contactSection = `<section class="contact" id="contact">
<h2>Contact ${esc(b.name)}</h2>
<form method="post" action="${esc(opts.formAction)}">
<label for="name">Your name</label><input id="name" name="name" required autocomplete="name">
<label for="email">Your email</label><input id="email" name="email" type="email" required autocomplete="email">
<label for="message">How can we help?</label><textarea id="message" name="message" rows="3"></textarea>
${consent}
<p style="margin-top:12px"><button class="btn" type="submit">${esc(opts.copy.cta)}</button></p>
</form>
<p style="margin-top:12px">Call us: <a href="tel:${esc(b.phone)}">${esc(b.phone)}</a></p>
</section>`;

  const agentSection = opts.agent ? agentWidget(opts.agent) : "";

  const bySection: Record<string, string> = {
    hero,
    services: servicesSection,
    gallery: gallerySection,
    menu: menuSection,
    about: aboutSection,
    contact: contactSection,
  };
  // The agent sits immediately after the hero — above the fold on a phone,
  // because it is the thing that has to be tried, not scrolled past.
  const mainSections = [
    agentSection,
    ...sections.filter((s) => s !== "hero").map((s) => bySection[s] ?? ""),
  ].filter((x) => x !== "");

  const styles =
    CRITICAL_CSS + (LAYOUT_CSS[layout] ?? "") + tokenCss(color, type) + (opts.agent ? agentWidgetCss() : "");
  // data-* markers only appear when a family/layout was explicitly selected, so
  // the legacy call path stays byte-identical.
  const bodyAttrs =
    opts.familyDef || opts.layout
      ? ` data-family="${esc(opts.familyDef?.id ?? opts.family)}" data-layout="${esc(layout)}"`
      : "";

  const html = `<!doctype html>
<html lang="${esc(opts.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${isPreview ? '<meta name="robots" content="noindex, nofollow">' : ""}
<title>${esc(b.name)} — ${esc(b.category)} in ${esc(b.city)}</title>
<meta name="description" content="${esc(opts.copy.headline)}">
${machineSurfaceHead()}
<style>${styles}</style>
<script type="application/ld+json">${JSON.stringify(schema)}</script>
</head>
<body${bodyAttrs}>
${banner}
${hero}
<main>
${mainSections.join("\n")}
</main>
${opts.agent ? agentWidgetScript() : ""}
<footer>
${esc(opts.legalEntity)} · ${esc(opts.legalAddress)}${isPreview ? " · This is an unofficial preview." : ""}
· <a href="/privacy">Privacy</a>
</footer>
</body>
</html>`;
  return html;
}

/** The llms.txt companion file (spec §5 quality gate, AI visibility). */
export function renderLlmsTxt(b: BusinessRecord, copy: CopySlots): string {
  return `# ${b.name}\n\n> ${copy.headline}\n\n${b.category} serving ${b.city}. Phone: ${b.phone}.\n\n## Services\n${copy.services.map((s) => `- ${s.title}: ${s.blurb}`).join("\n")}\n`;
}

/** Approximate byte weight of the rendered document (for the reviewer gate). */
export function weightKb(html: string): number {
  return Buffer.byteLength(html, "utf8") / 1024;
}

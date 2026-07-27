// Static-site generator (spec §19, §41, §59). The scaffold is deterministic;
// the model fills six copy slots only. Output is a single self-contained HTML
// document with inlined critical CSS and no external requests — under 50KB
// before images, so it renders in under 1s on 3G. Forms are real POST forms
// that work with JavaScript disabled (the site is statically readable — the
// AI-visibility claim depends on it). Preview mode adds the disclaimer banner,
// noindex, the consent checkbox and the "this isn't for me" suppression link.
import { config } from "@adw/config";

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

/** Render a complete self-contained HTML document. */
export function renderSite(opts: RenderOptions): string {
  validateSlots(opts.copy);
  const b = opts.business;
  const isPreview = opts.mode === "preview";

  const schema = {
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

  const services = opts.copy.services
    .map((s) => `<div class="card"><h3>${esc(s.title)}</h3><p>${esc(s.blurb)}</p></div>`)
    .join("");

  const html = `<!doctype html>
<html lang="${esc(opts.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${isPreview ? '<meta name="robots" content="noindex, nofollow">' : ""}
<title>${esc(b.name)} — ${esc(b.category)} in ${esc(b.city)}</title>
<meta name="description" content="${esc(opts.copy.headline)}">
<link rel="alternate" type="text/plain" href="/llms.txt">
<style>${CRITICAL_CSS}</style>
<script type="application/ld+json">${JSON.stringify(schema)}</script>
</head>
<body>
${banner}
<header class="hero">
<h1>${esc(opts.copy.headline)}</h1>
<p>${esc(b.category)} in ${esc(b.city)}${b.rating ? ` · ${b.rating}★ (${b.reviewCount} reviews)` : ""}</p>
<a class="cta" href="#contact">${esc(opts.copy.cta)}</a>
</header>
<main>
<section class="services" aria-label="Services">${services}</section>
<section class="about"><h2>About</h2><p>${esc(opts.copy.about)}</p></section>
<section class="contact" id="contact">
<h2>Contact ${esc(b.name)}</h2>
<form method="post" action="${esc(opts.formAction)}">
<label for="name">Your name</label><input id="name" name="name" required autocomplete="name">
<label for="email">Your email</label><input id="email" name="email" type="email" required autocomplete="email">
<label for="message">How can we help?</label><textarea id="message" name="message" rows="3"></textarea>
${consent}
<p style="margin-top:12px"><button class="btn" type="submit">${esc(opts.copy.cta)}</button></p>
</form>
<p style="margin-top:12px">Call us: <a href="tel:${esc(b.phone)}">${esc(b.phone)}</a></p>
</section>
</main>
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

import { useEffect, useRef, useState } from "react";
import { Badge, Card, Counter, Reveal, useTheme } from "@adw/ui";

/* Brand name is a single swappable constant, per the design brief. */
const BRAND = "ADW";
const TAGLINE = "Autonomous Website Foundry";

/* ---------- Content ---------- */
type Stat = { to: number; decimals?: number; prefix?: string; suffix?: string; label: string };
const STATS: Stat[] = [
  { to: 2180, suffix: "+", label: "sites live" },
  { to: 24, suffix: "h", label: "avg delivery" },
  { to: 4.8, decimals: 1, suffix: "★", label: "avg rating" },
  { to: 99.9, decimals: 1, suffix: "%", label: "uptime" },
];

const TRUST = ["Trades", "Salons", "Cafés", "Auto shops", "Clinics", "Studios"];

type Feature = { icon: string; title: string; blurb: string };
const FEATURES: Feature[] = [
  { icon: "🚀", title: "Live in 24 hours", blurb: "Answer a few questions. We write, design, and launch your site inside a single business day." },
  { icon: "✨", title: "Unlimited AI edits", blurb: "Text us the change you want. New hours, a new photo, a fresh offer — live in minutes, no dev queue." },
  { icon: "🤖", title: "Found by AI assistants", blurb: "Structured for ChatGPT, Gemini, and search, so customers find you wherever they start looking." },
  { icon: "🌐", title: "You own your domain", blurb: "Your domain, your content, your customers. Export everything anytime — there is no lock-in." },
  { icon: "🛡️", title: "30-day guarantee", blurb: "Not thrilled in the first 30 days? Full refund, no forms and no awkward phone call required." },
  { icon: "✌️", title: "Cancel in two clicks", blurb: "No contracts, ever. Pause or cancel straight from your dashboard whenever it suits you." },
];

type Step = { title: string; blurb: string };
const STEPS: Step[] = [
  { title: "Tell us about you", blurb: "A three-minute questionnaire: your name, services, hours, and a few photos." },
  { title: "We build it for you", blurb: "The foundry writes your copy, designs the pages, and wires up your booking and contact forms." },
  { title: "Review & go live", blurb: "See your site, request tweaks by text, approve. It is online within 24 hours." },
  { title: "We keep it growing", blurb: "Unlimited edits, fresh content, and AI-ready structure — all handled for you, month after month." },
];

type Tier = {
  name: string;
  desc: string;
  monthly: number;
  build: number;
  features: string[];
  cta: string;
  featured?: boolean;
};
const TIERS: Tier[] = [
  {
    name: "Starter",
    desc: "For a single location getting online fast.",
    monthly: 60,
    build: 329,
    features: ["5-page custom site", "Mobile-perfect design", "Contact & click-to-call", "Unlimited AI edits", "Free managed hosting"],
    cta: "Start with Starter",
  },
  {
    name: "Pro",
    desc: "For growing businesses that want to be found.",
    monthly: 65,
    build: 349,
    features: ["Everything in Starter", "Online booking & forms", "AI-assistant optimization", "Reviews on autopilot", "Priority 4-hour edits"],
    cta: "Get started with Pro",
    featured: true,
  },
  {
    name: "Scale",
    desc: "For multi-location brands and franchises.",
    monthly: 95,
    build: 499,
    features: ["Everything in Pro", "Up to 5 locations", "Local landing pages", "Analytics dashboard", "Dedicated success manager"],
    cta: "Talk to us",
  },
];

type Faq = { q: string; a: string };
const FAQS: Faq[] = [
  { q: "Is it really live in 24 hours?", a: "Yes. Once you finish the short questionnaire, our foundry builds a complete first draft the same day. Most sites are reviewed, tweaked, and live within one business day." },
  { q: "Do I own my website and domain?", a: "Completely. The domain is registered in your name and the content is yours. If you ever leave, you can export the whole site — no hostage situations." },
  { q: "What if I don't like it?", a: "Every plan is backed by a 30-day money-back guarantee. If it's not right for you in the first month, we refund you in full — no forms, no friction." },
  { q: "Can I make changes after launch?", a: "As many as you like. Just message us what you want changed and it goes live in minutes. Unlimited edits are included on every plan." },
  { q: "Do you work with my type of business?", a: "If you serve local customers, yes. We specialize in trades, salons, cafés, auto shops, clinics, and studios — but the foundry adapts to almost any small business." },
  { q: "Is there a contract?", a: "None. Plans are month-to-month and you can cancel from your dashboard in two clicks. We'd rather earn your renewal than trap you in a term." },
];

const NAV = [
  { label: "Product", href: "#features" },
  { label: "How it works", href: "#how" },
  { label: "Pricing", href: "#pricing" },
];

/* ---------- Header backdrop on scroll (IntersectionObserver on a top sentinel) ---------- */
function useScrolled(): [React.RefObject<HTMLDivElement>, boolean] {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (e) setScrolled(!e.isIntersecting);
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [sentinelRef, scrolled];
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ---------- Header ---------- */
function Header({ scrolled }: { scrolled: boolean }) {
  const [theme, toggleTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const close = () => setMenuOpen(false);
  return (
    <>
      <header className={`web-header ${scrolled ? "scrolled" : ""}`.trim()}>
        <div className="adw-container web-header-inner">
          <button className="web-logo" onClick={() => window.scrollTo({ top: 0 })} aria-label={`${BRAND} home`}>
            <span className="web-logo-mark" aria-hidden="true" />
            {BRAND}
          </button>
          <nav className="web-nav" aria-label="Primary">
            {NAV.map((n) => (
              <a key={n.href} href={n.href}>
                {n.label}
              </a>
            ))}
          </nav>
          <div className="web-actions">
            <button
              className="web-icon-btn"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <a className="adw-btn web-desktop-cta" href="#pricing">
              Get started
            </a>
            <button
              className="web-icon-btn web-menu-btn"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Toggle menu"
              aria-expanded={menuOpen}
            >
              {menuOpen ? "✕" : "☰"}
            </button>
          </div>
        </div>
      </header>
      <nav className={`web-mobile-nav ${menuOpen ? "show" : ""}`.trim()} aria-label="Mobile">
        {NAV.map((n) => (
          <a key={n.href} href={n.href} onClick={close}>
            {n.label}
          </a>
        ))}
        <a className="adw-btn" href="#pricing" onClick={close} style={{ justifyContent: "center", marginTop: 6 }}>
          Get started
        </a>
      </nav>
    </>
  );
}

/* ---------- Hero ---------- */
function Hero() {
  return (
    <section className="web-hero" id="top">
      <div className="web-hero-bg" aria-hidden="true" />
      <div className="web-hero-grid" aria-hidden="true" />
      <div className="web-hero-orb" aria-hidden="true" />
      <div className="adw-container">
        <Reveal pop>
          <span className="web-pill">
            <Badge tone="ok">New</Badge>
            AI-ready sites, built and run for you
          </span>
        </Reveal>
        {/* H1 is the LCP element — intentionally not entrance-animated. */}
        <h1>
          A website that <span className="web-grad">runs your business</span>, built for you
        </h1>
        <Reveal>
          <p className="web-hero-sub">
            {BRAND} is the done-for-you website foundry for local businesses. Tell us about your shop and we design, write,
            launch, and maintain a site that wins customers — live in 24 hours.
          </p>
        </Reveal>
        <Reveal>
          <div className="web-cta-row">
            <a className="adw-btn web-btn-lg" href="#pricing">
              Get started
            </a>
            <a className="adw-btn adw-ghost web-btn-lg" href="#how">
              See how it works
            </a>
          </div>
        </Reveal>
        <Reveal>
          <p className="web-hero-note">No contract · 30-day money-back guarantee · Cancel anytime</p>
        </Reveal>

        <div className="web-hero-stats">
          {STATS.map((s, i) => (
            <Reveal key={s.label} pop stagger={i}>
              <div className="web-stat">
                <div className="web-stat-val">
                  <Counter to={s.to} decimals={s.decimals} prefix={s.prefix} suffix={s.suffix} />
                </div>
                <div className="web-stat-label">{s.label}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- Trust strip ---------- */
function Trust() {
  return (
    <section className="web-trust" aria-label="Who we build for">
      <div className="adw-container">
        <p className="web-trust-label">Trusted by local businesses everywhere</p>
        <div className="web-trust-row">
          {TRUST.map((t) => (
            <span className="web-trust-item" key={t}>
              <span aria-hidden="true">{t.charAt(0)}</span>
              {t}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- Features ---------- */
function Features() {
  return (
    <section className="web-section" id="features">
      <div className="adw-container">
        <div className="web-section-head">
          <span className="web-eyebrow">Product</span>
          <h2>Everything a small business needs, handled</h2>
          <p>Not a template you fight with — a finished site, kept fresh, and built to be found by real and AI customers.</p>
        </div>
        <div className="web-features">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} stagger={i}>
              <Card hoverable>
                <div className="web-feature">
                  <div className="web-feature-icon" aria-hidden="true">
                    {f.icon}
                  </div>
                  <h3>{f.title}</h3>
                  <p>{f.blurb}</p>
                </div>
              </Card>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- How it works ---------- */
function How() {
  return (
    <section className="web-section" id="how">
      <div className="adw-container">
        <div className="web-section-head">
          <span className="web-eyebrow">How it works</span>
          <h2>From questionnaire to live site in four steps</h2>
          <p>You spend a few minutes. We do the rest, and keep doing it for as long as you're with us.</p>
        </div>
        <div className="web-steps">
          {STEPS.map((s, i) => (
            <Reveal key={s.title} stagger={i} className="web-step">
              <div className="web-step-num" aria-hidden="true">
                {i + 1}
              </div>
              <h3>{s.title}</h3>
              <p>{s.blurb}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- Pricing ---------- */
function Pricing() {
  return (
    <section className="web-section" id="pricing">
      <div className="adw-container">
        <div className="web-section-head">
          <span className="web-eyebrow">Pricing</span>
          <h2>Simple pricing, no surprises</h2>
          <p>A one-time build fee, then a flat monthly that covers hosting, edits, and everything else. Cancel anytime.</p>
        </div>
        <div className="web-pricing">
          {TIERS.map((t, i) => (
            <Reveal key={t.name} stagger={i} pop>
              <Card className={`web-tier ${t.featured ? "featured" : ""}`.trim()}>
                {t.featured && <span className="web-tier-badge">Most popular</span>}
                <h3>{t.name}</h3>
                <p className="web-tier-desc">{t.desc}</p>
                <div className="web-tier-price">
                  <span className="amount">${t.monthly}</span>
                  <span className="per">/ month</span>
                </div>
                <p className="web-tier-build">
                  + <strong>${t.build}</strong> one-time build
                </p>
                <ul>
                  {t.features.map((f) => (
                    <li key={f}>
                      <span className="check" aria-hidden="true">
                        ✓
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
                <a className={`adw-btn ${t.featured ? "" : "adw-ghost"}`.trim()} href="#cta">
                  {t.cta}
                </a>
              </Card>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- FAQ ---------- */
function FaqSection() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className="web-section" id="faq">
      <div className="adw-container">
        <div className="web-section-head">
          <span className="web-eyebrow">FAQ</span>
          <h2>Questions, answered</h2>
          <p>Everything you might want to know before you get started.</p>
        </div>
        <div className="web-faq-list">
          {FAQS.map((f, i) => {
            const isOpen = open === i;
            return (
              <div className={`web-faq-item ${isOpen ? "open" : ""}`.trim()} key={f.q}>
                <button
                  className="web-faq-q"
                  aria-expanded={isOpen}
                  aria-controls={`faq-a-${i}`}
                  onClick={() => setOpen(isOpen ? null : i)}
                >
                  {f.q}
                  <span className="web-faq-icon" aria-hidden="true">
                    <PlusIcon />
                  </span>
                </button>
                <div className="web-faq-a" id={`faq-a-${i}`} role="region" aria-label={f.q}>
                  <div className="web-faq-a-inner">
                    <p>{f.a}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ---------- Final CTA band ---------- */
function CtaBand() {
  return (
    <section className="web-section" id="cta">
      <div className="adw-container">
        <Reveal pop>
          <div className="web-cta-band">
            <h2>Ready for a website that works as hard as you do?</h2>
            <p>Join {STATS[0]?.to.toLocaleString()}+ local businesses already growing with {BRAND}. Live in 24 hours.</p>
            <div className="web-cta-row">
              <a className="adw-btn web-btn-lg web-btn-invert web-pulse" href="#pricing">
                Get started today
              </a>
              <a className="adw-btn web-btn-lg web-btn-ondark" href="#pricing">
                View pricing
              </a>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- Footer ---------- */
const FOOTER_COLS: { title: string; links: string[] }[] = [
  { title: "Product", links: ["Features", "Pricing", "How it works", "Examples"] },
  { title: "Company", links: ["About", "Careers", "Blog", "Contact"] },
  { title: "Legal", links: ["Terms", "Privacy", "Refund policy"] },
];

function Footer() {
  return (
    <footer className="web-footer">
      <div className="adw-container">
        <div className="web-footer-top">
          <div className="web-footer-brand">
            <button className="web-logo" onClick={() => window.scrollTo({ top: 0 })} aria-label={`${BRAND} home`}>
              <span className="web-logo-mark" aria-hidden="true" />
              {BRAND}
            </button>
            <p>{TAGLINE}. Done-for-you websites for local businesses — built, launched, and maintained so you never touch code.</p>
          </div>
          {FOOTER_COLS.map((col) => (
            <div className="web-footer-col" key={col.title}>
              <h4>{col.title}</h4>
              <ul>
                {col.links.map((l) => (
                  <li key={l}>
                    <a href="#top">{l}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="web-footer-bottom">
          <span>
            © {new Date().getFullYear()} {BRAND}. All rights reserved.
          </span>
          <span className="web-demo-note" aria-label="Demo notice">
            ⚠ Demo build — {BRAND} is a fictional brand, not a real company.
          </span>
        </div>
      </div>
    </footer>
  );
}

/* ---------- App ---------- */
export function App() {
  const [sentinelRef, scrolled] = useScrolled();
  return (
    <div className="web-wrap">
      <div ref={sentinelRef} className="web-sentinel" aria-hidden="true" />
      <Header scrolled={scrolled} />
      <main>
        <Hero />
        <Trust />
        <Features />
        <How />
        <Pricing />
        <FaqSection />
        <CtaBand />
      </main>
      <Footer />
    </div>
  );
}

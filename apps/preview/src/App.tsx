import { useState, type FormEvent } from "react";
import { Badge, Button, Card, Reveal } from "@adw/ui";
import { previewDemo } from "@adw/demo-data";

// The single highest-leverage page in the system (spec §13). It carries the
// consent bridge (an unchecked "text me updates" checkbox) that makes later SMS
// lawful, the mandatory disclaimer banner, the real legal identity, the
// guarantee, a "request changes" box, and a friction-free "this isn't for me"
// suppression link. Loads in under 1s on 3G.

const LEGAL_ENTITY = "ADW Foundry Ltd";
const LEGAL_ADDRESS = "123 Example Street, Suite 400, Toronto, ON M5V 0A1";

export function App() {
  const b = previewDemo;
  const [toast, setToast] = useState<string | null>(null);
  const [changes, setChanges] = useState("");
  const [smsConsent, setSmsConsent] = useState(false); // unchecked by default — required

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  };

  const onClaim = (e: FormEvent) => {
    e.preventDefault();
    // In production this posts to the claim endpoint with the consent event
    // (timestamp, IP, page version, exact wording shown).
    flash(smsConsent ? "Claimed! We'll text you updates." : "Claimed! Check your email.");
  };
  const onRequestChanges = (e: FormEvent) => {
    e.preventDefault();
    if (!changes.trim()) return;
    flash("Sent — we'll get on it.");
    setChanges("");
  };
  const onNotForMe = () => flash("No problem — you won't hear from us again.");

  return (
    <div className="pv-wrap">
      <div className="pv-banner" data-label-version="label-v1">
        <strong>Unofficial preview created by {LEGAL_ENTITY}</strong> — not affiliated with this business. You pay nothing
        until you approve this. 30-day money-back guarantee.
      </div>

      <header className="pv-hero">
        <Reveal>
          <Badge tone="ok">Preview ready</Badge>
        </Reveal>
        <h1>{b.headline}</h1>
        <p className="sub">
          {b.category} in {b.city}
        </p>
        <div className="pv-rating">
          <Badge tone="ok">★ {b.rating}</Badge>
          <span className="adw-muted">{b.reviewCount} reviews</span>
        </div>
      </header>

      <main>
      <section className="pv-services-section" aria-labelledby="services-heading">
        <h2 id="services-heading" className="sr-only">Services</h2>
        <div className="pv-services">
          {b.services.map((s, i) => (
            <Reveal key={s.title} stagger={i}>
              <Card hoverable>
                <h3>{s.title}</h3>
                <p className="adw-muted">{s.blurb}</p>
              </Card>
            </Reveal>
          ))}
        </div>
      </section>

      <Reveal>
        <Card className="pv-claim">
          <h2>Make this yours</h2>
          <p className="adw-muted">You pay nothing until you approve it. Live in under 24 hours once you say go.</p>
          <form onSubmit={onClaim}>
            <div className="pv-consent">
              <input
                id="sms_consent"
                type="checkbox"
                name="sms_consent"
                checked={smsConsent}
                onChange={(e) => setSmsConsent(e.target.checked)}
              />
              <span>
                <label htmlFor="sms_consent">Text me updates about my website</label>
                <br />
                <label htmlFor="phone" className="adw-muted" style={{ fontSize: "0.85rem" }}>
                  Mobile number
                </label>
                <br />
                <input
                  id="phone"
                  className="adw-input"
                  type="tel"
                  name="phone"
                  placeholder="Your mobile number"
                  autoComplete="tel"
                  style={{ marginTop: 4, maxWidth: 260 }}
                  disabled={!smsConsent}
                />
              </span>
            </div>
            <Button type="submit" className="pv-cta">
              Approve &amp; go live
            </Button>
          </form>
          <a className="pv-notforme" href="#not-for-me" onClick={(e) => { e.preventDefault(); onNotForMe(); }}>
            This isn't for me
          </a>
        </Card>
      </Reveal>

      <Reveal>
        <Card style={{ marginTop: 16 }}>
          <h2 id="changes-heading">Request changes</h2>
          <form onSubmit={onRequestChanges}>
            <label htmlFor="changes-box" className="adw-muted" style={{ display: "block", marginBottom: 6 }}>
              Tell us what to change
            </label>
            <textarea
              id="changes-box"
              className="adw-textarea"
              rows={3}
              placeholder="Hours, photos, services — anything."
              value={changes}
              onChange={(e) => setChanges(e.target.value)}
            />
            <Button type="submit" variant="ghost" className="pv-cta">
              Send request
            </Button>
          </form>
        </Card>
      </Reveal>

      <div className="pv-trust">
        <span>✓ 30-day money-back guarantee</span>
        <span>✓ You own your domain</span>
        <span>✓ Cancel in two clicks</span>
      </div>
      </main>

      <footer className="pv-footer">
        {LEGAL_ENTITY} · {LEGAL_ADDRESS} · <a href="tel:+18005551234">+1 (800) 555-1234</a> ·{" "}
        <a href="/privacy">Privacy</a>
        <div style={{ marginTop: 6 }}>This is an unofficial preview and expires 30 days after creation.</div>
      </footer>

      {toast && <div className="pv-toast">{toast}</div>}
    </div>
  );
}

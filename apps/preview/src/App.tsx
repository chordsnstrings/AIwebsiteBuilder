import { useMemo, useRef, useState, type FormEvent } from "react";
import { Badge, Button, Card, Reveal } from "@adw/ui";
import { previewDemo } from "@adw/demo-data";
import { claimTokenFromUrl, previewApi } from "./api.ts";

// The single highest-leverage page in the system (spec §13). It carries the
// consent bridge (an unchecked "text me updates" checkbox) that makes later SMS
// lawful, the mandatory disclaimer banner, the real legal identity, the
// guarantee, a "request changes" box, and a friction-free "this isn't for me"
// suppression link. Loads in under 1s on 3G.
//
// Every API call below is fired from an event handler. Nothing blocks the first
// paint, and a dead API downgrades the confirmation wording rather than breaking
// the page.

const LEGAL_ENTITY = "ADW Foundry Ltd";
const LEGAL_ADDRESS = "123 Example Street, Suite 400, Toronto, ON M5V 0A1";

/** The page version and the exact consent wording both go into the consent
 * event — a bare "smsConsent: true" would prove nothing later. */
const LABEL_VERSION = "label-v1";
const CONSENT_WORDING = "Text me updates about my website";

const OFFLINE_NOTE = "Saved locally (demo) — we couldn't reach the server.";

export function App() {
  const b = previewDemo;
  const [toast, setToast] = useState<string | null>(null);
  const [changes, setChanges] = useState("");
  const [phone, setPhone] = useState("");
  const [smsConsent, setSmsConsent] = useState(false); // unchecked by default — required
  // Synchronous URL parse — no network, so the first paint is unaffected.
  const token = useMemo(() => claimTokenFromUrl(), []);

  // A later correction must replace the optimistic toast, not be cut short by
  // the timer the optimistic toast started.
  const toastTimer = useRef<number | null>(null);
  const flash = (msg: string) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  };

  const onClaim = (e: FormEvent) => {
    e.preventDefault();
    // Optimistic, then corrected: the toast never claims a success that did not
    // happen, but the customer is not left staring at a spinner either.
    flash(smsConsent ? "Claimed! We'll text you updates." : "Claimed! Check your email.");
    void previewApi
      .claim(token, {
        smsConsent,
        phone: smsConsent && phone.trim() ? phone.trim() : undefined,
        consentWording: CONSENT_WORDING,
        pageVersion: LABEL_VERSION,
      })
      .then((res) => {
        if (!res.ok) flash(OFFLINE_NOTE);
      });
  };
  const onRequestChanges = (e: FormEvent) => {
    e.preventDefault();
    const text = changes.trim();
    if (!text) return;
    flash("Sent — we'll get on it.");
    setChanges("");
    void previewApi.requestChanges(token, text).then((res) => {
      if (!res.ok) flash(OFFLINE_NOTE);
    });
  };
  const onNotForMe = () => {
    flash("No problem — you won't hear from us again.");
    void previewApi.notForMe(token).then((res) => {
      if (!res.ok) flash(OFFLINE_NOTE);
    });
  };

  return (
    <div className="pv-wrap">
      <div className="pv-banner" data-label-version={LABEL_VERSION}>
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
                <label htmlFor="sms_consent">{CONSENT_WORDING}</label>
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
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
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

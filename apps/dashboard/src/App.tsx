import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { HashRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { Badge, Button, Card, Counter, Reveal, Stat, Table, useTheme } from "@adw/ui";
import { demoCustomer } from "@adw/demo-data";
import { customerIdFromUrl, dashboardApi } from "./api.ts";

/* ------------------------------------------------------------------ *
 * Toast — a tiny slide-in notifier shared across every view.
 * ------------------------------------------------------------------ */
type ToastItem = { id: number; title: string; body?: string };
const ToastCtx = createContext<(title: string, body?: string) => void>(() => {});
const useToast = () => useContext(ToastCtx);

function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const notify = (title: string, body?: string) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, title, body }]);
    window.setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), 3400);
  };
  return (
    <ToastCtx.Provider value={notify}>
      {children}
      <div className="toast-host" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className="toast" role="status">
            <svg className="toast-ic" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div>
              <strong>{t.title}</strong>
              {t.body && <span>{t.body}</span>}
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ------------------------------------------------------------------ *
 * Shared bits
 * ------------------------------------------------------------------ */
function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="dash-head">
      <h1>{title}</h1>
      <p className="adw-muted">{sub}</p>
    </div>
  );
}

const money = (n: number) => `$${n.toLocaleString()}`;
const fmtDate = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

// Icons — inline SVG, no external requests.
function Icon({ path, size = 18 }: { path: string; size?: number }) {
  return (
    <svg className="nav-ic" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={path} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
import {
  BookingsView,
  DnsDiffPanel,
  EnquiriesView,
  GapsView,
  PhotosView,
  ReviewsView,
} from "./agent-views.tsx";

const ICONS = {
  home: "M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5",
  edit: "M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z M13.5 6.5l3 3",
  chart: "M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-8",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c-3 3-3 15 0 18m0-18c3 3 3 15 0 18M3.5 9h17M3.5 15h17",
  card: "M3 7.5h18v10.5H3zM3 10.5h18M6.5 15h4",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 20a7 7 0 0 1 14 0",
  inbox: "M3 13h5l2 3h4l2-3h5M4 13 6.5 5h11L20 13v6H4z",
  gap: "M12 3v10m0 4h.01M4.5 20h15a1.5 1.5 0 0 0 1.3-2.25l-7.5-13a1.5 1.5 0 0 0-2.6 0l-7.5 13A1.5 1.5 0 0 0 4.5 20Z",
  calendar: "M4 7h16v13H4zM4 11h16M8 3v4M16 3v4",
  camera: "M3 8h4l1.5-2h7L17 8h4v11H3zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
  star: "m12 4 2.5 5.2 5.5.8-4 3.9 1 5.6L12 16.9 7 19.5l1-5.6-4-3.9 5.5-.8z",
};

/* ------------------------------------------------------------------ *
 * 1 — HOME
 * ------------------------------------------------------------------ */
function Home() {
  const notify = useToast();
  const [sent, setSent] = useState(false);
  const c = demoCustomer;
  return (
    <>
      <Head title={`Welcome back, ${c.businessName}`} sub="Your site at a glance — what happened this month, and one thing worth doing next." />

      <div className="dash-grid-2" style={{ marginBottom: 16 }}>
        <Reveal>
          <div className="site-preview">
            <div className="site-chrome">
              <span className="dots"><i /><i /><i /></span>
              <span className="addr">{c.siteUrl.replace("https://", "")}</span>
            </div>
            <div className="site-body">
              <div className="fake-nav">
                <b>{c.businessName}</b>
                <span><i /><i /><i /></span>
              </div>
              <h3>Trusted local plumbing, done right the first time</h3>
              <p className="lede">Fast leak repair, water heaters and drain cleaning across the metro.</p>
              <span className="cta">Get a free quote</span>
              <span className="cards"><i /><i /><i /></span>
            </div>
          </div>
        </Reveal>

        <Reveal stagger={1}>
          <Card>
            <div className="adw-spread">
              <div>
                <div className="adw-muted" style={{ fontSize: "0.82rem" }}>Your website</div>
                <h2 style={{ margin: "2px 0 0" }}>{c.domain.name}</h2>
              </div>
              <Badge tone="ok">{c.status}</Badge>
            </div>
            <div className="adw-col" style={{ gap: 10, marginTop: 16 }}>
              <div className="adw-spread"><span className="adw-muted">Plan</span><strong>{c.plan}</strong></div>
              <div className="adw-spread"><span className="adw-muted">Monthly cost</span><strong>{money(c.mrr)}/mo</strong></div>
              <div className="adw-spread"><span className="adw-muted">Domain renews</span><strong>{fmtDate(c.domain.expiresAt)}</strong></div>
            </div>
            <div className="adw-row" style={{ marginTop: 18 }}>
              <a className="adw-btn" href={c.siteUrl} target="_blank" rel="noreferrer">Visit site ↗</a>
              <NavLink className="adw-btn adw-ghost" to="/edit">Request a change</NavLink>
            </div>
          </Card>
        </Reveal>
      </div>

      <h2 style={{ fontSize: "1.1rem", margin: "6px 0 12px" }}>This month</h2>
      <div className="dash-grid-stats" style={{ marginBottom: 18 }}>
        {[
          { label: "Visits", value: c.visitsThisMonth },
          { label: "Phone calls", value: c.callsThisMonth },
          { label: "Form enquiries", value: c.formsThisMonth },
        ].map((s, i) => (
          <Reveal key={s.label} stagger={i}>
            <Card hoverable>
              <Stat label={s.label}>
                <Counter to={s.value} />
              </Stat>
            </Card>
          </Reveal>
        ))}
      </div>

      <Reveal>
        <Card hoverable>
          <div className="suggest">
            <div className="spark" aria-hidden="true">💡</div>
            <div style={{ flex: 1 }}>
              <div className="adw-row" style={{ alignItems: "center", gap: 8, marginBottom: 4 }}>
                <strong>Suggested for you</strong>
                <Badge tone="warn">1 action</Badge>
              </div>
              <p style={{ margin: "0 0 14px" }}>{c.suggestion}</p>
              {sent ? (
                <Badge tone="ok">Sent — our team is on it</Badge>
              ) : (
                <Button
                  onClick={() => {
                    setSent(true);
                    notify("Reply sent", "We'll add those reviews and let you know when it's live.");
                  }}
                >
                  Reply YES
                </Button>
              )}
            </div>
          </div>
        </Card>
      </Reveal>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 2 — EDIT (plain-words change request, not a builder)
 * ------------------------------------------------------------------ */
type ChangeReq = { id: string; text: string; status: "done" | "in progress"; when: string };
const seedChanges: ChangeReq[] = [
  { id: "req_204", text: "Update opening hours to 8am–6pm on Saturdays", status: "done", when: "3 days ago" },
  { id: "req_198", text: "Add an emergency call-out banner to the homepage", status: "done", when: "1 week ago" },
  { id: "req_191", text: "Swap the hero photo for the new van picture", status: "in progress", when: "yesterday" },
];

function EditView() {
  const notify = useToast();
  const [text, setText] = useState("");
  const [reqs, setReqs] = useState<ChangeReq[]>(seedChanges);
  // Synchronous URL parse — no network on the render path.
  const customerId = useMemo(() => customerIdFromUrl(), []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    // optimistic: show it immediately as "in progress"
    setReqs((xs) => [{ id: `req_${Math.floor(Math.random() * 900 + 100)}`, text: trimmed, status: "in progress", when: "just now" }, ...xs]);
    setText("");
    notify("Change requested", "Our team has it. Most edits are live within minutes.");
    // …then tell the truth about what actually happened. A dead API leaves the
    // optimistic entry in place but never claims the change was filed.
    void dashboardApi.requestRevision(customerId, trimmed).then((res) => {
      if (!res.ok) {
        notify("Saved locally (demo)", "We couldn't reach the server — this change is only in your browser.");
      } else if (res.round !== undefined) {
        notify("Sent to the build pipeline", `Revision round ${res.round}.`);
      }
    });
  };

  return (
    <>
      <Head title="Request a change" sub="No page builder, no fiddly editor. Just tell us what to change." />
      <div className="dash-grid-2">
        <Reveal>
          <Card>
            <form onSubmit={submit}>
              <label htmlFor="change" style={{ display: "block", fontWeight: 700, marginBottom: 6 }}>
                Tell us what to change
              </label>
              <p className="adw-muted" style={{ marginTop: 0, marginBottom: 12, fontSize: "0.9rem" }}>
                Describe it in plain words — our team makes the change and it's live in minutes. Prices, a new photo, wording,
                a new service… anything on the site.
              </p>
              <textarea
                id="change"
                className="adw-textarea"
                rows={6}
                placeholder="e.g. Add a photo of the new team on the About page, and change the phone number to 555-0147."
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="adw-row" style={{ marginTop: 14, alignItems: "center" }}>
                <Button type="submit" disabled={!text.trim()}>Send request</Button>
                <span className="adw-muted" style={{ fontSize: "0.85rem" }}>Typical turnaround: a few minutes</span>
              </div>
            </form>
          </Card>
        </Reveal>

        <Reveal stagger={1}>
          <Card>
            <div className="adw-spread" style={{ marginBottom: 4 }}>
              <strong>Recently requested changes</strong>
              <span className="adw-muted adw-mono">{reqs.length}</span>
            </div>
            <div>
              {reqs.map((r) => (
                <div key={r.id} className="recent-item">
                  <div style={{ flex: 1 }}>
                    <div>{r.text}</div>
                    <div className="adw-muted" style={{ fontSize: "0.8rem", marginTop: 2 }}>{r.when}</div>
                  </div>
                  <Badge tone={r.status === "done" ? "ok" : "warn"}>{r.status}</Badge>
                </div>
              ))}
            </div>
          </Card>
        </Reveal>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 3 — PERFORMANCE (value report + simple CSS charts)
 * ------------------------------------------------------------------ */
const trend = [
  { m: "Feb", visits: 180, calls: 12, forms: 5 },
  { m: "Mar", visits: 214, calls: 15, forms: 6 },
  { m: "Apr", visits: 268, calls: 19, forms: 8 },
  { m: "May", visits: 295, calls: 22, forms: 9 },
  { m: "Jun", visits: 320, calls: 25, forms: 10 },
  { m: "Jul", visits: demoCustomer.visitsThisMonth, calls: demoCustomer.callsThisMonth, forms: demoCustomer.formsThisMonth },
];

function BarChart({ title, color, get }: { title: string; color: string; get: (r: (typeof trend)[number]) => number }) {
  const values = trend.map(get);
  const max = Math.max(...values, 1);
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <Card>
      <div className="adw-spread" style={{ marginBottom: 12 }}>
        <strong>{title}</strong>
        <span className="adw-muted adw-mono">{total.toLocaleString()} total</span>
      </div>
      <div className="chart">
        <div className="chart-bars" role="img" aria-label={`${title} over the last ${trend.length} months`}>
          {trend.map((r, i) => (
            <div className="chart-col" key={r.m}>
              <span className="val">{get(r)}</span>
              <div className="bar" style={{ height: `${(get(r) / max) * 100}%`, ["--bar" as string]: color, ["--i" as string]: i }} />
              <span className="cap">{r.m}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function Performance() {
  const aiTracked = 12;
  const aiAppears = 7;
  const pct = Math.round((aiAppears / aiTracked) * 100);
  return (
    <>
      <Head title="Performance" sub="What your website actually did for the business — visits, calls and enquiries over time." />

      <div className="dash-grid-stats" style={{ marginBottom: 18 }}>
        {[
          { label: "Visits this month", value: demoCustomer.visitsThisMonth, delta: "+6.8%" },
          { label: "Calls this month", value: demoCustomer.callsThisMonth, delta: "+12%" },
          { label: "Enquiries this month", value: demoCustomer.formsThisMonth, delta: "+10%" },
        ].map((s, i) => (
          <Reveal key={s.label} stagger={i}>
            <Card hoverable>
              <Stat label={s.label}><Counter to={s.value} /></Stat>
              <div className="adw-muted" style={{ fontSize: "0.8rem", marginTop: 4 }}>{s.delta} vs last month</div>
            </Card>
          </Reveal>
        ))}
      </div>

      <Reveal>
        <div className="legend" style={{ marginBottom: 12 }}>
          <span><i style={{ background: "var(--adw-primary)" }} /> Visits</span>
          <span><i style={{ background: "var(--adw-accent)" }} /> Calls</span>
          <span><i style={{ background: "var(--adw-warn)" }} /> Enquiries</span>
        </div>
      </Reveal>

      <div className="dash-grid-3" style={{ marginBottom: 18 }}>
        <Reveal><BarChart title="Visits" color="var(--adw-primary)" get={(r) => r.visits} /></Reveal>
        <Reveal stagger={1}><BarChart title="Phone calls" color="var(--adw-accent)" get={(r) => r.calls} /></Reveal>
        <Reveal stagger={2}><BarChart title="Form enquiries" color="var(--adw-warn)" get={(r) => r.forms} /></Reveal>
      </div>

      <Reveal>
        <Card hoverable>
          <div className="adw-spread" style={{ marginBottom: 10 }}>
            <strong>AI visibility</strong>
            <Badge tone="ok">{pct}%</Badge>
          </div>
          <p className="adw-muted" style={{ marginTop: 0 }}>
            Your site appears in AI assistant answers for <strong style={{ color: "var(--adw-text)" }}>{aiAppears} of {aiTracked}</strong> tracked
            local queries (e.g. “emergency plumber near me”). We keep your structured data fresh so assistants can recommend you.
          </p>
          <div className="meter" aria-label={`AI visibility: ${aiAppears} of ${aiTracked} tracked queries`}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </Card>
      </Reveal>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 4 — DOMAIN (self-serve transfer-out, no retention gauntlet)
 * ------------------------------------------------------------------ */
function Domain() {
  const notify = useToast();
  const d = demoCustomer.domain;
  const [showTransfer, setShowTransfer] = useState(false);
  const [codeShown, setCodeShown] = useState(false);
  const authCode = "ADW-7F3K-9QW2-XBLP";

  return (
    <>
      <Head title="Domain" sub="Your domain is yours. Everything here is self-serve — including moving it elsewhere." />

      {/* The diff is a product feature, not only a safety check. Owners know
          agencies break email during migrations; showing the proof is one of
          the genuinely good moments in onboarding. */}
      <Reveal>
        <div style={{ marginBottom: 16 }}>
          <DnsDiffPanel />
        </div>
      </Reveal>

      <div className="dash-grid-2" style={{ marginBottom: 16 }}>
        <Reveal>
          <Card>
            <div className="adw-spread" style={{ marginBottom: 14 }}>
              <strong className="adw-mono">{d.name}</strong>
              <Badge tone="ok">{d.status}</Badge>
            </div>
            <div className="adw-col" style={{ gap: 10 }}>
              <div className="adw-spread"><span className="adw-muted">Registration</span><strong>Active</strong></div>
              <div className="adw-spread"><span className="adw-muted">Renews / expires</span><strong>{fmtDate(d.expiresAt)}</strong></div>
              <div className="adw-spread"><span className="adw-muted">Auto-renew</span><strong>On</strong></div>
              <div className="adw-spread"><span className="adw-muted">Registrar lock</span><strong>Enabled</strong></div>
            </div>
          </Card>
        </Reveal>

        <Reveal stagger={1}>
          <Card>
            <strong>Take your domain elsewhere</strong>
            <p className="adw-muted" style={{ marginTop: 6 }}>
              You can transfer <span className="adw-mono">{d.name}</span> to any other registrar whenever you like. No phone call,
              no waiting on us — request the authorization code and you're set.
            </p>
            {!showTransfer ? (
              <Button variant="ghost" onClick={() => setShowTransfer(true)}>Transfer domain out</Button>
            ) : (
              <div>
                <ol className="steps" style={{ margin: "6px 0 16px" }}>
                  <li>We unlock the domain and disable transfer lock (done automatically when you request the code).</li>
                  <li>Copy the authorization / EPP code below.</li>
                  <li>Start the transfer at your new registrar and paste the code. It completes in a few days.</li>
                </ol>
                <div className="dash-row-between" style={{ borderTop: "1px solid var(--adw-border)", borderBottom: "1px solid var(--adw-border)" }}>
                  <span className="adw-muted">Authorization code</span>
                  {codeShown ? (
                    <strong className="adw-mono">{authCode}</strong>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => {
                        setCodeShown(true);
                        notify("Domain unlocked", "Transfer lock disabled and your auth code is ready.");
                      }}
                    >
                      Request auth code
                    </Button>
                  )}
                </div>
                <p className="adw-muted" style={{ fontSize: "0.82rem", marginTop: 12, marginBottom: 0 }}>
                  That's the whole process. We won't try to talk you out of it.
                </p>
              </div>
            )}
          </Card>
        </Reveal>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 5 — PAYMENTS (not attached — empty state, with a sample preview)
 * ------------------------------------------------------------------ */
function Payments() {
  const notify = useToast();
  const [preview, setPreview] = useState(false);
  return (
    <>
      <Head title="Payments" sub="Take card payments and deposits straight from your site." />
      {!preview ? (
        <Reveal>
          <Card>
            <div className="empty-state">
              <div className="ic" aria-hidden="true">💳</div>
              <h2 style={{ margin: "0 0 6px" }}>Payments aren't set up yet</h2>
              <p className="adw-muted" style={{ maxWidth: 460, margin: "0 auto 16px" }}>
                Connect payments to let customers pay invoices and leave deposits online. You'll see volume, payouts, disputes
                and any verification requirements here once it's attached.
              </p>
              <div className="adw-row" style={{ justifyContent: "center" }}>
                <Button onClick={() => notify("We'll be in touch", "Our team will help you connect payments securely.")}>
                  Learn more &amp; connect
                </Button>
                <Button variant="ghost" onClick={() => setPreview(true)}>See a sample</Button>
              </div>
            </div>
          </Card>
        </Reveal>
      ) : (
        <>
          <div className="adw-spread" style={{ marginBottom: 12 }}>
            <Badge tone="neutral">Sample data — not your real account</Badge>
            <Button size="sm" variant="ghost" onClick={() => setPreview(false)}>Hide sample</Button>
          </div>
          <div className="dash-grid-stats" style={{ marginBottom: 16 }}>
            {[
              { label: "Volume (30d)", value: 4820, prefix: "$" },
              { label: "Next payout", value: 1240, prefix: "$" },
              { label: "Open disputes", value: 0 },
            ].map((s, i) => (
              <Reveal key={s.label} stagger={i}>
                <Card hoverable>
                  <Stat label={s.label}><Counter to={s.value} prefix={s.prefix ?? ""} /></Stat>
                </Card>
              </Reveal>
            ))}
          </div>
          <Reveal>
            <Card>
              <div className="adw-spread">
                <strong>Account requirements</strong>
                <Badge tone="ok">Complete</Badge>
              </div>
              <p className="adw-muted" style={{ marginBottom: 0 }}>
                Identity verified, bank account confirmed, payouts enabled. Nothing needs your attention.
              </p>
            </Card>
          </Reveal>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 6 — BILLING (two-click cancel, NO retention gauntlet)
 * ------------------------------------------------------------------ */
type CancelStage = "active" | "confirming" | "cancelled";

function Billing() {
  const notify = useToast();
  const [stage, setStage] = useState<CancelStage>("active");
  const c = demoCustomer;
  const addons = [
    { name: "Managed hosting & SSL", price: "Included" },
    { name: "Unlimited plain-words edits", price: "Included" },
    { name: "Monthly performance report", price: "Included" },
  ];

  return (
    <>
      <Head title="Billing" sub="Your plan, what's included, and every invoice — with a cancel that takes two clicks." />

      <div className="dash-grid-2" style={{ marginBottom: 16 }}>
        <Reveal>
          <Card>
            <div className="adw-spread" style={{ marginBottom: 12 }}>
              <div>
                <div className="adw-muted" style={{ fontSize: "0.82rem" }}>Current plan</div>
                <h2 style={{ margin: "2px 0 0" }}>{c.plan}</h2>
              </div>
              <strong style={{ fontSize: "1.3rem" }}>{money(c.mrr)}<span className="adw-muted" style={{ fontSize: "0.9rem" }}>/mo</span></strong>
            </div>
            <div className="adw-col" style={{ gap: 8 }}>
              {addons.map((a) => (
                <div key={a.name} className="adw-spread">
                  <span>{a.name}</span>
                  <span className="adw-muted">{a.price}</span>
                </div>
              ))}
            </div>
          </Card>
        </Reveal>

        <Reveal stagger={1}>
          <Card>
            <strong>Plan status</strong>
            {stage === "active" && (
              <>
                <p className="adw-muted" style={{ marginTop: 6 }}>
                  Your {c.plan} renews on <strong style={{ color: "var(--adw-text)" }}>Aug 1, 2026</strong>. Cancel anytime.
                </p>
                <Button variant="ghost" onClick={() => setStage("confirming")}>Cancel plan</Button>
              </>
            )}
            {stage === "confirming" && (
              <>
                <p style={{ marginTop: 6 }}>
                  This cancels your {c.plan} at the end of the current period ({fmtDate("2026-08-01")}). Your site stays live until then.
                </p>
                <div className="adw-row" style={{ alignItems: "center" }}>
                  <Button
                    variant="danger"
                    onClick={() => {
                      setStage("cancelled");
                      notify("Plan cancelled", "You'll keep access until Aug 1, 2026. No further charges.");
                    }}
                  >
                    Confirm cancellation
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setStage("active")}>Keep plan</Button>
                </div>
              </>
            )}
            {stage === "cancelled" && (
              <>
                <div style={{ marginTop: 8, marginBottom: 8 }}><Badge tone="bad">Cancelled</Badge></div>
                <p className="adw-muted" style={{ marginTop: 0 }}>
                  Your plan is cancelled. Access continues until <strong style={{ color: "var(--adw-text)" }}>{fmtDate("2026-08-01")}</strong>.
                  Changed your mind? You can resubscribe anytime.
                </p>
                <Button variant="ghost" size="sm" onClick={() => setStage("active")}>Reactivate</Button>
              </>
            )}
          </Card>
        </Reveal>
      </div>

      <Reveal>
        <Card>
          <strong style={{ display: "block", marginBottom: 12 }}>Invoices</strong>
          <Table
            columns={[
              { key: "id", header: "Invoice", render: (r) => <span className="adw-mono">{r.id}</span> },
              { key: "date", header: "Date", render: (r) => fmtDate(r.date) },
              { key: "amount", header: "Amount", render: (r) => money(r.amount) },
              { key: "status", header: "Status", render: (r) => <Badge tone={r.status === "paid" ? "ok" : "warn"}>{r.status}</Badge> },
              { key: "dl", header: "", render: () => <Button size="sm" variant="ghost">Download</Button> },
            ]}
            rows={c.invoices}
          />
        </Card>
      </Reveal>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 7 — ACCOUNT (contact details, notification toggles, data export)
 * ------------------------------------------------------------------ */
function Account() {
  const notify = useToast();
  const [contact, setContact] = useState({
    name: "Sam Rivera",
    business: demoCustomer.businessName,
    email: "owner@brightplumbing.com",
    phone: "555-0147",
  });
  const [prefs, setPrefs] = useState({ productUpdates: true, monthlyReport: true, smsAlerts: false });

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    notify("Details saved", "Your contact information is up to date.");
  };

  const exportData = () => {
    const payload = { contact, preferences: prefs, account: demoCustomer, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "my-adw-data.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    notify("Export ready", "my-adw-data.json has been downloaded.");
  };

  const toggles: { key: keyof typeof prefs; label: string; hint: string }[] = [
    { key: "productUpdates", label: "Product updates", hint: "Occasional emails about new features." },
    { key: "monthlyReport", label: "Monthly performance report", hint: "Your visits, calls and enquiries, once a month." },
    { key: "smsAlerts", label: "SMS alerts", hint: "Text me if the site ever goes down." },
  ];

  return (
    <>
      <Head title="Account" sub="Your contact details, what we email you about, and a copy of your data whenever you want it." />

      <div className="dash-grid-2" style={{ marginBottom: 16 }}>
        <Reveal>
          <Card>
            <strong style={{ display: "block", marginBottom: 14 }}>Contact details</strong>
            <form onSubmit={save}>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="ac-name">Your name</label>
                  <input id="ac-name" className="adw-input" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="ac-biz">Business name</label>
                  <input id="ac-biz" className="adw-input" value={contact.business} onChange={(e) => setContact({ ...contact, business: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="ac-email">Email</label>
                  <input id="ac-email" type="email" className="adw-input" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="ac-phone">Phone</label>
                  <input id="ac-phone" type="tel" className="adw-input" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
                </div>
              </div>
              <div style={{ marginTop: 16 }}><Button type="submit">Save changes</Button></div>
            </form>
          </Card>
        </Reveal>

        <Reveal stagger={1}>
          <Card>
            <strong style={{ display: "block", marginBottom: 6 }}>Notifications</strong>
            {toggles.map((t) => (
              <div key={t.key} className="dash-row-between">
                <div style={{ paddingRight: 12 }}>
                  <div style={{ fontWeight: 600 }}>{t.label}</div>
                  <div className="adw-muted" style={{ fontSize: "0.82rem" }}>{t.hint}</div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={prefs[t.key]}
                    onChange={() => setPrefs((p) => ({ ...p, [t.key]: !p[t.key] }))}
                    aria-label={t.label}
                  />
                  <span className="track" />
                </label>
              </div>
            ))}
          </Card>
        </Reveal>
      </div>

      <Reveal>
        <Card>
          <div className="adw-spread">
            <div style={{ paddingRight: 16 }}>
              <strong>Download my data</strong>
              <p className="adw-muted" style={{ margin: "4px 0 0" }}>
                Get a full copy of your account, site stats and settings as a JSON file. Yours to keep, anytime.
              </p>
            </div>
            <Button onClick={exportData}>Export my data</Button>
          </div>
        </Card>
      </Reveal>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */
const NAV = [
  { to: "/", label: "Home", icon: ICONS.home, el: <Home /> },
  // The agent's own surfaces come first after Home. This is what the customer
  // is actually paying for; the site is the interface, not the product.
  { to: "/enquiries", label: "Enquiries", icon: ICONS.inbox, el: <EnquiriesView /> },
  { to: "/gaps", label: "Gaps", icon: ICONS.gap, el: <GapsView /> },
  { to: "/bookings", label: "Bookings", icon: ICONS.calendar, el: <BookingsView /> },
  { to: "/photos", label: "Photos", icon: ICONS.camera, el: <PhotosView /> },
  { to: "/reviews", label: "Reviews", icon: ICONS.star, el: <ReviewsView /> },
  { to: "/edit", label: "Edit", icon: ICONS.edit, el: <EditView /> },
  { to: "/performance", label: "Performance", icon: ICONS.chart, el: <Performance /> },
  { to: "/domain", label: "Domain", icon: ICONS.globe, el: <Domain /> },
  { to: "/payments", label: "Payments", icon: ICONS.card, el: <Payments /> },
  { to: "/billing", label: "Billing", icon: ICONS.receipt, el: <Billing /> },
  { to: "/account", label: "Account", icon: ICONS.user, el: <Account /> },
];

function RoutedMain() {
  const location = useLocation();
  return (
    <main className="dash-main">
      {/* keyed on path so each view remounts and its Reveals re-fire — smooth view transitions */}
      <div key={location.pathname}>
        <Routes location={location}>
          {NAV.map((n) => (
            <Route key={n.to} path={n.to} element={n.el} />
          ))}
        </Routes>
      </div>
    </main>
  );
}

export function App() {
  const [theme, toggle] = useTheme();
  const year = useMemo(() => new Date().getFullYear(), []);
  return (
    <ToastProvider>
      <HashRouter>
        <div className="dash-shell">
          <aside className="dash-side">
            <div className="dash-brand">
              <span className="logo" aria-hidden="true" />
              <span>
                {demoCustomer.businessName}
                <small>ADW dashboard</small>
              </span>
            </div>
            <div className="dash-sub adw-muted" style={{ fontSize: "0.8rem" }}>Self-serve — everything's one click.</div>
            <nav className="dash-nav adw-col" style={{ gap: 2, flex: 1 }} aria-label="Dashboard sections">
              {NAV.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === "/"}>
                  <Icon path={n.icon} />
                  {n.label}
                </NavLink>
              ))}
            </nav>
            <Button variant="ghost" size="sm" onClick={toggle} aria-label="Toggle colour theme">
              {theme === "dark" ? "☀ Light" : "☾ Dark"}
            </Button>
            <div className="adw-muted" style={{ fontSize: "0.72rem", padding: "8px 10px 0" }}>© {year} ADW</div>
          </aside>
          <RoutedMain />
        </div>
      </HashRouter>
    </ToastProvider>
  );
}

// The v3 dashboard panels (spec §40, §83.4).
//
// v1's dashboard answered "is my website up". This one answers "what came in,
// and what did I do about it" — which is what makes the subscription a system
// rather than hosting.
//
// The panel that matters most is Gaps. It is a live list of questions the
// business's own published content cannot answer, harvested from real visitors,
// and it is simultaneously the product's self-improvement loop and its clearest
// upsell. Every other panel here is a queue with a promise attached: photo
// triage promises an owner reply inside 30 minutes, reviews promise a draft
// waiting rather than a task, and the DNS diff promises their email never moved.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Card, Reveal } from "@adw/ui";
import { customerIdFromUrl, dashboardApi, DEMO_CUSTOMER_ID } from "./api.ts";

// ---------------------------------------------------------------------------
// Seed data. The dashboard renders instantly against these and upgrades if the
// API answers — the same pattern the ops console uses, and the reason first
// paint takes no network.
// ---------------------------------------------------------------------------

export interface Enquiry {
  id: string;
  name: string;
  need: string;
  contact: string;
  urgency: "emergency" | "urgent" | "normal";
  channel: string;
  at: string;
  transcript: { who: "visitor" | "agent"; text: string }[];
}

export interface Gap {
  id: string;
  question: string;
  timesAsked: number;
  lastAskedAt: string;
  draft?: string;
  status: "open" | "drafted" | "approved";
}

export interface Booking {
  id: string;
  when: string;
  contact: string;
  service: string;
  status: "held" | "confirmed" | "cancelled";
}

export interface PhotoItem {
  id: string;
  at: string;
  whatItIs: string;
  apparentScope: string;
  notDeterminable: string[];
  urgent: boolean;
  suggestedReply: string;
}

export interface ReviewItem {
  id: string;
  author: string;
  rating: number;
  text: string;
  draft: string;
  approved: boolean;
}

const seedEnquiries: Enquiry[] = [
  {
    id: "e1",
    name: "Dana Whitfield",
    need: "Water coming through the ceiling after last night's storm",
    contact: "dana@example.com · 0208 555 0147",
    urgency: "emergency",
    channel: "Web chat",
    at: "Today, 07:42",
    transcript: [
      { who: "visitor", text: "There's water coming through my bedroom ceiling after the storm" },
      { who: "agent", text: "That sounds urgent — I've flagged it and the team will call you shortly. Can I take a number?" },
      { who: "visitor", text: "0208 555 0147" },
    ],
  },
  {
    id: "e2",
    name: "Marcus Oyelaran",
    need: "Quote for replacing a flat roof, roughly 40 square metres",
    contact: "m.oyelaran@example.com",
    urgency: "normal",
    channel: "Web chat",
    at: "Yesterday, 16:10",
    transcript: [
      { who: "visitor", text: "How much for a flat roof, about 40 sqm?" },
      { who: "agent", text: "We don't publish prices for replacements — every roof is different. I can take your details and have someone come and measure." },
    ],
  },
];

const seedGaps: Gap[] = [
  { id: "g1", question: "Do you offer a warranty on new roofs?", timesAsked: 7, lastAskedAt: "Today", status: "open" },
  { id: "g2", question: "Are you insured for commercial work?", timesAsked: 5, lastAskedAt: "Today", status: "open" },
  { id: "g3", question: "Do you work weekends?", timesAsked: 3, lastAskedAt: "Yesterday", status: "open" },
  {
    id: "g4",
    question: "How long does a full replacement take?",
    timesAsked: 2,
    lastAskedAt: "2 days ago",
    status: "drafted",
    draft: "Most full replacements take two to three days, weather permitting.",
  },
];

const seedBookings: Booking[] = [
  { id: "b1", when: "Thu 14 Aug, 09:00", contact: "Dana Whitfield", service: "Emergency callout", status: "confirmed" },
  { id: "b2", when: "Fri 15 Aug, 13:30", contact: "Marcus Oyelaran", service: "Measure and quote", status: "held" },
];

const seedPhotos: PhotoItem[] = [
  {
    id: "p1",
    at: "Today, 07:44",
    whatItIs: "Water staining across a bedroom ceiling near the chimney stack",
    apparentScope: "Localised to roughly one square metre, from what is visible in the frame",
    notDeterminable: ["the extent behind the plaster", "whether the flashing or the tiles are the cause", "access and working height"],
    urgent: false,
    suggestedReply:
      "Thanks for the photo — I can see the staining around the chimney. I can't tell from the image whether it's the flashing or the tiles, so we'd need to take a look.",
  },
];

const seedReviews: ReviewItem[] = [
  {
    id: "r1",
    author: "H. Okonjo",
    rating: 5,
    text: "Came out the same day and fixed a leak two other firms couldn't find.",
    draft: "Thanks for taking the time to leave this — glad we could get it sorted quickly.",
    approved: false,
  },
  {
    id: "r2",
    author: "P. Nakamura",
    rating: 3,
    text: "Work was fine but they were two hours later than the window I was given.",
    draft: "Sorry about the timing — that's not the standard we aim for. We'd like to make it right; please get in touch directly.",
    approved: false,
  },
];

// ---------------------------------------------------------------------------

function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <header style={{ marginBottom: 18 }}>
      <h1 style={{ fontSize: "1.5rem", margin: 0 }}>{title}</h1>
      <p className="adw-muted" style={{ margin: "6px 0 0", maxWidth: "56ch" }}>
        {sub}
      </p>
    </header>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <Card>
      <p className="adw-muted" style={{ margin: 0 }}>
        {children}
      </p>
    </Card>
  );
}

const urgencyTone = (u: Enquiry["urgency"]): "bad" | "warn" | "ok" =>
  u === "emergency" ? "bad" : u === "urgent" ? "warn" : "ok";

// ---------------------------------------------------------------------------
// Enquiries — ranked by urgency, never by recency
// ---------------------------------------------------------------------------

export function EnquiriesView({ items = seedEnquiries }: { items?: Enquiry[] }) {
  const [open, setOpen] = useState<string | null>(items[0]?.id ?? null);

  // Urgency first. A flooding kitchen from this morning outranks a quote
  // request from ten minutes ago, and sorting by time would bury it.
  const ranked = useMemo(() => {
    const weight = { emergency: 0, urgent: 1, normal: 2 } as const;
    return [...items].sort((a, b) => weight[a.urgency] - weight[b.urgency]);
  }, [items]);

  return (
    <>
      <Head
        title="Enquiries"
        sub="Everything the agent captured, most urgent first. The full conversation is here — you can see exactly what was said before you call back."
      />
      {ranked.length === 0 ? (
        <Empty>Nothing yet. Enquiries land here the moment your agent captures one.</Empty>
      ) : (
        <div className="adw-col" style={{ gap: 12 }}>
          {ranked.map((e, i) => (
            <Reveal key={e.id} stagger={i}>
              <Card>
                <div className="adw-spread">
                  <div>
                    <div className="adw-row" style={{ gap: 8, alignItems: "center" }}>
                      <strong>{e.name}</strong>
                      <Badge tone={urgencyTone(e.urgency)}>{e.urgency}</Badge>
                    </div>
                    <p style={{ margin: "6px 0 0", maxWidth: "60ch" }}>{e.need}</p>
                    <div className="adw-muted" style={{ fontSize: "0.85rem", marginTop: 6 }}>
                      {e.contact} · {e.channel} · {e.at}
                    </div>
                  </div>
                  <button
                    className="adw-btn adw-ghost"
                    onClick={() => setOpen(open === e.id ? null : e.id)}
                    aria-expanded={open === e.id}
                  >
                    {open === e.id ? "Hide" : "Transcript"}
                  </button>
                </div>
                {open === e.id && (
                  <div className="adw-col" style={{ gap: 8, marginTop: 14 }}>
                    {e.transcript.map((t, n) => (
                      <div
                        key={n}
                        style={{
                          alignSelf: t.who === "visitor" ? "flex-start" : "flex-end",
                          maxWidth: "80%",
                          padding: "8px 12px",
                          borderRadius: 12,
                          background: t.who === "visitor" ? "var(--adw-surface-2, #f2f5f9)" : "var(--adw-accent-soft, #e8f0ff)",
                        }}
                      >
                        {t.text}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </Reveal>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Gaps — the panel that pays for the subscription
// ---------------------------------------------------------------------------

export function GapsView({ items = seedGaps }: { items?: Gap[] }) {
  const [gaps, setGaps] = useState(items);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  // First paint is the fixtures, always; the live list replaces them once it
  // arrives. Nothing here blocks rendering, which is the whole reason the panel
  // opens instantly on a phone in a van.
  useEffect(() => {
    const customerId = customerIdFromUrl();
    if (customerId === DEMO_CUSTOMER_ID) return;
    let live = true;
    void dashboardApi.listGaps(customerId).then((data) => {
      if (!live || data === null) return;
      setGaps(
        data.gaps.map((g) => ({
          id: g.id,
          question: g.question,
          timesAsked: g.timesAsked,
          lastAskedAt: new Date(g.lastAskedAt).toLocaleDateString(),
          status: g.status === "approved" ? ("approved" as const) : ("open" as const),
          ...(g.draftedAnswer === null ? {} : { draft: g.draftedAnswer }),
        })),
      );
    });
    return () => {
      live = false;
    };
  }, []);

  const approve = async (id: string) => {
    // ⛔ The owner approves. An answer that promotes itself into the pack is a
    // system learning its own hallucinations, which is the one thing the whole
    // grounding design exists to prevent.
    const answer = text || gaps.find((g) => g.id === id)?.draft || "";
    setSaving(true);
    setRefused(null);
    const result = await dashboardApi.approveGap(id, answer);
    setSaving(false);

    // ⛔ A refusal must NOT look like a save. The refusal policy applies to the
    // owner's words too, and an owner who believes their agent now says
    // something it will never say is worse off than one who was told no.
    if (result.live && !result.ok) {
      setRefused(result.reason ?? "That answer could not be published.");
      return;
    }
    setGaps((g) => g.map((x) => (x.id === id ? { ...x, status: "approved" as const, draft: answer } : x)));
    setEditing(null);
    setText("");
  };

  const open = gaps.filter((g) => g.status !== "approved");
  const done = gaps.filter((g) => g.status === "approved");

  return (
    <>
      <Head
        title="What your agent couldn't answer"
        sub="Real questions from real visitors that your published information doesn't cover. Answer one and your agent knows it from then on — it never guesses on its own."
      />

      {open.length === 0 ? (
        <Empty>No open gaps. Your agent answered everything it was asked.</Empty>
      ) : (
        <div className="adw-col" style={{ gap: 12 }}>
          {open.map((g, i) => (
            <Reveal key={g.id} stagger={i}>
              <Card>
                <div className="adw-spread">
                  <div>
                    <strong style={{ fontSize: "1.02rem" }}>{g.question}</strong>
                    <div className="adw-muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                      Asked {g.timesAsked} {g.timesAsked === 1 ? "time" : "times"} · last {g.lastAskedAt.toLowerCase()}
                    </div>
                  </div>
                  {g.timesAsked >= 5 && <Badge tone="warn">Asked often</Badge>}
                </div>

                {editing === g.id ? (
                  <div className="adw-col" style={{ gap: 10, marginTop: 12 }}>
                    <label className="adw-muted" htmlFor={`ans-${g.id}`} style={{ fontSize: "0.85rem" }}>
                      Your answer — this becomes what the agent says, word for word
                    </label>
                    <textarea
                      id={`ans-${g.id}`}
                      rows={3}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      style={{ width: "100%", padding: 10, borderRadius: 8, font: "inherit" }}
                    />
                    <div className="adw-row" style={{ gap: 8 }}>
                      <button
                        className="adw-btn"
                        onClick={() => void approve(g.id)}
                        disabled={saving || text.trim().length === 0}
                      >
                        {saving ? "Publishing…" : "Approve and publish"}
                      </button>
                      <button className="adw-btn adw-ghost" onClick={() => setEditing(null)} disabled={saving}>
                        Cancel
                      </button>
                    </div>
                    {refused !== null && (
                      <p role="alert" style={{ margin: 0, color: "var(--adw-danger, #b42318)", fontSize: "0.9rem" }}>
                        {refused}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="adw-row" style={{ gap: 8, marginTop: 12 }}>
                    <button
                      className="adw-btn"
                      onClick={() => {
                        setEditing(g.id);
                        setText(g.draft ?? "");
                      }}
                    >
                      {g.draft ? "Review the draft" : "Draft an answer"}
                    </button>
                  </div>
                )}
              </Card>
            </Reveal>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <>
          <h2 style={{ fontSize: "1.05rem", margin: "22px 0 10px" }}>Answered</h2>
          <div className="adw-col" style={{ gap: 10 }}>
            {done.map((g) => (
              <Card key={g.id}>
                <div className="adw-spread">
                  <div>
                    <strong>{g.question}</strong>
                    <p className="adw-muted" style={{ margin: "4px 0 0" }}>{g.draft}</p>
                  </div>
                  <Badge tone="ok">Live</Badge>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export function BookingsView({ items = seedBookings }: { items?: Booking[] }) {
  return (
    <>
      <Head title="Bookings" sub="Everything the agent put in your calendar. Two-way synced — move it in your calendar and it moves here." />
      {items.length === 0 ? (
        <Empty>No bookings yet.</Empty>
      ) : (
        <div className="adw-col" style={{ gap: 10 }}>
          {items.map((b, i) => (
            <Reveal key={b.id} stagger={i}>
              <Card>
                <div className="adw-spread">
                  <div>
                    <strong>{b.when}</strong>
                    <div className="adw-muted" style={{ fontSize: "0.9rem", marginTop: 4 }}>
                      {b.contact} · {b.service}
                    </div>
                  </div>
                  <Badge tone={b.status === "confirmed" ? "ok" : b.status === "held" ? "warn" : "bad"}>{b.status}</Badge>
                </div>
              </Card>
            </Reveal>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Photo triage — the price field is deliberately empty
// ---------------------------------------------------------------------------

export function PhotosView({ items = seedPhotos }: { items?: PhotoItem[] }) {
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Record<string, boolean>>({});

  return (
    <>
      <Head
        title="Photos to price"
        sub="Your agent describes what it can see and what it can't. It never quotes — you put the number in. Customers expect a reply within about half an hour."
      />
      {items.length === 0 ? (
        <Empty>Nothing waiting. Photos customers send land here with an assessment attached.</Empty>
      ) : (
        <div className="adw-col" style={{ gap: 12 }}>
          {items.map((p, i) => (
            <Reveal key={p.id} stagger={i}>
              <Card>
                <div className="adw-spread">
                  <div>
                    <strong>{p.whatItIs}</strong>
                    <div className="adw-muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>{p.at}</div>
                  </div>
                  {p.urgent && <Badge tone="bad">Safety hazard</Badge>}
                </div>

                <p style={{ margin: "12px 0 0" }}>{p.apparentScope}</p>

                {/* Stating what the photo does NOT show is the difference
                    between an assessment and a guess. */}
                <div style={{ marginTop: 10 }}>
                  <div className="adw-muted" style={{ fontSize: "0.85rem" }}>What the photo doesn't show</div>
                  <ul style={{ margin: "6px 0 0 18px" }}>
                    {p.notDeterminable.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </div>

                <div className="adw-col" style={{ gap: 10, marginTop: 14 }}>
                  <label className="adw-muted" htmlFor={`price-${p.id}`} style={{ fontSize: "0.85rem" }}>
                    Your price — the agent left this blank on purpose
                  </label>
                  <input
                    id={`price-${p.id}`}
                    inputMode="decimal"
                    placeholder="e.g. 450"
                    value={prices[p.id] ?? ""}
                    onChange={(e) => setPrices((s) => ({ ...s, [p.id]: e.target.value }))}
                    style={{ maxWidth: 180, padding: 10, borderRadius: 8, font: "inherit" }}
                  />
                  <p className="adw-muted" style={{ margin: 0, fontSize: "0.9rem" }}>
                    Suggested reply: “{p.suggestedReply}”
                  </p>
                  <div className="adw-row" style={{ gap: 8 }}>
                    <button
                      className="adw-btn"
                      disabled={!prices[p.id] || sent[p.id]}
                      onClick={() => setSent((s) => ({ ...s, [p.id]: true }))}
                    >
                      {sent[p.id] ? "Sent" : "Send with this price"}
                    </button>
                  </div>
                </div>
              </Card>
            </Reveal>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reviews — drafts awaiting approval, never auto-posted
// ---------------------------------------------------------------------------

export function ReviewsView({ items = seedReviews }: { items?: ReviewItem[] }) {
  const [reviews, setReviews] = useState(items);

  return (
    <>
      <Head title="Reviews" sub="New reviews with a reply already drafted. Nothing is posted until you approve it." />
      {reviews.length === 0 ? (
        <Empty>No new reviews.</Empty>
      ) : (
        <div className="adw-col" style={{ gap: 12 }}>
          {reviews.map((r, i) => (
            <Reveal key={r.id} stagger={i}>
              <Card>
                <div className="adw-spread">
                  <div>
                    <strong>{r.author}</strong>
                    <span className="adw-muted" style={{ marginLeft: 8 }}>
                      {"★".repeat(r.rating)}
                      {"☆".repeat(5 - r.rating)}
                    </span>
                    <p style={{ margin: "6px 0 0", maxWidth: "60ch" }}>{r.text}</p>
                  </div>
                  {r.approved && <Badge tone="ok">Posted</Badge>}
                </div>
                <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: "var(--adw-surface-2, #f2f5f9)" }}>
                  <div className="adw-muted" style={{ fontSize: "0.82rem", marginBottom: 4 }}>Drafted reply</div>
                  {r.draft}
                </div>
                {!r.approved && (
                  <div className="adw-row" style={{ gap: 8, marginTop: 12 }}>
                    <button
                      className="adw-btn"
                      onClick={() => setReviews((s) => s.map((x) => (x.id === r.id ? { ...x, approved: true } : x)))}
                    >
                      Approve and post
                    </button>
                    <button className="adw-btn adw-ghost">Edit</button>
                  </div>
                )}
              </Card>
            </Reveal>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// DNS diff — a product feature, not only a safety check
// ---------------------------------------------------------------------------

export interface DnsRecordRow {
  type: string;
  name: string;
  before: string;
  after: string;
}

const seedDiff: DnsRecordRow[] = [
  { type: "A", name: "@", before: "203.0.113.10", after: "198.51.100.4" },
  { type: "CNAME", name: "www", before: "oldhost.example.net", after: "ridgeline.adwsites.com" },
  { type: "MX", name: "@", before: "10 mail.protection.outlook.com", after: "10 mail.protection.outlook.com" },
  { type: "TXT", name: "@", before: "v=spf1 include:spf.protection.outlook.com -all", after: "v=spf1 include:spf.protection.outlook.com -all" },
  { type: "TXT", name: "_dmarc", before: "v=DMARC1; p=quarantine", after: "v=DMARC1; p=quarantine" },
];

export function DnsDiffPanel({ rows = seedDiff }: { rows?: DnsRecordRow[] }) {
  const changed = rows.filter((r) => r.before !== r.after);
  const mailTouched = changed.some((r) => r.type === "MX" || /spf|dkim|dmarc/i.test(r.before + r.after));

  return (
    <Card>
      <div className="adw-spread">
        <div>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>What we changed in your DNS</h2>
          <p className="adw-muted" style={{ margin: "6px 0 0", maxWidth: "56ch" }}>
            Every web agency has broken someone's email during a migration. We changed two records and nothing else — here is the before and after.
          </p>
        </div>
        <Badge tone={mailTouched ? "bad" : "ok"}>{mailTouched ? "Mail records changed" : "Email untouched"}</Badge>
      </div>

      <div style={{ overflowX: "auto", marginTop: 14 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.92rem" }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th style={{ padding: "8px 10px" }}>Type</th>
              <th style={{ padding: "8px 10px" }}>Name</th>
              <th style={{ padding: "8px 10px" }}>Before</th>
              <th style={{ padding: "8px 10px" }}>After</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isChanged = r.before !== r.after;
              return (
                <tr key={i} style={{ borderTop: "1px solid var(--adw-border, #e3e8ef)" }}>
                  <td style={{ padding: "8px 10px" }}>
                    <code>{r.type}</code>
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    <code>{r.name}</code>
                  </td>
                  <td style={{ padding: "8px 10px", opacity: isChanged ? 0.65 : 1 }}>{r.before}</td>
                  <td style={{ padding: "8px 10px", fontWeight: isChanged ? 600 : 400 }}>
                    {isChanged ? r.after : <span className="adw-muted">unchanged</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="adw-muted" style={{ margin: "12px 0 0", fontSize: "0.9rem" }}>
        {changed.length} record{changed.length === 1 ? "" : "s"} changed. Your MX, SPF and DMARC records are exactly as they were, so your email carries on working.
      </p>
    </Card>
  );
}

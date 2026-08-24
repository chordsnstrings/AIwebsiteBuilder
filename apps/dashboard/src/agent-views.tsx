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
import {
  customerIdFromUrl,
  dashboardApi,
  DEMO_CUSTOMER_ID,
  isDemo,
  type ApiEnquiry,
} from "./api.ts";
import { DemoBanner, Live, Unreachable, useLive } from "./live.tsx";

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

/**
 * ⛔ THE PANEL THAT WAS LYING.
 *
 * `commitEnquiry` has written these rows correctly since the concierge shipped
 * and nothing in the repository ever read the table — no route, no job, no
 * SELECT anywhere. This view rendered `seedEnquiries`, a fixture, to every
 * owner who opened it. Meanwhile the agent told the visitor, in words, that it
 * had passed their details on.
 *
 * It now reads `/agent/:customerId/enquiries`, and it can move one along:
 * "called back" and "done" are the two things an owner actually does with a
 * lead, and a queue nothing can be cleared from is a list.
 */
export function EnquiriesView() {
  const state = useLive((id) => dashboardApi.listEnquiries(id), {
    enquiries: seedEnquiries.map(toApiShape),
    summary: { open: seedEnquiries.length, emergency: 1, unnotified: 0 },
  });
  const [acted, setActed] = useState<Record<string, "contacted" | "closed">>({});
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, what: "contacted" | "closed", isDemoData: boolean) => {
    if (isDemoData) return;
    setBusy(id);
    const res = what === "contacted"
      ? await dashboardApi.markEnquiryContacted(id)
      : await dashboardApi.resolveEnquiry(id);
    setBusy(null);
    // ⛔ Only reflect it on screen if the API actually took it. An optimistic
    // update that survives a failed request is how an owner comes to believe
    // they called someone back.
    if (res.ok) setActed((prev) => ({ ...prev, [id]: what }));
  };

  return (
    <>
      <Head
        title="Enquiries"
        sub="Everything the agent captured, most urgent first. Mark one off when you have called them back."
      />
      <Live state={state}>
        {(data, isDemoData) => {
          const rows = data.enquiries
            .map((e) => ({ ...e, status: acted[e.id] ?? e.status }))
            .filter((e) => e.status !== "closed");
          if (rows.length === 0) {
            return <Empty>Nothing waiting. Enquiries land here the moment your agent captures one.</Empty>;
          }
          return (
            <>
              {isDemoData && <DemoBanner />}
              {data.summary.emergency > 0 && (
                <div className="adw-notice adw-notice-warn" role="status" style={{ marginBottom: 14 }}>
                  <strong>
                    {data.summary.emergency} emergency {data.summary.emergency === 1 ? "enquiry" : "enquiries"} waiting.
                  </strong>
                </div>
              )}
              <div className="adw-col" style={{ gap: 12 }}>
                {rows.map((e, i) => (
                  <Reveal key={e.id} stagger={i}>
                    <Card>
                      <div className="adw-spread">
                        <div>
                          <div className="adw-row" style={{ gap: 8, alignItems: "center" }}>
                            <strong>{e.name ?? "Someone"}</strong>
                            <Badge tone={urgencyTone(e.urgency)}>{e.urgency}</Badge>
                            {e.status === "contacted" && <Badge tone="ok">called back</Badge>}
                          </div>
                          <p style={{ margin: "6px 0 0", maxWidth: "60ch" }}>{e.need}</p>
                          <div className="adw-muted" style={{ fontSize: "0.85rem", marginTop: 6 }}>
                            {/* The number is the point of the screen. */}
                            <strong style={{ color: "var(--adw-text)" }}>{e.contact}</strong>
                            {" · "}
                            {new Date(e.createdAt).toLocaleString()}
                          </div>
                        </div>
                        <div className="adw-row" style={{ gap: 8 }}>
                          {e.status === "open" && (
                            <button
                              className="adw-btn adw-ghost adw-sm"
                              disabled={busy === e.id || isDemoData}
                              onClick={() => void act(e.id, "contacted", isDemoData)}
                            >
                              Called back
                            </button>
                          )}
                          <button
                            className="adw-btn adw-sm"
                            disabled={busy === e.id || isDemoData}
                            onClick={() => void act(e.id, "closed", isDemoData)}
                          >
                            Done
                          </button>
                          <button
                            className="adw-btn adw-ghost adw-sm"
                            onClick={() => setOpen(open === e.id ? null : e.id)}
                            aria-expanded={open === e.id}
                          >
                            {open === e.id ? "Hide" : "Details"}
                          </button>
                        </div>
                      </div>
                      {open === e.id && (
                        <div className="adw-muted" style={{ marginTop: 14, fontSize: "0.86rem" }}>
                          <div>Captured {new Date(e.createdAt).toLocaleString()}</div>
                          <div>
                            {/* ⛔ Says plainly whether we managed to email them. An
                                owner who thinks they were notified and was not will
                                not go looking. */}
                            {e.notifiedAt === null
                              ? "We have not been able to email you about this one — it is here on the dashboard instead."
                              : `We emailed you about this at ${new Date(e.notifiedAt).toLocaleString()}.`}
                          </div>
                        </div>
                      )}
                    </Card>
                  </Reveal>
                ))}
              </div>
            </>
          );
        }}
      </Live>
    </>
  );
}

/** Renders the design-review fixtures through the live shape. */
function toApiShape(e: Enquiry): ApiEnquiry {
  return {
    id: e.id, name: e.name, need: e.need, contact: e.contact, urgency: e.urgency,
    status: "open", createdAt: new Date().toISOString(), notifiedAt: new Date().toISOString(),
    resolvedAt: null, resolvedBy: null, sessionId: null,
  };
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

  // ⛔ For a REAL customer the fixtures are never shown. They used to be the
  // first paint and the permanent fallback, so a failed request left Bright
  // Plumbing's sample questions on a paying owner's screen indefinitely. Now the
  // panel loads, and says so if it cannot.
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    const customerId = customerIdFromUrl();
    if (customerId === DEMO_CUSTOMER_ID) return;
    let alive = true;
    setGaps([]);
    void dashboardApi.listGaps(customerId).then((res) => {
      if (!alive) return;
      if (!res.live) {
        setUnreachable(true);
        return;
      }
      setGaps(
        res.data.gaps.map((g) => ({
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
      alive = false;
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

      {unreachable ? (
        <Unreachable />
      ) : open.length === 0 ? (
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

/**
 * ⛔ There was a POST to take a slot, a POST to cancel one, and no GET at all,
 * so a booking the agent accepted was invisible to the one person obliged to
 * turn up for it. This screen showed fixtures.
 */
export function BookingsView() {
  const state = useLive((id) => dashboardApi.listBookings(id), {
    bookings: seedBookings.map((b, i) => ({
      id: b.id,
      start: new Date(Date.now() + (i + 1) * 86_400_000).toISOString(),
      end: new Date(Date.now() + (i + 1) * 86_400_000 + 3_600_000).toISOString(),
      contact: b.contact,
      status: b.status,
      resourceName: b.service,
      createdAt: new Date().toISOString(),
    })),
  });
  const [cancelled, setCancelled] = useState<Record<string, true>>({});

  return (
    <>
      <Head
        title="Bookings"
        sub="Everything the agent put in your diary, soonest first."
      />
      <Live state={state}>
        {(data, isDemoData) => {
          const rows = data.bookings.filter((b) => cancelled[b.id] === undefined);
          if (rows.length === 0) return <Empty>Nothing booked yet.</Empty>;
          return (
            <>
              {isDemoData && <DemoBanner />}
              <div className="adw-col" style={{ gap: 10 }}>
                {rows.map((b, i) => {
                  const start = new Date(b.start);
                  return (
                    <Reveal key={b.id} stagger={i}>
                      <Card>
                        <div className="adw-spread">
                          <div>
                            <strong>
                              {start.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
                              {" · "}
                              {start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                            </strong>
                            <div className="adw-muted" style={{ fontSize: "0.9rem", marginTop: 4 }}>
                              {b.contact ?? "No contact given"}
                              {b.resourceName === null ? "" : ` · ${b.resourceName}`}
                            </div>
                          </div>
                          <div className="adw-row" style={{ gap: 8, alignItems: "center" }}>
                            <Badge tone={b.status === "confirmed" ? "ok" : b.status === "held" ? "warn" : "bad"}>
                              {b.status}
                            </Badge>
                            <button
                              className="adw-btn adw-ghost adw-sm"
                              disabled={isDemoData}
                              onClick={() => {
                                void dashboardApi.cancelBooking(b.id).then((r) => {
                                  // Only strike it off if the API took it.
                                  if (r.ok) setCancelled((prev) => ({ ...prev, [b.id]: true }));
                                });
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </Card>
                    </Reveal>
                  );
                })}
              </div>
            </>
          );
        }}
      </Live>
    </>
  );
}

/**
 * The owner's queue (MF3).
 *
 * ⛔ Three worker jobs write `exceptions` rows WITH `customer_id` set — due
 * reminders, journey steps needing a person, and watcher findings at severity 2
 * or worse — and `@adw/cases` exports queue/acknowledge/resolve to work them.
 * No route served it and no screen read it, so those three jobs ran hourly,
 * looked healthy, and produced work nobody could see. This is the screen.
 */
export function QueueView() {
  const state = useLive((id) => dashboardApi.listQueue(id), { items: [] });
  const [done, setDone] = useState<Record<string, true>>({});
  const [busy, setBusy] = useState<string | null>(null);

  return (
    <>
      <Head
        title="Needs you"
        sub="Things the system noticed and deliberately did not decide for you. Most severe first."
      />
      <Live state={state}>
        {(data, isDemoData) => {
          const rows = data.items.filter((i) => done[i.id] === undefined);
          if (rows.length === 0) {
            return <Empty>Nothing needs you right now. This list is empty by design.</Empty>;
          }
          return (
            <div className="adw-col" style={{ gap: 12 }}>
              {rows.map((item, i) => (
                <Reveal key={item.id} stagger={i}>
                  <Card>
                    <div className="adw-spread">
                      <div>
                        <div className="adw-row" style={{ gap: 8, alignItems: "center" }}>
                          <strong>{humanTrigger(item.trigger)}</strong>
                          {item.severity <= 1 && <Badge tone="bad">urgent</Badge>}
                          {item.overdue && <Badge tone="warn">overdue</Badge>}
                        </div>
                        {/* ⛔ The recommendation, never an action already taken.
                            MF3's own clamp: "Flags, never clears — judgement
                            stays human." */}
                        <p style={{ margin: "6px 0 0", maxWidth: "62ch" }}>{item.recommendation}</p>
                        <div className="adw-muted" style={{ fontSize: "0.85rem", marginTop: 6 }}>
                          {item.systemAction} · noticed {new Date(item.createdAt).toLocaleString()}
                        </div>
                      </div>
                      <div className="adw-row" style={{ gap: 8 }}>
                        {item.acknowledgedAt === null && (
                          <button
                            className="adw-btn adw-ghost adw-sm"
                            disabled={busy === item.id || isDemoData}
                            onClick={() => {
                              setBusy(item.id);
                              void dashboardApi.acknowledgeQueueItem(item.id).then(() => setBusy(null));
                            }}
                          >
                            Seen it
                          </button>
                        )}
                        <button
                          className="adw-btn adw-sm"
                          disabled={busy === item.id || isDemoData}
                          onClick={() => {
                            setBusy(item.id);
                            void dashboardApi.resolveQueueItem(item.id, "handled by the owner").then((r) => {
                              setBusy(null);
                              if (r.ok) setDone((prev) => ({ ...prev, [item.id]: true }));
                            });
                          }}
                        >
                          Done
                        </button>
                      </div>
                    </div>
                  </Card>
                </Reveal>
              ))}
            </div>
          );
        }}
      </Live>
    </>
  );
}

/** Trigger keys are for us; the owner gets a sentence. */
function humanTrigger(trigger: string): string {
  const known: Record<string, string> = {
    reminder_due: "A date you asked to be reminded about",
    journey_step_due: "A follow-up is due",
    watch_finding: "Something changed in your market",
    enquiry_notification_undelivered: "We could not email you about an enquiry",
    document_chase_due: "A document is still outstanding",
  };
  return known[trigger] ?? trigger.replace(/_/g, " ");
}

/**
 * ⛔ Photo triage and review drafting have a table and a design, and no read
 * route — so for a REAL customer this list is empty rather than populated with
 * someone else's sample jobs. Showing a paying owner three fabricated photo
 * assessments is worse than showing them nothing: they would reply to them.
 *
 * The fixtures survive for the demo id, which is the design-review surface.
 */
export function PhotosView({ items }: { items?: PhotoItem[] }) {
  const rows = items ?? (isDemo() ? seedPhotos : []);
  return <PhotosPanel items={rows} demo={items === undefined && isDemo()} />;
}

function PhotosPanel({ items, demo }: { items: PhotoItem[]; demo: boolean }) {
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

export function ReviewsView({ items }: { items?: ReviewItem[] }) {
  const rows = items ?? (isDemo() ? seedReviews : []);
  return <ReviewsPanel items={rows} demo={items === undefined && isDemo()} />;
}

function ReviewsPanel({ items, demo }: { items: ReviewItem[]; demo: boolean }) {
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

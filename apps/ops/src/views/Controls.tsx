// Controls — the kill switches.
//
// ⛔ Its own view, deliberately not under Settings. Pulling a kill switch is an
// incident action, not a preference, and it should not sit two rows below a
// branding colour picker.
//
// ⛔ And it WRITES. The previous console rendered five switches whose toggle
// called `setSwitches(...)` — local React state, nothing else. `toggleKillSwitch`
// existed in the API client with zero call sites. An operator pulling
// HALT_ALL_SENDING during an incident watched the toggle turn red, read
// "engaged by you", and the gate carried on sending. That is worse than having
// no switch at all: a control that appears to work stops you looking for the
// real one, and you find out during the incident it was installed for.
//
// So this screen shows THREE things per switch, which are not the same thing:
//   • what is stored,
//   • what the gate's own reader returns (`confirmedByGate`),
//   • how long other processes may keep serving a stale reading.

import { useState } from "react";
import {
  AsOf, Board, Eyebrow, ViewHead, shortAge, usePoll,
} from "../primitives.tsx";
import { api, type KillSwitchBoard, type KillSwitchRow } from "../api.ts";

/** What each switch actually stops, in the words of the thing it stops. */
const WHAT_IT_DOES: Record<string, string> = {
  HALT_ALL_SENDING:
    "Every outbound message is denied at the gate — cold, warm, transactional and journey steps alike. The single biggest hammer in the system.",
  HALT_COLD_ONLY:
    "Cold outreach is denied; conversations already in progress and transactional mail continue.",
  HALT_BUILDS:
    "No site is built, deployed or cut over. In-flight builds stop at their next activity rather than half-deploying.",
  HALT_PAYMENTS_ONBOARDING:
    "No new connected account is created and no prescreen is offered, so nobody is left half-onboarded. Existing subscriptions are unaffected.",
};

export function Controls() {
  const [board, reload] = usePoll(() => api.killSwitches(), 10_000);
  const [pending, setPending] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ name: string; confirmed: boolean } | null>(null);

  const toggle = async (name: string, engage: boolean) => {
    // ⛔ Engaging asks first. Releasing does not: during an incident the
    // dangerous direction is turning something back ON, and a confirm dialogue
    // between an operator and stopping the bleeding is a design mistake.
    if (engage && !window.confirm(`Engage ${name}?\n\n${WHAT_IT_DOES[name] ?? "This stops the named work."}`)) return;
    setPending(name);
    const res = await api.toggleKillSwitch(name, engage);
    setPending(null);
    if (res.status === "ok") setLastResult({ name, confirmed: res.data.confirmedByGate });
    reload();
  };

  return (
    <>
      <ViewHead
        title="Controls"
        blurb="The kill switches. Each one is read by the gate on every decision; the readback below comes from the gate's own reader, not from what we just wrote."
        right={<AsOf at={board.status === "ok" ? board.at : null} />}
      />

      <Board what="The kill switches" result={board}>
        {(data: KillSwitchBoard) => {
          const byName = new Map(data.switches.map((s) => [s.name, s]));
          // ⛔ Render the full roster, not the rows. A switch nobody has ever
          // pulled has no row, and those are precisely the ones an operator
          // will need to find in a hurry.
          const roster: KillSwitchRow[] = data.known.map(
            (name) =>
              byName.get(name) ?? {
                name, engaged: false, toggled_by: null, toggled_at: null, confirmedByGate: true,
              },
          );
          const engaged = roster.filter((s) => s.engaged);
          const disagreeing = roster.filter((s) => !s.confirmedByGate);

          return (
            <>
              <Eyebrow
                count={`${engaged.length}/${roster.length}`}
                note={`a released switch propagates to other processes within ${data.propagationSeconds}s`}
              >
                Engaged
              </Eyebrow>

              {disagreeing.length > 0 ? (
                <div className="failed" style={{ marginBottom: "var(--s2)" }}>
                  {disagreeing.length} switch(es) are stored one way and read by the gate another.
                  Treat the gate's reading as the truth and investigate before relying on either.
                </div>
              ) : null}

              {roster.map((s) => (
                <div className="switch-row" key={s.name}>
                  <div>
                    <div className="switch-name">{s.name}</div>
                    <p className="switch-what">{WHAT_IT_DOES[s.name] ?? "Stops the named work."}</p>
                    <div className="switch-meta">
                      {s.engaged ? (
                        <>
                          engaged by {s.toggled_by ?? "unknown"} · {shortAge(s.toggled_at)} ago
                        </>
                      ) : s.toggled_at === null ? (
                        "never engaged"
                      ) : (
                        <>released by {s.toggled_by ?? "unknown"} · {shortAge(s.toggled_at)} ago</>
                      )}
                    </div>
                    {/* The readback. This line is the whole point of the screen. */}
                    <div className="switch-confirm" data-ok={s.confirmedByGate}>
                      {s.confirmedByGate
                        ? `gate confirms: ${s.engaged ? "denying" : "allowing"}`
                        : "⚠ the gate does NOT agree with the stored state"}
                    </div>
                  </div>
                  <button
                    className="btn"
                    data-tone={s.engaged ? undefined : "danger"}
                    disabled={pending === s.name}
                    onClick={() => void toggle(s.name, !s.engaged)}
                  >
                    {pending === s.name ? "…" : s.engaged ? "Release" : "Engage"}
                  </button>
                </div>
              ))}

              {lastResult === null ? null : (
                <p className="figure-evidence" style={{ marginTop: "var(--s2)" }}>
                  {lastResult.name}:{" "}
                  {lastResult.confirmed
                    ? "confirmed by the gate's own reader."
                    : "the gate did NOT confirm the change — investigate."}
                </p>
              )}

              <section className="section" style={{ marginTop: "var(--s4)" }}>
                <Eyebrow>Not on this screen, on purpose</Eyebrow>
                <p className="figure-evidence" style={{ maxWidth: "68ch" }}>
                  Jurisdiction rules, pricing, thresholds and the prohibited-category list are
                  config, changed by pull request and reviewed. There is no route in this console
                  that writes them, and there is not meant to be — a compliance rule editable at
                  three in the morning by whoever is on call is not a compliance rule.
                </p>
              </section>
            </>
          );
        }}
      </Board>
    </>
  );
}

// Evidence-first primitives.
//
// The rule these enforce, everywhere, without the caller having to remember:
//
//   1. A figure carries its window and its denominator.
//   2. Unmeasured renders as — and never as 0.
//   3. An empty list says what was checked to find it empty.
//   4. A failure says which board failed and why, and does not blank the page.
//
// This system's characteristic defect is silent success: components that report
// fine while doing nothing. The console's job is to make that impossible to
// render, which means the primitives have to refuse it rather than the views
// having to remember not to do it.

import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { isOk, type Loaded } from "./api.ts";

/**
 * One view crashing must not take the console down.
 *
 * ⛔ Found by the screenshot walk rather than by reading the code: one view read
 * an array off a payload that was an object, threw, and every OTHER view went
 * blank — including Controls, which is where an operator goes to stop things.
 * A console that loses its kill switches because an unrelated table had the
 * wrong shape is a console that fails exactly when it is needed.
 *
 * The message names the view and shows the error, because "something went
 * wrong" tells the person who has to fix it nothing at all.
 */
export class ViewBoundary extends Component<
  { view: string; children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ops] ${this.props.view} crashed`, error, info.componentStack);
  }

  override componentDidUpdate(prev: { view: string }): void {
    // Navigating away clears the error, so a crash is not sticky for the rest
    // of the session.
    if (prev.view !== this.props.view && this.state.error !== null) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="failed" role="alert">
        <strong>{this.props.view} could not render.</strong> {this.state.error.message}
        <br />
        Every other view is unaffected — the navigation on the left still works, including Controls.
      </div>
    );
  }
}

// ── Time ──────────────────────────────────────────────────────────────────

/** "4m", "3h", "12d" — short enough for a table cell, exact enough to act on. */
export function shortAge(from: Date | string | null, now = new Date()): string {
  if (from === null) return "—";
  const ms = now.getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function clockTime(at: Date | string): string {
  const d = new Date(at);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** A cadence in words. "every 10s", "hourly", "daily". */
export function cadence(ms: number): string {
  if (ms < 60_000) return `every ${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `every ${Math.round(ms / 60_000)}m`;
  if (ms === 3_600_000) return "hourly";
  if (ms < 86_400_000) return `every ${Math.round(ms / 3_600_000)}h`;
  if (ms === 86_400_000) return "daily";
  return `every ${Math.round(ms / 86_400_000)}d`;
}

// ── Money ─────────────────────────────────────────────────────────────────

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  return (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * ⛔ A rate over an empty denominator is undefined, not zero. This returns the
 * em dash so a caller cannot accidentally print "0.00%" for "we have not
 * measured this", which is the specific lie that makes a broken fleet look
 * like a quiet one.
 */
export function rate(numerator: number, denominator: number, digits = 2): string {
  if (denominator === 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(digits)}%`;
}

// ── State ─────────────────────────────────────────────────────────────────

const STATE_WORDS: Record<string, string> = {
  ok: "ok",
  stale: "stale",
  failing: "failing",
  never_run: "never run",
  attention: "waiting",
  unconfigured: "never used",
  not_applicable: "n/a",
  unknown: "unknown",
};

export function State({ state, label }: { state: string; label?: string }) {
  return (
    <span className="state" data-state={state}>
      <span className="state-dot" aria-hidden="true" />
      <span className="state-word">{label ?? STATE_WORDS[state] ?? state}</span>
    </span>
  );
}

// ── Figures ───────────────────────────────────────────────────────────────

export interface FigureProps {
  label: string;
  /** Null means unmeasured. It renders as — and is styled as absent. */
  value: string | number | null;
  unit?: string;
  /** Where the number came from and over what. Always shown, never a tooltip. */
  evidence: string;
  /** Optional progress against a ceiling. Omitted entirely when there is none. */
  of?: { used: number; cap: number } | undefined;
}

export function FigureTile({ label, value, unit, evidence, of }: FigureProps) {
  const unmeasured = value === null;
  const pct = of === undefined || of.cap <= 0 ? null : Math.min(1, of.used / of.cap);
  const tone = pct === null ? undefined : pct >= 0.9 ? "bad" : pct >= 0.7 ? "warn" : undefined;
  return (
    <div className="figure">
      <span className="figure-label">{label}</span>
      <span className="figure-value" data-unmeasured={unmeasured}>
        {unmeasured ? "—" : value}
        {unit !== undefined && !unmeasured ? <span className="figure-unit"> {unit}</span> : null}
      </span>
      {/* ⛔ Not optional. A figure with no evidence line is a figure whose
          population you cannot check, and this console has been wrong that way
          before. */}
      <span className="figure-evidence">{evidence}</span>
      {pct === null ? null : (
        <span className="figure-bar">
          <span style={{ width: `${(pct * 100).toFixed(1)}%` }} {...(tone === undefined ? {} : { "data-tone": tone })} />
        </span>
      )}
    </div>
  );
}

export function Figures({ children }: { children: ReactNode }) {
  return <div className="figures">{children}</div>;
}

// ── Sections ──────────────────────────────────────────────────────────────

export function Eyebrow({
  children, count, note,
}: { children: ReactNode; count?: string | number | undefined; note?: ReactNode }) {
  return (
    <h2 className="eyebrow">
      <span>{children}</span>
      {count === undefined ? null : <span className="count">{count}</span>}
      {note === undefined ? null : <span className="note spacer">{note}</span>}
    </h2>
  );
}

export function ViewHead({ title, blurb, right }: { title: string; blurb: string; right?: ReactNode }) {
  return (
    <header className="view-head">
      <div>
        <h1>{title}</h1>
        <p>{blurb}</p>
      </div>
      {right}
    </header>
  );
}

/**
 * The as-of stamp.
 *
 * ⛔ Every view carries one. A console whose numbers have no age cannot tell
 * you it has stopped updating — it just keeps showing you this morning.
 */
export function AsOf({ at, window: w }: { at: Date | string | null; window?: string }) {
  if (at === null) return <span className="figure-evidence">never loaded</span>;
  return (
    <span className="figure-evidence">
      as of {clockTime(at)}
      {w === undefined ? "" : ` · ${w}`}
    </span>
  );
}

// ── Empty, failed, loading ────────────────────────────────────────────────

/**
 * ⛔ `checked` is required. "Nothing to do" is only trustworthy alongside what
 * was looked at to reach it, and the difference between an idle system and a
 * broken query is the whole reason an operator opens this screen.
 */
export function Empty({ headline, checked }: { headline: string; checked: string }) {
  return (
    <div className="empty">
      <strong>{headline}</strong>
      <span>{checked}</span>
    </div>
  );
}

export function Failed({ what, reason }: { what: string; reason: string }) {
  return (
    <div className="failed" role="status">
      {what} could not be loaded — {reason}. Nothing is shown for it rather than
      a stale or invented value.
    </div>
  );
}

/** Renders a `Loaded<T>` through all three states so a view cannot skip one. */
export function Board<T>({
  what, result, children,
}: { what: string; result: Loaded<T>; children: (data: T) => ReactNode }) {
  if (result.status === "loading") return <div className="skeleton" aria-label={`loading ${what}`} />;
  if (result.status === "failed") return <Failed what={what} reason={result.reason} />;
  return <>{children(result.data)}</>;
}

// ── Data loading ──────────────────────────────────────────────────────────

/**
 * Fetch once and on an interval.
 *
 * ⛔ A failed refresh REPLACES the previous value rather than leaving it on
 * screen. Keeping the last good render is the friendlier choice and the wrong
 * one: an operator watching a frozen board during an outage would be reading
 * numbers from before it started, with nothing saying so.
 */
export function usePoll<T>(
  fetcher: () => Promise<Loaded<T>>,
  everyMs: number | null = 15_000,
): [Loaded<T>, () => void] {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const run = () => {
      void fetcherRef.current().then((r) => {
        if (alive) setState(r);
      });
    };
    run();
    if (everyMs === null) return () => { alive = false; };
    const timer = setInterval(run, everyMs);
    return () => { alive = false; clearInterval(timer); };
  }, [everyMs, nonce]);

  return [state, () => setNonce((n) => n + 1)];
}

export { isOk };

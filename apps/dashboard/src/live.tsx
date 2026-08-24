// One loading contract for every panel.
//
// ⛔ THE PATTERN THIS REPLACES WAS A SILENT FAILURE MACHINE. Each view began
// with a fixture, fired a request, and upgraded if it succeeded. When it did
// not succeed — API down, session expired, network gone — the fixture stayed on
// screen. So a real owner saw a complete, plausible, entirely fabricated
// dashboard (342 visits, 28 calls, two paid invoices, all belonging to a
// business called Bright Plumbing) and had no way to tell it was not theirs.
//
// There are exactly three states here and the UI must render all three:
// loading, loaded, and could-not-load. Fixtures exist only for the demo id,
// which is the design-review surface and never a paying customer.
import { useEffect, useState, type ReactNode } from "react";
import { customerIdFromUrl, isDemo, type Fetched } from "./api.ts";

export type LiveState<T> =
  | { status: "loading" }
  | { status: "demo"; data: T }
  | { status: "ready"; data: T }
  | { status: "unreachable" };

/**
 * Fetch one panel's data for the signed-in customer.
 *
 * `demoData` is rendered ONLY for the demo customer id. For anybody else an
 * unreachable API is reported as unreachable — never smoothed over with sample
 * content that reads as real.
 */
export function useLive<T>(fetcher: (customerId: string) => Promise<Fetched<T>>, demoData: T): LiveState<T> {
  const [state, setState] = useState<LiveState<T>>(() =>
    isDemo() ? { status: "demo", data: demoData } : { status: "loading" },
  );

  useEffect(() => {
    const customerId = customerIdFromUrl();
    if (isDemo(customerId)) return;
    let alive = true;
    void fetcher(customerId).then((res) => {
      if (!alive) return;
      setState(res.live ? { status: "ready", data: res.data } : { status: "unreachable" });
    });
    return () => {
      alive = false;
    };
    // The customer id comes from the URL and the panel remounts on navigation
    // (RoutedMain keys on pathname), so this runs exactly once per mount by
    // design. `fetcher` is an inline closure at every call site; depending on it
    // would refetch on every render.
  }, []);

  return state;
}

/**
 * Render a panel from its live state.
 *
 * ⛔ `unreachable` gets its own visible treatment rather than an empty list.
 * "Nothing came in today" and "we could not reach the server" look identical as
 * an empty table, and for a screen whose whole job is to show incoming work,
 * confusing the two is how a business misses a customer.
 */
export function Live<T>({
  state,
  children,
  loading,
}: {
  state: LiveState<T>;
  children: (data: T, isDemoData: boolean) => ReactNode;
  loading?: ReactNode;
}) {
  if (state.status === "loading") return <>{loading ?? <LoadingRows />}</>;
  if (state.status === "unreachable") return <Unreachable />;
  return <>{children(state.data, state.status === "demo")}</>;
}

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="adw-col" style={{ gap: 12 }} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="adw-skeleton"
          style={{ height: 76, borderRadius: 10 }}
          aria-hidden="true"
        />
      ))}
      <span className="adw-visually-hidden">Loading</span>
    </div>
  );
}

/**
 * ⛔ Says what happened and what it does NOT mean. An owner who reads "no
 * enquiries" when the truth is "we could not check" will not chase the
 * enquiry that is sitting there.
 */
export function Unreachable() {
  return (
    <div className="adw-notice adw-notice-warn" role="status">
      <strong>We couldn&rsquo;t load this just now.</strong>
      <p style={{ margin: "6px 0 0" }}>
        This is a connection problem on our side, not an empty list — anything waiting for you is still
        there. Try again in a moment.
      </p>
      <button className="adw-btn adw-ghost adw-sm" style={{ marginTop: 10 }} onClick={() => window.location.reload()}>
        Try again
      </button>
    </div>
  );
}

/**
 * Marks a panel that is showing sample content. Only ever rendered for the demo
 * id, and rendered LOUDLY, so a screenshot taken during design review cannot be
 * mistaken for a real customer's dashboard.
 */
export function DemoBanner() {
  return (
    <div className="adw-notice" role="note" style={{ marginBottom: 14 }}>
      <strong>Sample data.</strong> You&rsquo;re viewing the demo dashboard — these figures are illustrative
      and belong to no real business.
    </div>
  );
}

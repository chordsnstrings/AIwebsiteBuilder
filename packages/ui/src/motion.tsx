// Microanimation primitives. Entrance reveals fire once via a shared
// IntersectionObserver (no scroll listeners); the animated counter uses
// requestAnimationFrame and honours prefers-reduced-motion. Everything animates
// transform/opacity only.
import { useEffect, useRef, useState, type ReactNode } from "react";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Reveals children with a fade-up the first time they scroll into view. */
export function Reveal({
  children,
  stagger,
  pop,
  className = "",
}: {
  children: ReactNode;
  stagger?: number;
  pop?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const cls = `${pop ? "adw-pop" : "adw-reveal"} ${shown ? "adw-in" : ""} ${className}`.trim();
  const style = stagger !== undefined ? ({ ["--i"]: stagger } as React.CSSProperties) : undefined;
  return (
    <div ref={ref} className={cls} data-stagger={stagger !== undefined ? "" : undefined} style={style}>
      {children}
    </div>
  );
}

/** Counts up to a value on mount. Respects reduced motion. */
export function Counter({ to, decimals = 0, prefix = "", suffix = "", durationMs = 900 }: { to: number; decimals?: number; prefix?: string; suffix?: string; durationMs?: number }) {
  const [val, setVal] = useState(prefersReducedMotion() ? to : 0);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setVal(to);
      return;
    }
    let raf = 0;
    let start: number | null = null;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min(1, (ts - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(to * eased);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, durationMs]);
  return (
    <span style={{ fontVariantNumeric: "tabular-nums" }}>
      {prefix}
      {val.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  );
}

/** Theme toggle that stamps data-theme on the root (wins over system default). */
export function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState<string>(() => {
    if (typeof document === "undefined") return "light";
    return document.documentElement.getAttribute("data-theme") ?? "light";
  });
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    setTheme(next);
  };
  return [theme, toggle];
}

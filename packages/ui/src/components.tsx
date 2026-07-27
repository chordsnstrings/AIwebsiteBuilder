// Shared React components. Presentational only, style-driven by styles.css.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  variant = "primary",
  size,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger"; size?: "sm" }) {
  const cls = `adw-btn ${variant === "ghost" ? "adw-ghost" : ""} ${variant === "danger" ? "adw-danger" : ""} ${size === "sm" ? "adw-sm" : ""} ${className}`;
  return (
    <button className={cls.trim()} {...rest}>
      {children}
    </button>
  );
}

export function Card({ children, hoverable, className = "", style }: { children: ReactNode; hoverable?: boolean; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`adw-card ${hoverable ? "adw-hoverable" : ""} ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" }) {
  const map = { neutral: "", ok: "adw-ok", warn: "adw-warn", bad: "adw-bad" };
  return (
    <span className={`adw-badge ${map[tone]}`.trim()}>
      {(tone === "ok" || tone === "warn" || tone === "bad") && <span className="adw-dot" />}
      {children}
    </span>
  );
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="adw-stat">
      <div className="adw-stat-val">{children}</div>
      <div className="adw-stat-label">{label}</div>
    </div>
  );
}

export function Skeleton({ width = "100%", height = 16 }: { width?: string | number; height?: string | number }) {
  return <div className="adw-skeleton" style={{ width, height }} />;
}

export function Spinner() {
  return <span className="adw-spinner" role="status" aria-label="loading" />;
}

export function Table<T>({ columns, rows, empty }: { columns: { key: keyof T | string; header: string; render?: (row: T) => ReactNode }[]; rows: T[]; empty?: string }) {
  return (
    <div className="adw-table-wrap">
      <table className="adw-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={String(c.key)}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="adw-muted" style={{ textAlign: "center", padding: 28 }}>
                {empty ?? "Nothing here."}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={String(c.key)}>{c.render ? c.render(row) : String((row as Record<string, unknown>)[String(c.key)] ?? "")}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

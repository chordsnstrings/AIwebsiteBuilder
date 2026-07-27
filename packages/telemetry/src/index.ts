// Event taxonomy + sink (software documentation Ch. 7). One trace_id links the
// workflow execution, every gateway call, every gate decision and every event.
// PostgresEventSink now; ClickHouseEventSink (same envelope) selected by
// credential presence later. Secret values are redacted before persistence.
import type { Db } from "@adw/db";
import { getDb } from "@adw/db";

export interface AdwEvent {
  eventType: string;
  occurredAt?: Date;
  actor?: { kind: "agent" | "system" | "operator" | "customer"; id: string };
  subject?: { kind: string; id: string };
  region?: string;
  campaignId?: string;
  costCents?: number;
  model?: string;
  traceId?: string;
  payload?: Record<string, unknown>;
}

// Fingerprints of resolved secrets are registered here so we never persist them.
const redactionFingerprints = new Set<string>();
export function registerRedaction(fp: string): void {
  redactionFingerprints.add(fp);
}
function redact(value: unknown): unknown {
  if (typeof value === "string") {
    for (const fp of redactionFingerprints) {
      if (value.includes(fp)) return "[REDACTED]";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Never log raw secret-like keys.
      if (/secret|password|api_?key|token|card|ssn|bank/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

export interface EventSink {
  emit(event: AdwEvent): Promise<void>;
}

export class PostgresEventSink implements EventSink {
  constructor(private readonly db: Db) {}
  async emit(event: AdwEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO events
        (event_type, occurred_at, actor_kind, actor_id, subject_kind, subject_id,
         region, campaign_id, cost_cents, model, trace_id, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        event.eventType,
        event.occurredAt ?? new Date(),
        event.actor?.kind ?? null,
        event.actor?.id ?? null,
        event.subject?.kind ?? null,
        event.subject?.id ?? null,
        event.region ?? null,
        event.campaignId ?? null,
        event.costCents ?? null,
        event.model ?? null,
        event.traceId ?? null,
        JSON.stringify(redact(event.payload ?? {})),
      ],
    );
  }
}

let sink: EventSink | null = null;
export async function getSink(): Promise<EventSink> {
  if (!sink) sink = new PostgresEventSink(await getDb());
  return sink;
}
export function setSinkForTesting(s: EventSink | null): void {
  sink = s;
}

export async function emit(event: AdwEvent): Promise<void> {
  (await getSink()).emit(event).catch((err) => {
    // Telemetry must never break the caller. Log to stderr only.
    console.error("[telemetry] emit failed:", err instanceof Error ? err.message : err);
  });
}

/** Generate a trace id (workflow-independent contexts). */
export function newTraceId(): string {
  return "tr_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

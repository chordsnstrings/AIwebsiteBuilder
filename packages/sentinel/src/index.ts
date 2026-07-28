// The Sentinel (spec §71–73). Detection is code; diagnosis is a model. Layer 1
// active probes and Layer 2 passive signals are deterministic; the Sentinel
// agent only classifies and explains after code has decided something is broken.
// Alerting is vendor-independent and SEV1 bypasses the CEO agent. A dead man's
// switch heartbeat to an external service means you are alerted by ABSENCE.
import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";

export * from "./probes.ts";
export * from "./remediation.ts";
export * from "./runner.ts";
export * from "./signals.ts";

export type Severity = 1 | 2 | 3 | 4;

export interface AlertChannel {
  kind: "push" | "phone" | "email";
  vendorId: string; // MUST NOT be a vendor this channel monitors
  send(message: string, severity: Severity): Promise<void>;
}

export interface AlertRouterConfig {
  push: AlertChannel; // primary SEV1; used for nothing else
  phone: AlertChannel; // secondary SEV1; NEVER Twilio (Twilio is monitored)
  email: AlertChannel; // tertiary; any path EXCEPT SES
}

// Channel-independence guard: no alert channel may route through a vendor it is
// responsible for watching (spec §73.3).
export function assertChannelIndependence(cfg: AlertRouterConfig, monitoredVendors: Set<string>): void {
  for (const ch of [cfg.push, cfg.phone, cfg.email]) {
    if (monitoredVendors.has(ch.vendorId)) {
      throw new Error(`Alert channel ${ch.kind} routes through monitored vendor ${ch.vendorId} (spec §73.3).`);
    }
  }
  if (cfg.phone.vendorId === "twilio") {
    throw new Error("Phone alert leg must never be Twilio — Twilio is itself monitored (spec §73.3).");
  }
  if (cfg.email.vendorId === "aws_ses") {
    throw new Error("Email alert leg must never be SES — SES is itself monitored (spec §73.3).");
  }
}

export interface Incident {
  vendorId: string;
  failureClass: string;
  severity: Severity;
  diagnosis?: string;
  runbookRef?: string;
}

/**
 * Route an alert. SEV1 bypasses the CEO agent entirely (push → phone), human
 * notified in under 60s; SEV2+ goes to CEO triage.
 */
export async function routeAlert(cfg: AlertRouterConfig, incident: Incident): Promise<void> {
  const msg = `[SEV${incident.severity}] ${incident.vendorId}: ${incident.failureClass}${incident.diagnosis ? " — " + incident.diagnosis : ""}`;
  if (incident.severity === 1) {
    // Bypass the CEO agent. Push then phone.
    await cfg.push.send(msg, 1);
    await cfg.phone.send(msg, 1);
  }
  await emit({ eventType: "exception.raised", payload: { ...incident } });
}

/** Aggregation: group by vendor+failureClass in a 5-minute window (spec §73.4). */
export function aggregate(
  incidents: Incident[],
): { key: string; vendorId: string; failureClass: string; severity: Severity; count: number }[] {
  const groups = new Map<string, { vendorId: string; failureClass: string; severity: Severity; count: number }>();
  for (const inc of incidents) {
    const key = `${inc.vendorId}:${inc.failureClass}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.severity = Math.min(g.severity, inc.severity) as Severity;
    } else {
      groups.set(key, { vendorId: inc.vendorId, failureClass: inc.failureClass, severity: inc.severity, count: 1 });
    }
  }
  // > 10 distinct vendors failing simultaneously → one multi_vendor_event.
  const distinctVendors = new Set(incidents.map((i) => i.vendorId));
  if (distinctVendors.size > 10) {
    return [{ key: "multi_vendor_event", vendorId: "*", failureClass: "multi_vendor_event", severity: 1, count: incidents.length }];
  }
  return [...groups.entries()].map(([key, g]) => ({ key, ...g }));
}

// ---------------------------------------------------------------------------
// Dead man's switch (spec §71.6). The Sentinel emits a heartbeat every 60s to an
// external service that monitors nothing else. Three missed heartbeats and that
// service alerts the human directly. You are alerted by absence, not presence.
// ---------------------------------------------------------------------------
/**
 * The source a heartbeat belongs to. Named rather than hardcoded because more
 * than one thing needs watching by absence — the Sentinel itself, and (once the
 * cutover controller runs unattended) the DNS verifier. A switch that can only
 * observe one source silently reports on whichever wrote last.
 */
export const HEARTBEAT_SOURCE = "sentinel";

export async function emitHeartbeat(db: Db, now = new Date(), source = HEARTBEAT_SOURCE): Promise<void> {
  await db.query("INSERT INTO heartbeats (source, beat_at) VALUES ($2, $1)", [now, source]);
}

export async function heartbeatMissed(
  db: Db,
  now = new Date(),
  thresholdMs = 3 * 60_000,
  source = HEARTBEAT_SOURCE,
): Promise<boolean> {
  const row = await db.maybeOne<{ beat_at: string }>(
    "SELECT beat_at FROM heartbeats WHERE source = $1 ORDER BY beat_at DESC LIMIT 1",
    [source],
  );
  // No beat at all is a miss. Absence is the signal.
  if (!row) return true;
  return now.getTime() - new Date(row.beat_at).getTime() > thresholdMs;
}

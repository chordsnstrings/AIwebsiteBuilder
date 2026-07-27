// Stateful in-memory alerting simulators. MockAlertChannel records deliveries
// so a test can assert that a SEV1 actually left the building; the probe path
// deliberately does NOT deliver, because a health check must never wake a human.
// MockHeartbeatReceiver is the external dead man's switch: it counts the beats
// it did not receive.
import { BaseMockVendor } from "../health.ts";
import type { AlertChannel, AlertChannelKind, AlertDelivery, AlertSeverity, HeartbeatReceiver } from "./types.ts";

export class MockAlertChannel extends BaseMockVendor implements AlertChannel {
  readonly kind: AlertChannelKind;
  private readonly deliveries: AlertDelivery[] = [];
  private seq = 0;
  private probes = 0;

  constructor(vendorId: string, kind: AlertChannelKind) {
    super(vendorId);
    this.kind = kind;
  }

  async send(message: string, severity: AlertSeverity): Promise<void> {
    this.assertUp("send");
    this.seq += 1;
    this.deliveries.push({ vendorId: this.vendorId, kind: this.kind, message, severity, seq: this.seq });
  }

  delivered(): readonly AlertDelivery[] {
    return [...this.deliveries];
  }

  drainDeliveries(): AlertDelivery[] {
    return this.deliveries.splice(0, this.deliveries.length);
  }

  protected override async probeOperation(): Promise<string> {
    // Validate reachability without delivering — probes do not page anybody.
    this.probes += 1;
    return `${this.kind} channel reachable (${this.deliveries.length} delivered)`;
  }
}

export class MockHeartbeatReceiver extends BaseMockVendor implements HeartbeatReceiver {
  readonly intervalMs: number;
  private lastBeat: number | null = null;
  private beats = 0;

  constructor(vendorId = "healthchecks", intervalMs = 60_000) {
    super(vendorId);
    this.intervalMs = intervalMs;
  }

  async ping(at: Date = new Date()): Promise<void> {
    this.assertUp("ping");
    this.lastBeat = at.getTime();
    this.beats += 1;
  }

  missedBeats(now: Date = new Date()): number {
    if (this.lastBeat === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, Math.floor((now.getTime() - this.lastBeat) / this.intervalMs));
  }

  beatCount(): number {
    return this.beats;
  }

  lastBeatAt(): Date | null {
    return this.lastBeat === null ? null : new Date(this.lastBeat);
  }

  protected override async probeOperation(): Promise<string> {
    await this.ping();
    const missed = this.missedBeats();
    if (missed > 0) throw new Error(`${missed} missed heartbeats`);
    return `heartbeat ${this.beats} received`;
  }
}

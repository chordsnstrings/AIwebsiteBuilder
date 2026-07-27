// The AlertChannel capability. Alerting is deliberately vendor-independent and
// must never route through a vendor it is responsible for watching (spec §73.3)
// — hence separate push, phone and heartbeat vendors rather than one comms
// provider. The heartbeat receiver is the dead man's switch: you are alerted by
// ABSENCE, so its interface is a ping plus a count of missed beats.
export type AlertSeverity = 1 | 2 | 3 | 4;

export type AlertChannelKind = "push" | "phone" | "email" | "heartbeat";

export interface AlertDelivery {
  vendorId: string;
  kind: AlertChannelKind;
  message: string;
  severity: AlertSeverity;
  seq: number;
}

export interface AlertChannel {
  readonly vendorId: string;
  readonly kind: AlertChannelKind;
  send(message: string, severity: AlertSeverity): Promise<void>;
}

export interface HeartbeatReceiver {
  readonly vendorId: string;
  readonly intervalMs: number;
  ping(at?: Date): Promise<void>;
  /** Beats expected but not received. Infinity when nothing has ever pinged. */
  missedBeats(now?: Date): number;
}

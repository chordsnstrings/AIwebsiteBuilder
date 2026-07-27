// Sentinel Layer 2 — passive signals (spec §72.6). These are the failures that
// never throw: every request returns 200, no probe goes red, and the business
// quietly stops working. Sites render but forms do not arrive. Mail is accepted
// but lands in spam. An agent's output degrades but still parses.
//
// Detection here is pure arithmetic over a metrics window — no model, no
// judgement, no network call, no state. Code decides something is broken; the
// Sentinel agent only gets to classify and explain afterwards.
import type { Severity } from "./index.ts";

export interface SignalWindow {
  /** First-pass acceptance rate per agent role, 0..1. */
  firstPassRateByRole: Record<string, number>;
  /** Share of sends landing in the inbox rather than spam, 0..1. */
  inboxPlacement: number;
  /** Spam complaints as a fraction of delivered mail. */
  complaintRate: number;
  /** Operations that reported success but produced nothing. ANY is an alarm. */
  silentFailureCount: number;
  /** Share of previews that rendered, 0..1. */
  previewRenderSuccess: number;
  /** Share of form submissions that actually arrived, 0..1. */
  formSubmissionArrival: number;
  /** Share of traffic concentrated on a single provider, 0..1. */
  providerConcentration: number;
}

export type SignalComparison = "below" | "above";

export interface SignalRule {
  threshold: number;
  comparison: SignalComparison;
  severity: Severity;
  description: string;
}

export interface Signal {
  name: string;
  value: number;
  threshold: number;
  alarm: boolean;
  severity: Severity;
}

/**
 * Boundaries are exclusive: a value exactly ON the threshold is not an alarm.
 * Thresholds are the contract, so a metric sitting precisely at the agreed
 * floor is compliant, not broken.
 */
export const SIGNAL_RULES = {
  first_pass_rate: {
    threshold: 0.75,
    comparison: "below",
    severity: 3,
    description: "Agent output quality is degrading — escalations and rework are rising.",
  },
  inbox_placement: {
    threshold: 0.7,
    comparison: "below",
    severity: 2,
    description: "Mail is accepted but not seen — placement collapse precedes domain burn.",
  },
  complaint_rate: {
    threshold: 0.001,
    comparison: "above",
    severity: 1,
    description: "Complaint rate above the provider tolerance — sending reputation is at risk.",
  },
  silent_failures: {
    threshold: 0,
    comparison: "above",
    severity: 1,
    description: "An operation reported success and produced nothing. Any occurrence is an alarm.",
  },
  preview_render_success: {
    threshold: 0.97,
    comparison: "below",
    severity: 2,
    description: "Previews are failing to render — prospects see a broken product.",
  },
  form_submission_arrival: {
    threshold: 0.99,
    comparison: "below",
    severity: 1,
    description: "Customer leads are being dropped between the form and the inbox.",
  },
  provider_concentration: {
    threshold: 0.6,
    comparison: "above",
    severity: 3,
    description: "Too much volume on one provider — a single suspension becomes an outage.",
  },
} as const satisfies Record<string, SignalRule>;

function evaluate(name: string, value: number, rule: SignalRule): Signal {
  const alarm = rule.comparison === "below" ? value < rule.threshold : value > rule.threshold;
  return { name, value, threshold: rule.threshold, alarm, severity: rule.severity };
}

/** Evaluate an entire metrics window. One Signal per rule, per role where roles apply. */
export function evaluateSignals(metrics: SignalWindow): Signal[] {
  const signals: Signal[] = [];
  for (const role of Object.keys(metrics.firstPassRateByRole).sort()) {
    const value = metrics.firstPassRateByRole[role];
    if (value === undefined) continue;
    signals.push(evaluate(`first_pass_rate:${role}`, value, SIGNAL_RULES.first_pass_rate));
  }
  signals.push(evaluate("inbox_placement", metrics.inboxPlacement, SIGNAL_RULES.inbox_placement));
  signals.push(evaluate("complaint_rate", metrics.complaintRate, SIGNAL_RULES.complaint_rate));
  signals.push(evaluate("silent_failures", metrics.silentFailureCount, SIGNAL_RULES.silent_failures));
  signals.push(evaluate("preview_render_success", metrics.previewRenderSuccess, SIGNAL_RULES.preview_render_success));
  signals.push(evaluate("form_submission_arrival", metrics.formSubmissionArrival, SIGNAL_RULES.form_submission_arrival));
  signals.push(evaluate("provider_concentration", metrics.providerConcentration, SIGNAL_RULES.provider_concentration));
  return signals;
}

/** Just the alarms, worst severity first. */
export function alarmingSignals(metrics: SignalWindow): Signal[] {
  return evaluateSignals(metrics)
    .filter((s) => s.alarm)
    .sort((a, b) => a.severity - b.severity || a.name.localeCompare(b.name));
}

/** A metrics window with nothing wrong with it — the baseline a test perturbs. */
export function healthyWindow(): SignalWindow {
  return {
    firstPassRateByRole: {},
    inboxPlacement: 0.92,
    complaintRate: 0.0002,
    silentFailureCount: 0,
    previewRenderSuccess: 0.995,
    formSubmissionArrival: 1,
    providerConcentration: 0.4,
  };
}

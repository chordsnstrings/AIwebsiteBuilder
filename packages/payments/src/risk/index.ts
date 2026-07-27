// Payments risk monitoring (spec §14.2.10). Deterministic daily checks over a
// connected account's metrics. Thresholds come from config/thresholds.yaml
// (payments.*) so they are PR-gated and version-stamped, not hardcoded:
//   dispute rate  > 0.75% -> suspend + raise exception
//   volume spike  > 4x    -> hold
//   refund rate   > 20%   -> review
//   negative balance      -> immediate suspend
import { config } from "@adw/config";
import { emit } from "@adw/telemetry";
import type { Db } from "@adw/db";

/** Daily metrics for one connected account. Rates are fractions (0.0075 == 0.75%). */
export interface RiskMetrics {
  disputeRate: number;
  /** Current volume / trailing baseline volume, e.g. 4.5 means 4.5x. */
  volumeMultiple: number;
  refundRate: number;
  /** Account balance in integer cents; negative means a negative balance. */
  balanceCents: number;
}

export type RiskActionKind = "suspend" | "hold" | "review";

export interface RiskAction {
  action: RiskActionKind;
  /** Which check fired. */
  trigger: "dispute_rate" | "volume_spike" | "refund_rate" | "negative_balance";
  /** Whether this action opens an operator exception. */
  raiseException: boolean;
  detail: string;
}

/**
 * Evaluate the daily risk checks and return the actions to take. Pure and
 * deterministic — no I/O — so it is trivially testable and auditable. Multiple
 * actions may fire in one run; the caller applies the strongest.
 */
export function monitorRisk(metrics: RiskMetrics): RiskAction[] {
  const t = config.thresholds().data.payments;
  const actions: RiskAction[] = [];

  if (metrics.disputeRate > t.merchant_dispute_suspend) {
    actions.push({
      action: "suspend",
      trigger: "dispute_rate",
      raiseException: true,
      detail: `dispute rate ${(metrics.disputeRate * 100).toFixed(3)}% > ${(t.merchant_dispute_suspend * 100).toFixed(3)}%`,
    });
  }

  if (metrics.volumeMultiple > t.volume_spike_multiple) {
    actions.push({
      action: "hold",
      trigger: "volume_spike",
      raiseException: false,
      detail: `volume ${metrics.volumeMultiple.toFixed(2)}x > ${t.volume_spike_multiple}x`,
    });
  }

  if (metrics.refundRate > t.refund_rate_review) {
    actions.push({
      action: "review",
      trigger: "refund_rate",
      raiseException: false,
      detail: `refund rate ${(metrics.refundRate * 100).toFixed(2)}% > ${(t.refund_rate_review * 100).toFixed(2)}%`,
    });
  }

  if (metrics.balanceCents < 0) {
    actions.push({
      action: "suspend",
      trigger: "negative_balance",
      raiseException: true,
      detail: `negative balance ${metrics.balanceCents} cents`,
    });
  }

  return actions;
}

/** Rank actions by severity so the caller can apply the strongest state change. */
const SEVERITY: Record<RiskActionKind, number> = { suspend: 3, hold: 2, review: 1 };

const STATE_FOR: Record<RiskActionKind, string> = {
  suspend: "SUSPENDED",
  hold: "HELD",
  review: "REVIEW",
};

export interface RiskMonitorOutcome {
  actions: RiskAction[];
  /** The state merchant_accounts was moved to, if any action fired. */
  appliedState?: string;
}

/**
 * Run the daily check for a stored account and apply the strongest action to
 * merchant_accounts.state (this never touches tos_acceptance, so the guard
 * trigger stays quiet). Emits telemetry for each action.
 *
 * @param accountId merchant_accounts.id (UUID)
 */
export async function runRiskMonitoring(
  db: Db,
  accountId: string,
  metrics: RiskMetrics,
): Promise<RiskMonitorOutcome> {
  const actions = monitorRisk(metrics);
  if (actions.length === 0) return { actions };

  const strongest = actions.reduce((a, b) => (SEVERITY[b.action] > SEVERITY[a.action] ? b : a));
  const appliedState = STATE_FOR[strongest.action];
  await db.query("UPDATE merchant_accounts SET state = $2, updated_at = now() WHERE id = $1", [
    accountId,
    appliedState,
  ]);

  for (const action of actions) {
    await emit({
      eventType: "payments.risk.action",
      subject: { kind: "merchant_account", id: accountId },
      payload: { action: action.action, trigger: action.trigger, raiseException: action.raiseException },
    });
  }

  return { actions, appliedState };
}

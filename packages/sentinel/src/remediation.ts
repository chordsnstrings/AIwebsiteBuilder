// Sentinel remediation allowlist (spec §71.5). The Sentinel may only REDUCE
// risk, never increase it. Recovery always requires a human or a passing
// recovery check. This list is the hard boundary — anything not on it is
// forbidden, including resuming, raising caps, changing config, writing to
// suppression, changing a champion, and switching payment processors.
export const REMEDIATION_ALLOWLIST = [
  "failover_role_to_fallback",
  "retire_sending_asset",
  "throttle_sending_pool",
  "pause_campaign",
  "rollback_deploy",
  "halt_builds",
  "rotate_to_standby_key",
  "rerun_probe",
] as const;

export type RemediationAction = (typeof REMEDIATION_ALLOWLIST)[number];

// Explicitly forbidden — never on any allowlist. Used to assert the boundary.
export const FORBIDDEN_REMEDIATIONS = [
  "switch_payment_processors",
  "resume_halted",
  "raise_cap",
  "change_config",
  "write_suppression",
  "change_registry_champion",
  "send_to_customer",
] as const;

export function isPermitted(action: string): action is RemediationAction {
  return (REMEDIATION_ALLOWLIST as readonly string[]).includes(action);
}

/** Guard: throws if an action is not on the allowlist. */
export function assertPermitted(action: string): asserts action is RemediationAction {
  if (!isPermitted(action)) {
    throw new Error(`Remediation '${action}' is not permitted — the Sentinel may only reduce risk (spec §71.5).`);
  }
}

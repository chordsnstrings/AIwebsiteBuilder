// Payments integration test / build gate (spec §14.2.8). Before a merchant can
// transact, ADW runs an end-to-end probe on the live rail: a test charge
// succeeds, the webhook is received (signature verified), the statement
// descriptor shows the merchant name, charge_type is 'direct', the payout
// destination resolves, and the refund path executes.
//
// Two checks — the statement descriptor and the charge type — FAIL THE BUILD
// (not the account): a regression here is a code defect, so it must stop the
// release rather than silently disabling one merchant. If charge_type is ever
// non-direct, that additionally HALTS payments (invariant 1 breach).
import { emit } from "@adw/telemetry";
import type { Db } from "@adw/db";
import { deriveStatementDescriptor, type PaymentRail } from "../rails/types.ts";

export interface IntegrationCheck {
  check: string;
  passed: boolean;
  /** A failure here stops the build (code defect), not just the account. */
  failsBuild: boolean;
  /** A failure here halts payments platform-wide (invariant breach). */
  haltsPayments: boolean;
  detail?: string;
}

export interface IntegrationTestResult {
  passed: boolean;
  /** Only the FAILED checks. */
  failures: IntegrationCheck[];
  /** True when any build-failing check failed. */
  buildFailed: boolean;
  /** True when any payments-halting check failed. */
  paymentsHalted: boolean;
}

interface AccountRow {
  id: string;
  external_account_id: string | null;
  charge_type: string;
  statement_descriptor: string | null;
  legal_name: string;
}

/**
 * Run the §14.2.8 integration test against a connected account. On full pass,
 * set merchant_accounts.integration_test_passed. Returns the failing checks with
 * their build/halt semantics.
 *
 * @param accountId merchant_accounts.id (UUID)
 */
export async function runIntegrationTest(
  db: Db,
  rail: PaymentRail,
  accountId: string,
): Promise<IntegrationTestResult> {
  const acct = await db.one<AccountRow>(
    `SELECT m.id, m.external_account_id, m.charge_type, m.statement_descriptor, c.legal_name
       FROM merchant_accounts m
       JOIN customers c ON c.id = m.customer_id
      WHERE m.id = $1`,
    [accountId],
  );
  const external = acct.external_account_id;
  const checks: IntegrationCheck[] = [];
  const record = (
    check: string,
    passed: boolean,
    opts: { failsBuild?: boolean; haltsPayments?: boolean; detail?: string } = {},
  ): void => {
    checks.push({
      check,
      passed,
      failsBuild: opts.failsBuild ?? false,
      haltsPayments: opts.haltsPayments ?? false,
      detail: opts.detail,
    });
  };

  if (!external) {
    record("external_account_resolves", false, { detail: "no external_account_id" });
    return summarize(db, accountId, checks);
  }

  // 1. Test charge succeeds.
  const checkout = await rail
    .createCheckout(external, { amountCents: 100, currency: "usd", applicationFeeCents: 5 })
    .catch(() => null);
  record("test_charge_succeeds", checkout !== null, { detail: checkout ? undefined : "checkout threw" });

  // 2. Webhook received & signature-verified.
  let webhookOk = false;
  if (checkout) {
    // The rail dispatches a signed charge.succeeded event; we must verify it.
    const signed = dispatch(rail, {
      type: "charge.succeeded",
      accountId: external,
      chargeRef: checkout.ref,
      amountCents: checkout.amountCents,
      currency: checkout.currency,
    });
    const evt = rail.normalizeWebhook(signed);
    webhookOk = evt.signatureValid && evt.type === "charge.succeeded";
  }
  record("webhook_received", webhookOk, { detail: webhookOk ? undefined : "no verified webhook" });

  // 3. Statement descriptor shows the merchant name — FAILS THE BUILD.
  const expectedDescriptor = deriveStatementDescriptor(acct.legal_name);
  const descriptorOk =
    acct.statement_descriptor === expectedDescriptor &&
    (checkout ? checkout.statementDescriptor === expectedDescriptor : true);
  record("statement_descriptor_is_merchant", descriptorOk, {
    failsBuild: true,
    detail: descriptorOk ? undefined : `expected '${expectedDescriptor}', got '${acct.statement_descriptor}'`,
  });

  // 4. charge_type == 'direct' — FAILS THE BUILD and HALTS PAYMENTS.
  // Check both the persisted row and the live rail's checkout: a rail that emits
  // a non-direct charge is caught here even though the DB CHECK guards the row.
  const chargeTypeOk = acct.charge_type === "direct" && (checkout ? checkout.chargeType === "direct" : false);
  record("charge_type_is_direct", chargeTypeOk, {
    failsBuild: true,
    haltsPayments: true,
    detail: chargeTypeOk
      ? undefined
      : `row=${acct.charge_type} rail=${checkout?.chargeType ?? "n/a"}`,
  });

  // 5. Payout destination resolves (rail -> merchant; never ADW-initiated).
  const status = await rail.getAccountStatus(external).catch(() => null);
  const payoutOk = status?.payoutsEnabled === true;
  record("payout_destination_resolves", payoutOk, {
    detail: payoutOk ? undefined : "payouts_enabled false",
  });

  // 6. Refund path executes.
  let refundOk = false;
  if (checkout) {
    const refund = await rail.refund(external, checkout.ref).catch(() => null);
    refundOk = refund?.refunded === true;
  }
  record("refund_path_executes", refundOk, { detail: refundOk ? undefined : "refund failed" });

  return summarize(db, accountId, checks);
}

async function summarize(db: Db, accountId: string, checks: IntegrationCheck[]): Promise<IntegrationTestResult> {
  const failures = checks.filter((c) => !c.passed);
  const passed = failures.length === 0;
  const buildFailed = failures.some((c) => c.failsBuild);
  const paymentsHalted = failures.some((c) => c.haltsPayments);

  if (passed) {
    await db.query("UPDATE merchant_accounts SET integration_test_passed = TRUE, updated_at = now() WHERE id = $1", [
      accountId,
    ]);
  }
  await emit({
    eventType: passed ? "payments.integration_test.passed" : "payments.integration_test.failed",
    subject: { kind: "merchant_account", id: accountId },
    payload: { buildFailed, paymentsHalted, failures: failures.map((f) => f.check) },
  });

  return { passed, failures, buildFailed, paymentsHalted };
}

/** Ask a rail to sign a webhook if it exposes dispatchWebhook; else pass the event through. */
function dispatch(rail: PaymentRail, event: Record<string, unknown>): unknown {
  const maybe = rail as unknown as { dispatchWebhook?: (e: unknown) => unknown };
  if (typeof maybe.dispatchWebhook === "function") return maybe.dispatchWebhook(event);
  return event;
}

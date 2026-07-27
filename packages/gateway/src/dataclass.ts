// Data-class enforcement (spec §8.2). Every gateway call carries a data class;
// the gateway rejects a call whose class the resolved model is not permitted to
// see — checked here, never in agent code. PAY is never eligible for any model.
// The eligibility source is the vendor diligence registry; in demo mode we use
// a conservative static policy derived from it.
import type { DataClass, ModelRef } from "@adw/registry";

// Providers with a completed, evidenced diligence file on commercial terms with
// training excluded are eligible for CUST. In demo this is a static allowlist;
// in production it is read from the vendor diligence registry.
const CUST_ELIGIBLE_PROVIDERS = new Set(["anthropic", "modelark", "google"]);

export function dataClassEligible(model: ModelRef, dataClass: DataClass): { ok: boolean; reason?: string } {
  if (dataClass === "PAY") {
    return { ok: false, reason: "PAY data is never sent to any model" };
  }
  if (dataClass === "CUST") {
    const provider = model.split("/")[0] ?? "";
    if (!CUST_ELIGIBLE_PROVIDERS.has(provider)) {
      return { ok: false, reason: `provider ${provider} is not diligence-cleared for CUST` };
    }
  }
  // PUB and PUBLISHABLE: any vendor passing diligence.
  return { ok: true };
}

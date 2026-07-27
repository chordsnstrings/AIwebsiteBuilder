// ADW custom ESLint rules — spec-mandated structural invariants.
// Each rule is mirrored by a grep-based Vitest test elsewhere so the guarantee
// survives even if the eslint config drifts.
import noModelNames from "./rules/no-model-names.js";
import noTransportOutsideGate from "./rules/no-transport-outside-gate.js";
import noVendorSdkOutsideAdapters from "./rules/no-vendor-sdk-outside-adapters.js";
import tosAcceptanceSingleWriter from "./rules/tos-acceptance-single-writer.js";
import noPromptVendorIdioms from "./rules/no-prompt-vendor-idioms.js";

export default {
  rules: {
    "no-model-names": noModelNames,
    "no-transport-outside-gate": noTransportOutsideGate,
    "no-vendor-sdk-outside-adapters": noVendorSdkOutsideAdapters,
    "tos-acceptance-single-writer": tosAcceptanceSingleWriter,
    "no-prompt-vendor-idioms": noPromptVendorIdioms,
  },
};

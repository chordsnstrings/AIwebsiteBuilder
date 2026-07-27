import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import noModelNames from "./rules/no-model-names.js";
import noTransportOutsideGate from "./rules/no-transport-outside-gate.js";
import noVendorSdkOutsideAdapters from "./rules/no-vendor-sdk-outside-adapters.js";
import tosAcceptanceSingleWriter from "./rules/tos-acceptance-single-writer.js";
import noPromptVendorIdioms from "./rules/no-prompt-vendor-idioms.js";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run("no-model-names", noModelNames, {
  valid: [
    { code: `const x = "hello world";`, filename: "packages/agents/care/src/care.ts" },
    // allowlisted in registry seed
    { code: `const champ = "claude-opus-5";`, filename: "packages/registry/src/seed/roles.ts" },
    // not an agent/app file → not policed
    { code: `const champ = "gpt-5.6";`, filename: "packages/db/src/x.ts" },
  ],
  invalid: [
    {
      code: `const m = "claude-opus-5";`,
      filename: "packages/agents/care/src/care.ts",
      errors: [{ messageId: "modelName" }],
    },
    {
      code: `const m = "gemini-3";`,
      filename: "apps/api/src/x.ts",
      errors: [{ messageId: "modelName" }],
    },
  ],
});

ruleTester.run("no-transport-outside-gate", noTransportOutsideGate, {
  valid: [
    { code: `import nodemailer from "nodemailer";`, filename: "packages/gate/src/send/ses.ts" },
    { code: `import { x } from "./util";`, filename: "packages/agents/outreach/src/x.ts" },
  ],
  invalid: [
    {
      code: `import nodemailer from "nodemailer";`,
      filename: "packages/agents/outreach/src/x.ts",
      errors: [{ messageId: "transport" }],
    },
  ],
});

ruleTester.run("no-vendor-sdk-outside-adapters", noVendorSdkOutsideAdapters, {
  valid: [
    { code: `import Stripe from "stripe";`, filename: "packages/vendors/stripe/real.ts" },
    { code: `import Stripe from "stripe";`, filename: "packages/gateway/src/adapters/x.ts" },
  ],
  invalid: [
    {
      code: `import Stripe from "stripe";`,
      filename: "packages/billing/src/x.ts",
      errors: [{ messageId: "vendorSdk" }],
    },
  ],
});

ruleTester.run("tos-acceptance-single-writer", tosAcceptanceSingleWriter, {
  valid: [
    {
      code: `acct.tos_acceptance = { date, ip };`,
      filename: "packages/payments/src/onboarding/tos-webhook.ts",
    },
    { code: `const x = acct.tos_acceptance;`, filename: "packages/payments/src/x.ts" },
  ],
  invalid: [
    {
      code: `acct.tos_acceptance = { date, ip };`,
      filename: "packages/agents/payments/src/x.ts",
      errors: [{ messageId: "tos" }],
    },
    {
      code: `const p = { tos_acceptance: { date } };`,
      filename: "packages/payments/src/onboarding/prefill.ts",
      errors: [{ messageId: "tos" }],
    },
  ],
});

ruleTester.run("no-prompt-vendor-idioms", noPromptVendorIdioms, {
  valid: [
    { code: `const p = "Follow the output schema exactly.";`, filename: "packages/prompts/care.ts" },
    { code: `const p = "<thinking>ok</thinking>";`, filename: "packages/agents/care/src/x.ts" },
  ],
  invalid: [
    {
      code: `const p = "You are Claude, an assistant.";`,
      filename: "packages/prompts/care.ts",
      errors: [{ messageId: "idiom" }],
    },
  ],
});

// adw/no-vendor-sdk-outside-adapters — spec §4.2/§12.1: vendor SDKs may only
// live inside packages/vendors and packages/gateway/adapters. No agent or app
// imports a vendor SDK directly; all external I/O goes through an adapter.
const VENDOR_SDKS = [
  /^stripe$/,
  /^@aws-sdk\//,
  /^cloudflare$/,
  /^@anthropic-ai\//,
  /^@google\/generative-ai$/,
  /^openai$/,
  /^twilio$/,
  /^@langfuse\//,
];

const ALLOW = [
  /packages\/vendors\//,
  /packages\/gateway\/(src\/)?adapters/,
  /\.test\.ts$/,
  /\.spec\.ts$/,
];

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow vendor SDK imports outside adapter layers" },
    schema: [],
    messages: {
      vendorSdk:
        "Vendor SDK '{{name}}' may only be imported inside packages/vendors or packages/gateway/adapters (spec §4.2).",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (ALLOW.some((re) => re.test(filename))) return {};
    return {
      ImportDeclaration(node) {
        const src = node.source.value;
        if (typeof src === "string" && VENDOR_SDKS.some((re) => re.test(src))) {
          context.report({ node, messageId: "vendorSdk", data: { name: src } });
        }
      },
    };
  },
};

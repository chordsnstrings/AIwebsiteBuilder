// adw/tos-acceptance-single-writer — spec §14.2.5 INVARIANT: tos_acceptance is
// writable only by the acceptance webhook handler. Any assignment to a property
// named tos_acceptance / tosAcceptance outside that one file is an error.
const ALLOW = [
  /packages\/payments\/(src\/)?onboarding\/tos-webhook\.ts$/,
  /\.test\.ts$/,
  /\.spec\.ts$/,
];

function isTosKey(name) {
  return name === "tos_acceptance" || name === "tosAcceptance";
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: { description: "tos_acceptance may only be written by the acceptance webhook handler" },
    schema: [],
    messages: {
      tos:
        "Writing 'tos_acceptance' is only permitted in packages/payments/src/onboarding/tos-webhook.ts (spec §14.2.5 invariant).",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (ALLOW.some((re) => re.test(filename))) return {};

    function keyName(key) {
      if (!key) return undefined;
      if (key.type === "Identifier") return key.name;
      if (key.type === "Literal") return String(key.value);
      return undefined;
    }

    return {
      // obj.tos_acceptance = ...
      AssignmentExpression(node) {
        const left = node.left;
        if (left.type === "MemberExpression" && isTosKey(keyName(left.property))) {
          context.report({ node, messageId: "tos" });
        }
      },
      // { tos_acceptance: ... } in an object literal
      Property(node) {
        if (isTosKey(keyName(node.key))) {
          context.report({ node, messageId: "tos" });
        }
      },
    };
  },
};

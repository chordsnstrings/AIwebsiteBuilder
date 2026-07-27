// adw/no-transport-outside-gate — spec §10.1: "every outbound path calls gate().
// There is no second path." Transport libraries (SMTP/SES/etc.) may only be
// imported from the single post-gate send layer in packages/gate/src/send.
const TRANSPORT_IMPORTS = [
  /^nodemailer$/,
  /^@aws-sdk\/client-ses$/,
  /^smtp/,
  /@adw\/vendors\/(ses|workspace|m365|smtp)/,
];

const ALLOW = [/packages\/gate\/(src\/)?send\//, /\.test\.ts$/, /\.spec\.ts$/];

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow transport imports outside the gate send layer" },
    schema: [],
    messages: {
      transport:
        "Transport import '{{name}}' is only allowed inside packages/gate/src/send. Every send must pass through gate() (spec §10.1).",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (ALLOW.some((re) => re.test(filename))) return {};
    return {
      ImportDeclaration(node) {
        const src = node.source.value;
        if (typeof src === "string" && TRANSPORT_IMPORTS.some((re) => re.test(src))) {
          context.report({ node, messageId: "transport", data: { name: src } });
        }
      },
    };
  },
};

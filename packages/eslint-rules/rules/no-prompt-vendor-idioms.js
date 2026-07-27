// adw/no-prompt-vendor-idioms — spec §10.3/§11.7: prompts must be model-neutral.
// No vendor-specific formatting idioms (provider XML tag conventions,
// function-calling syntaxes, model-family self-identification).
const IDIOMS = [
  /<thinking>/i,
  /<function_calls>/i,
  /\bfunction_call\b/,
  /\btool_calls?\b/,
  /"role"\s*:\s*"system"/,
  /You are (Claude|GPT|Gemini|ChatGPT)/i,
  /<\|im_start\|>/,
];

const ONLY = [/packages\/prompts\//];
const ALLOW = [/\.test\.ts$/, /\.spec\.ts$/];

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow vendor-specific idioms in prompts" },
    schema: [],
    messages: {
      idiom:
        "Vendor-specific idiom '{{name}}' in a prompt. Prompts must be model-neutral (spec §10.3).",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!ONLY.some((re) => re.test(filename))) return {};
    if (ALLOW.some((re) => re.test(filename))) return {};

    function check(node, value) {
      if (typeof value !== "string") return;
      for (const re of IDIOMS) {
        const m = value.match(re);
        if (m) {
          context.report({ node, messageId: "idiom", data: { name: m[0] } });
          return;
        }
      }
    }
    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value?.cooked);
      },
    };
  },
};

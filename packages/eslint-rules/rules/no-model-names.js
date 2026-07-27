// adw/no-model-names — spec §3.3: "A lint rule fails the build if a model
// identifier appears anywhere in packages/agents". Roles resolve via the
// registry at call time; no model name may be hardcoded in agent/workflow code.
const MODEL_PATTERNS = [
  /\bclaude-[a-z0-9.-]+/i,
  /\bgpt-[0-9]/i,
  /\bgemini[- ]?[0-9]/i,
  /\bseed-[0-9]/i,
  /\bdeepseek[- ]?v?[0-9]/i,
  /\bglm-[0-9]/i,
  /\b(opus|sonnet|haiku)[- ]?[0-9]/i,
  /\bseedream\b/i,
  /\bgpt-oss\b/i,
];

// Paths where model names are legitimately allowed (registry seed data, config).
const ALLOW = [
  /packages\/registry\/(src\/)?seed/,
  /packages\/gateway\/(src\/)?adapters/,
  /config\/registry/,
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /fixtures?\//,
];

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow hardcoded model identifiers outside the registry" },
    schema: [],
    messages: {
      modelName:
        "Hardcoded model identifier '{{name}}' found. Roles must resolve their model through the registry at call time (spec §3.3).",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (ALLOW.some((re) => re.test(filename))) return {};
    // Only police agent/workflow/app source.
    if (!/packages\/(agents|workflows)\/|apps\//.test(filename)) return {};

    function check(node, value) {
      if (typeof value !== "string") return;
      for (const re of MODEL_PATTERNS) {
        const m = value.match(re);
        if (m) {
          context.report({ node, messageId: "modelName", data: { name: m[0] } });
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

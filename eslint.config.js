import adw from "./packages/eslint-rules/index.js";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/.pg/**",
      "**/*.d.ts",
      "packages/eslint-rules/**",
      "**/coverage/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    plugins: { adw },
    rules: {
      "adw/no-model-names": "error",
      "adw/no-transport-outside-gate": "error",
      "adw/no-vendor-sdk-outside-adapters": "error",
      "adw/tos-acceptance-single-writer": "error",
      "adw/no-prompt-vendor-idioms": "error",
    },
  },
];

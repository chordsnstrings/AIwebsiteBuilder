import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { prompts, UNTRUSTED_NOTICE } from "./src/index.ts";

describe("prompts", () => {
  it("every prompt has the five-block structure and no model name", () => {
    for (const [id, p] of Object.entries(prompts)) {
      const { system } = p.build({ facts: {}, outputShape: "{ ok: boolean }" });
      expect(system, `${id} missing block 1`).toContain("[1 ROLE AND OBJECTIVE]");
      expect(system, `${id} missing untrusted notice`).toContain(UNTRUSTED_NOTICE);
      expect(system).not.toMatch(/claude-|gpt-5|gemini-3|seed-2|glm-5|opus-5|sonnet-5/i);
    }
  });
});

describe("hardcoded-model grep (mirrors adw/no-model-names lint rule)", () => {
  it("no model identifier appears in packages/agents or packages/workflows source", () => {
    // Grep the agents+workflows source dirs (they may not exist yet — that's fine).
    let out = "";
    try {
      out = execSync(
        `grep -rEl "claude-[a-z0-9]|gpt-5|gemini-3|seed-2-|deepseek-v|glm-5|opus-5|sonnet-5" ` +
          `packages/agents/src packages/workflows/src 2>/dev/null || true`,
        { cwd: process.cwd().replace(/packages\/prompts$/, ""), encoding: "utf8" },
      );
    } catch {
      out = "";
    }
    expect(out.trim()).toBe("");
  });
});

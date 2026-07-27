// Resolve a model ref to a live rail. Each rail is constructed only when its
// vendor credential exists in the vault; otherwise the mock rail is returned.
// This is where "keyless demo runs on mocks, real keys go live" is decided for
// the model layer.
import type { SecretsBackend } from "@adw/vault";
import type { LlmRail } from "./index.ts";
import { MockLlmRail } from "./mock.ts";
import { OpenAiShapeRail } from "./adapters/openai-shape.ts";
import { GoogleRail } from "./adapters/google.ts";
import { AnthropicRail } from "./adapters/anthropic.ts";

const mock = new MockLlmRail();

export interface ResolveRailDeps {
  vault: SecretsBackend;
  forceMock?: boolean;
}

/** provider prefix of a ModelRef, e.g. "modelark/seed-2-0-pro" → "modelark". */
export function railKind(model: string): "modelark" | "google" | "anthropic" {
  const provider = model.split("/")[0];
  if (provider === "google") return "google";
  if (provider === "anthropic") return "anthropic";
  return "modelark";
}

const VENDOR_KEY: Record<string, { vendorId: string; keyName: string }> = {
  modelark: { vendorId: "modelark", keyName: "api_key" },
  google: { vendorId: "google_ai", keyName: "api_key" },
  anthropic: { vendorId: "anthropic", keyName: "api_key" },
};

export async function resolveRail(model: string, deps: ResolveRailDeps): Promise<LlmRail> {
  if (deps.forceMock) return mock;
  const kind = railKind(model);
  const { vendorId, keyName } = VENDOR_KEY[kind]!;
  if (!(await deps.vault.has(vendorId, keyName))) return mock;
  const key = await deps.vault.resolve(`cred:${vendorId}:${keyName}@v${await latestVersion(deps.vault, vendorId, keyName)}`);
  switch (kind) {
    case "modelark":
      return new OpenAiShapeRail({
        baseUrl: process.env.MODELARK_BASE_URL ?? "https://ark.ap-southeast.bytepluses.com/api/v3",
        apiKey: key,
      });
    case "google":
      return new GoogleRail({ apiKey: key });
    case "anthropic":
      return new AnthropicRail({ apiKey: key });
  }
}

async function latestVersion(vault: SecretsBackend, vendorId: string, keyName: string): Promise<number> {
  const list = await vault.list(vendorId);
  const match = list.find((c) => c.keyName === keyName);
  return match?.version ?? 1;
}

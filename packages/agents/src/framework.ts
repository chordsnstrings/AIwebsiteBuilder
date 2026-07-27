// Agent framework (spec §16). An agent is a typed activity with a resolved role,
// a budget, a declared capability set and an escalation path. Capabilities like
// write:config, write:suppression, write:registry, charge:money and
// write:tos_acceptance DO NOT EXIST in this union — they are structurally
// unexpressible, not merely unused.
import type { Db } from "@adw/db";
import type { SecretsBackend } from "@adw/vault";
import { complete, type DataClass, type GatewayDeps, type RoleId } from "@adw/gateway";
import type { z } from "zod";

export type Capability =
  | "read:business"
  | "read:contact"
  | "read:conversation"
  | "read:customer"
  | "read:metrics"
  | "read:vendor_registry"
  | "write:draft"
  | "write:exception"
  | "write:vendor_state"
  | "send:gated"
  | "deploy:preview"
  | "deploy:site"
  | "propose:price"
  | "provision:scoped"
  | "trigger:remediation";
// Deliberately absent: write:config, write:suppression, write:registry,
// charge:money, write:tos_acceptance, create:account, sign:contract,
// mint:credential.

export interface AgentEnvelope<T> {
  result: T;
  confidence: number;
  injectionSuspected: boolean;
  escalate: boolean;
  escalateReason?: string;
  model: string;
  costCents: number;
  firstPass: boolean;
  notes?: string;
}

export interface AgentDeps extends GatewayDeps {
  db: Db;
  vault: SecretsBackend;
}

export interface AgentDefinition<S extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  id: string;
  role: RoleId;
  dataClass: DataClass;
  capabilities: Capability[];
  inputSchema: S;
  outputSchema: O;
  maxTokensOut: number;
  budgetUsdPerPassingOutput: number;
  /** Build the model-neutral prompt from the input. */
  buildPrompt: (input: z.infer<S>) => { system: string; user: string };
  /** Deterministic demo behaviour — the structured output for a given input. */
  simulate: (input: z.infer<S>) => z.infer<O>;
  /** Deterministic post-processing (clamps, parking) applied AFTER the model. */
  postProcess?: (out: z.infer<O>, input: z.infer<S>) => z.infer<O>;
  /** Human-escalation triggers detected from input/output. */
  detectEscalation?: (out: z.infer<O>, input: z.infer<S>) => string | undefined;
}

export interface Agent<S extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  readonly id: string;
  readonly role: RoleId;
  readonly capabilities: readonly Capability[];
  can(cap: Capability): boolean;
  run(
    input: z.input<S>,
    deps: AgentDeps,
    ctx?: { subjectId?: string; traceId?: string },
  ): Promise<AgentEnvelope<z.infer<O>>>;
}

export function defineAgent<S extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  def: AgentDefinition<S, O>,
): Agent<S, O> {
  type Out = z.infer<O>;
  const caps = new Set(def.capabilities);
  return {
    id: def.id,
    role: def.role,
    capabilities: def.capabilities,
    can: (cap) => caps.has(cap),
    async run(input, deps, ctx) {
      const parsedIn = def.inputSchema.parse(input) as z.infer<S>;
      const { system, user } = def.buildPrompt(parsedIn);
      const res = await complete<Out>(
        {
          role: def.role,
          dataClass: def.dataClass,
          system,
          user,
          schema: def.outputSchema as z.ZodType<Out>,
          maxTokensOut: def.maxTokensOut,
          budgetUsdPerPassingOutput: def.budgetUsdPerPassingOutput,
          simulate: () => def.simulate(parsedIn),
          subjectId: ctx?.subjectId,
          traceId: ctx?.traceId,
        },
        deps,
      );
      // Deterministic post-processing — clamps and parking are code, never
      // instructed in the prompt (spec §10.4, §13.8).
      const finalResult = def.postProcess ? def.postProcess(res.result, parsedIn) : res.result;
      const escalateReason = def.detectEscalation?.(finalResult, parsedIn);
      return {
        result: finalResult,
        confidence: 0.9,
        injectionSuspected: detectInjectionFlag(finalResult),
        escalate: escalateReason !== undefined,
        escalateReason,
        model: res.model,
        costCents: res.costCents,
        firstPass: res.firstPass,
      };
    },
  };
}

function detectInjectionFlag(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "injectionSuspected" in result &&
    (result as { injectionSuspected?: boolean }).injectionSuspected === true
  );
}

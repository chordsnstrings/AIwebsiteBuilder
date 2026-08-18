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
  /**
   * The contract, readable at runtime.
   *
   * ⛔ These were declared in `AgentDefinition` and then sealed inside the
   * closure, so nothing could enumerate what an agent is allowed to do, what it
   * costs, or what class of data it may see. An operator console cannot offer
   * control over an agent whose terms it cannot read, and a capability list
   * nobody can inspect is a comment.
   */
  readonly dataClass: DataClass;
  readonly maxTokensOut: number;
  readonly budgetUsdPerPassingOutput: number;
  /** Whether deterministic post-processing runs after the model returns. */
  readonly hasClamp: boolean;
  /** Whether this agent can raise a human escalation from its own output. */
  readonly hasEscalation: boolean;
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
    dataClass: def.dataClass,
    maxTokensOut: def.maxTokensOut,
    budgetUsdPerPassingOutput: def.budgetUsdPerPassingOutput,
    hasClamp: def.postProcess !== undefined,
    hasEscalation: def.detectEscalation !== undefined,
    can: (cap) => caps.has(cap),
    async run(input, deps, ctx) {
      const startedAt = Date.now();
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
      const envelope: AgentEnvelope<Out> = {
        result: finalResult,
        confidence: 0.9,
        injectionSuspected: detectInjectionFlag(finalResult),
        escalate: escalateReason !== undefined,
        ...(escalateReason === undefined ? {} : { escalateReason }),
        model: res.model,
        costCents: res.costCents,
        firstPass: res.firstPass,
      };

      // ⛔ Recorded HERE, in the factory, and not left to the caller.
      //
      // Every one of the five fields above used to be computed and thrown away:
      // ten call sites take this envelope and not one wrote it down. So every
      // prompt-injection detection the system made vanished into a local
      // variable, first-pass rate — a stated success monitor — could not be
      // computed per agent, and "which agent escalates, and why" was
      // unanswerable.
      //
      // Putting the write in `defineAgent` rather than in the callers is the
      // whole point: a new agent gets the audit trail by existing, and no
      // future call site can forget it.
      await record(deps.db, def, envelope, ctx, Date.now() - startedAt);
      return envelope;
    },
  };
}

/**
 * Write the invocation record.
 *
 * ⛔ A failed audit write must not fail the agent — observability that can take
 * down the thing it observes is worse than none. But it must not be silent
 * either, and an INJECTION-SUSPECTED invocation that failed to record is a
 * security event being lost, so that case additionally tries to raise an
 * exception a human will see. If even that fails there is nothing left to do
 * but log, and the alternative — throwing — would let an attacker suppress
 * their own detection by arranging for the insert to fail.
 */
async function record<S extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  db: Db,
  def: AgentDefinition<S, O>,
  envelope: AgentEnvelope<z.infer<O>>,
  ctx: { subjectId?: string; traceId?: string } | undefined,
  durationMs: number,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO agent_invocations
         (agent_id, role, model, data_class, subject_id, trace_id, cost_cents,
          first_pass, confidence, injection_suspected, escalated, escalate_reason, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        def.id,
        def.role,
        envelope.model,
        def.dataClass,
        ctx?.subjectId ?? null,
        ctx?.traceId ?? null,
        // ⛔ NOT rounded. A model call costs a fraction of a cent, so
        // Math.round() wrote 0 for every one of the first 1,587 rows and
        // the ledger reported that the fleet had cost nothing.
        Math.max(0, envelope.costCents),
        envelope.firstPass,
        envelope.confidence,
        envelope.injectionSuspected,
        envelope.escalate,
        envelope.escalateReason ?? null,
        Math.max(0, Math.round(durationMs)),
      ],
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[agents] could not record invocation of ${def.id}: ${detail}`);
    if (envelope.injectionSuspected) {
      await db
        .query(
          `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
           VALUES ('agent_audit_write_failed', 1, $1, 'the agent ran and its result was used',
                   'An injection-suspected invocation could not be recorded. Check agent_invocations and the database before trusting any injection count.')`,
          [JSON.stringify({ agentId: def.id, role: def.role, detail })],
        )
        .catch(() => undefined);
    }
  }
}

function detectInjectionFlag(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "injectionSuspected" in result &&
    (result as { injectionSuspected?: boolean }).injectionSuspected === true
  );
}

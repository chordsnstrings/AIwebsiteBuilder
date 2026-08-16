// The in-house LLM gateway (spec §12). Registry-resolved model routing,
// data-class enforcement, per-role budgets in cost-per-passing-output, retry and
// escalation, cost attribution per role per candidate, and shadow traffic. No
// agent imports a vendor SDK — all model I/O flows through here.
import type { Db } from "@adw/db";
import type { SecretsBackend } from "@adw/vault";
import { resolveRail, priceFor, type LlmRail } from "@adw/vendors";
import { resolveRole, type DataClass, type ModelRef, type RoleId } from "@adw/registry";
import { emit } from "@adw/telemetry";
import { agentHalted, readEngagedSwitches } from "@adw/gate";
import type { z } from "zod";
import { dataClassEligible } from "./dataclass.ts";
import { BudgetExceededError, roleSpendTodayUsd } from "./budget.ts";

export interface GatewayDeps {
  db: Db;
  vault: SecretsBackend;
  forceMock?: boolean;
  sampleShadow?: () => boolean; // injectable for determinism; default: never
}

export interface GatewayRequest<Out> {
  role: RoleId;
  dataClass: DataClass;
  system: string;
  user: string;
  schema: z.ZodType<Out>;
  maxTokensOut: number;
  budgetUsdPerPassingOutput: number;
  /** Deterministic demo behaviour — returns the structured output for a model. */
  simulate?: (model: ModelRef) => Out;
  /** Explicit failure injection for a given model (tests). */
  failFor?: (model: ModelRef) => "parse" | "timeout" | "refuse" | undefined;
  workflowId?: string;
  subjectId?: string;
  traceId?: string;
}

export interface GatewayResult<Out> {
  result: Out;
  model: ModelRef;
  costCents: number;
  escalationDepth: number;
  firstPass: boolean;
  roleChain: string[];
}

export class GatewayError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "GatewayError";
  }
}

export async function complete<Out>(
  req: GatewayRequest<Out>,
  deps: GatewayDeps,
): Promise<GatewayResult<Out>> {
  const { db } = deps;

  // ⛔ HALT_AGENT:<role> — runbook R5, quarantine one role for 24 hours after a
  // canary fires. Checked here rather than at each of the twenty-eight call
  // sites, because a switch that only halts the roles somebody remembered to
  // wire is a switch nobody can rely on during an incident.
  //
  // Ahead of the budget check on purpose: a quarantined role must not spend
  // another penny, and it must not be the budget that reports why it stopped.
  if (agentHalted(await readEngagedSwitches(db), req.role)) {
    throw new GatewayError(`role ${req.role} is halted by HALT_AGENT:${req.role}`, "ROLE_HALTED");
  }

  // Budget check (per-role daily). A breach halts, never escalates.
  const spent = await roleSpendTodayUsd(db, req.role);
  const perRoleDaily = req.budgetUsdPerPassingOutput * 5000; // generous daily headroom
  if (spent >= perRoleDaily) {
    await raiseException(db, "budget_overrun", req.role, `role ${req.role} exceeded daily budget`);
    throw new BudgetExceededError(req.role, spent);
  }

  const resolution = await resolveRole(db, req.role);

  // Data-class enforcement, applied to every candidate we might use.
  const chain: ModelRef[] = [resolution.champion, ...resolution.escalation];
  for (const model of chain) {
    const elig = dataClassEligible(model, req.dataClass);
    if (!elig.ok) {
      throw new GatewayError(`data-class violation: ${elig.reason}`, "DATA_CLASS_REJECTED");
    }
  }

  const roleChain: string[] = [];
  let escalationDepth = 0;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!;
    const label = i === 0 ? `${req.role}:champion` : `${req.role}:escalation${i - 1}`;
    roleChain.push(label);
    const rail: LlmRail = await resolveRail(model, { vault: deps.vault, forceMock: deps.forceMock });
    const failMode = req.failFor?.(model);

    try {
      const resp = await rail.complete({
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        maxTokensOut: req.maxTokensOut,
        seed: req.subjectId,
        simulate: req.simulate ? () => req.simulate!(model) : undefined,
        failMode,
      });

      const parsed = parseAndValidate(resp.text, req.schema);
      if (!parsed.ok) {
        // Parse/validation failure counts against this candidate's first-pass
        // rate and is a routing signal — escalate to the next model.
        escalationDepth = i + 1;
        await recordAttribution(db, req, model, resp.tokensIn, resp.tokensOut, false, i === 0);
        continue;
      }

      const costCents = priceFor(model, resp.tokensIn, resp.tokensOut);
      await recordAttribution(db, req, model, resp.tokensIn, resp.tokensOut, true, i === 0, costCents);
      if (i > 0) {
        // A fallback executed successfully — mark liveness.
        await db.query("UPDATE registry_roles SET fallback_last_ok = now() WHERE role = $1", [req.role]);
      }
      return {
        result: parsed.value,
        model,
        costCents,
        escalationDepth: i,
        firstPass: i === 0,
        roleChain,
      };
    } catch (err) {
      // Timeout / transport failure — escalate.
      escalationDepth = i + 1;
      await emit({
        eventType: "gateway.error",
        actor: { kind: "system", id: req.role },
        payload: { model, error: err instanceof Error ? err.message : String(err) },
      });
      continue;
    }
  }

  await raiseException(db, "escalation_rate_breach", req.role, `all candidates failed for role ${req.role}`);
  throw new GatewayError(`all candidates exhausted for role ${req.role}`, "ESCALATION_EXHAUSTED");
}

function parseAndValidate<Out>(text: string, schema: z.ZodType<Out>): { ok: true; value: Out } | { ok: false } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const res = schema.safeParse(json);
  return res.success ? { ok: true, value: res.data } : { ok: false };
}

async function recordAttribution<Out>(
  db: Db,
  req: GatewayRequest<Out>,
  model: ModelRef,
  tokensIn: number,
  tokensOut: number,
  passed: boolean,
  isChampion: boolean,
  costCents?: number,
): Promise<void> {
  const cost = costCents ?? priceFor(model, tokensIn, tokensOut);
  await emit({
    eventType: passed ? "gateway.completed" : "gateway.parse_failure",
    actor: { kind: "agent", id: req.role },
    subject: req.subjectId ? { kind: "subject", id: req.subjectId } : undefined,
    model,
    costCents: cost,
    traceId: req.traceId,
    payload: { tokensIn, tokensOut, passed, isChampion, dataClass: req.dataClass },
  });
}

async function raiseException(db: Db, trigger: string, role: RoleId, context: string): Promise<void> {
  await db.query(
    `INSERT INTO exceptions (trigger, severity, context, system_action)
     VALUES ($1, 2, $2, 'halted role')`,
    [trigger, JSON.stringify({ role, context })],
  );
}

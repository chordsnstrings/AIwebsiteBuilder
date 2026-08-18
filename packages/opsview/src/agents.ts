// ADW's own agents — the roster that runs the business.
//
// ⛔ Distinct from the DEPLOYED agent, which is the one that ships with a
// customer's site and answers their enquiries. Conflating the two is the reason
// the console had neither: "agent" meant a model role on the Models screen and
// a chat widget in the product, and no screen served either meaning properly.
//
// This file answers, per agent: what it is allowed to do, what it costs, how
// often it works first time, how often it escalates, and how often it has seen
// something that looked like a prompt injection.

import type { Db } from "@adw/db";
import { allAgents } from "@adw/agents";

/** The contract, read from code. Config, not a table — agents are defined in TypeScript. */
export interface AgentContractRow {
  id: string;
  role: string;
  dataClass: string;
  capabilities: string[];
  maxTokensOut: number;
  budgetUsdPerPassingOutput: number;
  /** Deterministic post-processing after the model returns. */
  hasClamp: boolean;
  /** Can raise a human escalation from its own output. */
  hasEscalation: boolean;
}

export function agentContracts(): AgentContractRow[] {
  return Object.values(allAgents)
    .map((a) => ({
      id: a.id,
      role: a.role as string,
      dataClass: a.dataClass as string,
      capabilities: [...a.capabilities] as string[],
      maxTokensOut: a.maxTokensOut,
      budgetUsdPerPassingOutput: a.budgetUsdPerPassingOutput,
      hasClamp: a.hasClamp,
      hasEscalation: a.hasEscalation,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface AgentActivity {
  agentId: string;
  invocations: number;
  /** ⛔ Null when there are no invocations. A first-pass rate over zero runs is
   *  not 100%, it is unmeasured, and 100% is the most misleading possible
   *  rendering of "this agent has never run". */
  firstPassRate: number | null;
  escalations: number;
  injectionSuspected: number;
  costCents: number;
  medianDurationMs: number | null;
  lastRunAt: Date | null;
  models: string[];
}

export interface AgentRow extends AgentContractRow {
  activity: AgentActivity;
  /** True when HALT_AGENT:<role> is engaged. */
  halted: boolean;
}

export interface AgentBoard {
  agents: AgentRow[];
  /** ⛔ The denominator for every rate on the screen. */
  windowDays: number;
  totalInvocations: number;
  /** Agents defined in code that have never been invoked at all. */
  neverInvoked: number;
  asOf: Date;
}

interface ActivityDbRow {
  agent_id: string;
  invocations: string;
  first_passes: string;
  escalations: string;
  injections: string;
  cost_cents: string;
  median_duration_ms: string | null;
  last_run_at: Date | null;
  models: string[];
}

export async function agentBoard(
  db: Db,
  now: Date,
  engagedSwitches: ReadonlySet<string>,
  windowDays = 30,
): Promise<AgentBoard> {
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  let activity = new Map<string, ActivityDbRow>();
  try {
    const rows = await db.query<ActivityDbRow>(
      `SELECT agent_id,
              count(*)                                        AS invocations,
              count(*) FILTER (WHERE first_pass)              AS first_passes,
              count(*) FILTER (WHERE escalated)               AS escalations,
              count(*) FILTER (WHERE injection_suspected)     AS injections,
              COALESCE(sum(cost_cents), 0)                    AS cost_cents,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS median_duration_ms,
              max(created_at)                                 AS last_run_at,
              array_agg(DISTINCT model)                       AS models
         FROM agent_invocations
        WHERE created_at >= $1
        GROUP BY agent_id`,
      [since],
    );
    activity = new Map(rows.rows.map((r) => [r.agent_id, r]));
  } catch {
    // Degrades to "no activity recorded" rather than blanking the roster: the
    // contracts come from code and are worth showing on their own.
  }

  const contracts = agentContracts();
  let total = 0;
  let neverInvoked = 0;

  const agents: AgentRow[] = contracts.map((c) => {
    const a = activity.get(c.id);
    const invocations = a === undefined ? 0 : Number(a.invocations);
    total += invocations;
    if (invocations === 0) neverInvoked++;
    return {
      ...c,
      // ⛔ Exact match, never a prefix. `HALT_AGENT:developer` must not read as
      // halting `developer_review` — the gate is exact-match and this display
      // has to agree with it or the console lies about what is stopped.
      halted: engagedSwitches.has(`HALT_AGENT:${c.role}`),
      activity: {
        agentId: c.id,
        invocations,
        firstPassRate: a === undefined || invocations === 0 ? null : Number(a.first_passes) / invocations,
        escalations: a === undefined ? 0 : Number(a.escalations),
        injectionSuspected: a === undefined ? 0 : Number(a.injections),
        costCents: a === undefined ? 0 : Number(a.cost_cents),
        medianDurationMs:
          a === undefined || a.median_duration_ms === null ? null : Math.round(Number(a.median_duration_ms)),
        lastRunAt: a?.last_run_at === null || a?.last_run_at === undefined ? null : new Date(a.last_run_at),
        models: a?.models?.filter((m) => m !== null) ?? [],
      },
    };
  });

  return { agents, windowDays, totalInvocations: total, neverInvoked, asOf: now };
}

export interface Invocation {
  id: string;
  agentId: string;
  role: string;
  model: string;
  dataClass: string;
  subjectId: string | null;
  traceId: string | null;
  costCents: number;
  firstPass: boolean;
  confidence: number | null;
  injectionSuspected: boolean;
  escalated: boolean;
  escalateReason: string | null;
  durationMs: number | null;
  createdAt: Date;
}

export interface InvocationFilter {
  agentId?: string | undefined;
  /** Only invocations that flagged a suspected prompt injection. */
  injectionOnly?: boolean | undefined;
  /** Only invocations that escalated to a human. */
  escalatedOnly?: boolean | undefined;
  /** Only invocations where the champion did not produce a valid output first try. */
  retriedOnly?: boolean | undefined;
  limit?: number | undefined;
}

/** The granular record: one row per agent run, newest first. */
export async function invocations(db: Db, filter: InvocationFilter = {}): Promise<Invocation[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.agentId !== undefined) {
    params.push(filter.agentId);
    where.push(`agent_id = $${params.length}`);
  }
  if (filter.injectionOnly === true) where.push("injection_suspected = true");
  if (filter.escalatedOnly === true) where.push("escalated = true");
  if (filter.retriedOnly === true) where.push("first_pass = false");
  params.push(Math.min(500, Math.max(1, filter.limit ?? 100)));

  const rows = await db.query<{
    id: string; agent_id: string; role: string; model: string; data_class: string;
    subject_id: string | null; trace_id: string | null; cost_cents: number;
    first_pass: boolean; confidence: string | null; injection_suspected: boolean;
    escalated: boolean; escalate_reason: string | null; duration_ms: number | null; created_at: Date;
  }>(
    `SELECT id, agent_id, role, model, data_class, subject_id, trace_id, cost_cents,
            first_pass, confidence, injection_suspected, escalated, escalate_reason,
            duration_ms, created_at
       FROM agent_invocations
       ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    role: r.role,
    model: r.model,
    dataClass: r.data_class,
    subjectId: r.subject_id,
    traceId: r.trace_id,
    costCents: r.cost_cents,
    firstPass: r.first_pass,
    confidence: r.confidence === null ? null : Number(r.confidence),
    injectionSuspected: r.injection_suspected,
    escalated: r.escalated,
    escalateReason: r.escalate_reason,
    durationMs: r.duration_ms,
    createdAt: new Date(r.created_at),
  }));
}

// ── The deployed agent, per customer ──────────────────────────────────────

export interface DeployedAgentRow {
  customerId: string;
  legalName: string;
  domain: string | null;
  vertical: string | null;
  /**
   * ⛔ Whether this customer's agent can actually answer. Not "is there a row",
   * but the whole precondition chain: a knowledge base, an APPROVED pack, and a
   * resolved vertical. A customer paying for an agent that silently answers
   * nothing is the worst failure this product has, and it was invisible.
   */
  live: boolean;
  blockedBy: string[];
  packApproved: boolean;
  packVersion: number | null;
  pairCount: number;
  openGaps: number;
  sessions: number;
  turns: number;
  /** Turns answered from the pack rather than escalated or unanswered. */
  answeredFromPack: number;
  /** ⛔ Null when there were no turns — not 100%. */
  deflectionRate: number | null;
  escalations: number;
  unacknowledgedIncidents: number;
  lastSessionAt: Date | null;
  medianLatencyMs: number | null;
}

export interface DeployedBoard {
  rows: DeployedAgentRow[];
  totalCustomers: number;
  liveCount: number;
  asOf: Date;
}

export async function deployedAgents(db: Db, now: Date, limit = 200): Promise<DeployedBoard> {
  const rows = await db.query<{
    customer_id: string; legal_name: string; domain: string | null; vertical: string | null;
    pack_approved: boolean | null; pack_version: number | null; pair_count: number | null;
    kb_id: string | null; open_gaps: string; sessions: string; turns: string;
    answered_from_pack: string; escalations: string; incidents: string;
    last_session_at: Date | null; median_latency_ms: string | null;
  }>(
    `SELECT c.id AS customer_id, c.legal_name, c.domain,
            COALESCE(c.vertical, b.vertical) AS vertical,
            p.approved_at IS NOT NULL AS pack_approved,
            p.version AS pack_version,
            p.pair_count,
            kb.id AS kb_id,
            COALESCE(g.open_gaps, 0)          AS open_gaps,
            COALESCE(s.sessions, 0)           AS sessions,
            COALESCE(s.turns, 0)              AS turns,
            COALESCE(s.answered_from_pack, 0) AS answered_from_pack,
            COALESCE(s.escalations, 0)        AS escalations,
            COALESCE(i.incidents, 0)          AS incidents,
            s.last_session_at,
            s.median_latency_ms
       FROM customers c
       LEFT JOIN businesses b ON b.id = c.business_id
       LEFT JOIN LATERAL (
         SELECT id FROM knowledge_bases WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 1
       ) kb ON true
       -- The newest pack, approved or not: an unapproved newer pack is exactly
       -- the state an operator needs to see.
       LEFT JOIN LATERAL (
         SELECT approved_at, version, pair_count FROM qa_packs
          WHERE customer_id = c.id ORDER BY version DESC, created_at DESC LIMIT 1
       ) p ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS open_gaps FROM agent_gaps
          WHERE customer_id = c.id AND status = 'open'
       ) g ON true
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT ss.id)                                   AS sessions,
                count(t.id)                                             AS turns,
                -- Only 'pack' and 'pack_hedged' count as deflection. A refusal,
                -- a protocol response and a state-machine reply all carry an
                -- answered_from value too, and counting them would inflate the
                -- one number this screen exists to report: how often the
                -- customer's own knowledge answered the question.
                count(t.id) FILTER (WHERE t.answered_from IN ('pack','pack_hedged')) AS answered_from_pack,
                count(t.id) FILTER (WHERE t.route = 'escalate')          AS escalations,
                max(ss.opened_at)                                        AS last_session_at,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY t.latency_ms) AS median_latency_ms
           FROM agent_sessions ss
           LEFT JOIN agent_turns t ON t.session_id = ss.id
          WHERE ss.customer_id = c.id
       ) s ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS incidents FROM protocol_incidents
          WHERE customer_id = c.id AND acknowledged_at IS NULL AND resolved_at IS NULL
       ) i ON true
      ORDER BY c.legal_name
      LIMIT $1`,
    [limit],
  );

  const total = await db.one<{ n: string }>("SELECT count(*) AS n FROM customers");
  let liveCount = 0;

  const board: DeployedAgentRow[] = rows.rows.map((r) => {
    const blockedBy: string[] = [];
    if (r.kb_id === null) blockedBy.push("no knowledge base");
    if (r.pack_approved !== true) blockedBy.push("Q&A pack not approved");
    if (r.vertical === null) blockedBy.push("vertical unresolved");
    const live = blockedBy.length === 0;
    if (live) liveCount++;
    const turns = Number(r.turns);
    return {
      customerId: r.customer_id,
      legalName: r.legal_name,
      domain: r.domain,
      vertical: r.vertical,
      live,
      blockedBy,
      packApproved: r.pack_approved === true,
      packVersion: r.pack_version,
      pairCount: r.pair_count ?? 0,
      openGaps: Number(r.open_gaps),
      sessions: Number(r.sessions),
      turns,
      answeredFromPack: Number(r.answered_from_pack),
      deflectionRate: turns === 0 ? null : Number(r.answered_from_pack) / turns,
      escalations: Number(r.escalations),
      unacknowledgedIncidents: Number(r.incidents),
      lastSessionAt: r.last_session_at === null ? null : new Date(r.last_session_at),
      medianLatencyMs: r.median_latency_ms === null ? null : Math.round(Number(r.median_latency_ms)),
    };
  });

  return { rows: board, totalCustomers: Number(total.n), liveCount, asOf: now };
}

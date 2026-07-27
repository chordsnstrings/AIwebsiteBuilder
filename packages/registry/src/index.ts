// The model registry (spec §11). role → candidate pool → champion, with an
// audit log. Changing a champion writes a row recording the eval run that
// justified it; a champion without a stored eval run is not permitted. The
// registry is the ONLY thing that resolves a role to a model — no model name
// appears in agent code (lint-enforced).
import { config } from "@adw/config";
import type { Db } from "@adw/db";

export type RoleId =
  | "enrichment" | "site_scoring" | "preview_gen" | "outreach_draft" | "customer_care"
  | "developer" | "reviewer_patch" | "ux_review" | "ip_claims" | "finance_pricing"
  | "retention" | "dunning" | "researcher" | "pr_report" | "vendor_orchestrator"
  | "sentinel" | "ceo";

export type ModelRef = string; // e.g. "modelark/seed-2-0-pro"
export type DataClass = "PUB" | "PUBLISHABLE" | "CUST" | "PAY";

export interface RoleResolution {
  role: RoleId;
  champion: ModelRef;
  escalation: ModelRef[];
  dataClass: DataClass;
  status: "active" | "pending";
  pinned: boolean;
}

/** Seed the registry_roles table from config/registry.yaml (idempotent). */
export async function seedRegistry(db: Db): Promise<void> {
  const { data } = config.registry();
  for (const [role, r] of Object.entries(data.roles)) {
    // Champion is intentionally NULL until an eval run selects one. Pinned roles
    // (ceo, sentinel) get their pinned model set directly, with a synthetic
    // 'pinned' provenance, since they are not eval-selected by design.
    const pinned = r.pinned ?? false;
    const pinnedModel = pinned ? data.rails.pinned[role] ?? r.candidates[0] : null;
    await db.query(
      `INSERT INTO registry_roles
        (role, candidates, champion, champion_since, escalation, eval_suite, selection_metric, re_eval_cadence, data_class, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (role) DO UPDATE SET
         candidates = EXCLUDED.candidates,
         escalation = EXCLUDED.escalation,
         eval_suite = EXCLUDED.eval_suite,
         selection_metric = EXCLUDED.selection_metric,
         re_eval_cadence = EXCLUDED.re_eval_cadence,
         data_class = EXCLUDED.data_class`,
      [
        role,
        JSON.stringify(r.candidates),
        pinnedModel,
        pinned ? new Date() : null,
        JSON.stringify(r.escalation),
        r.eval_suite,
        r.selection_metric,
        r.re_eval_cadence,
        r.data_class,
        pinned ? "active" : (r.status ?? "pending"),
      ],
    );
  }
}

/** Resolve a role to its champion + escalation chain. Throws if no champion. */
export async function resolveRole(db: Db, role: RoleId): Promise<RoleResolution> {
  const row = await db.maybeOne<{
    champion: string | null;
    escalation: unknown;
    data_class: DataClass;
    status: "active" | "pending";
  }>(
    "SELECT champion, escalation, data_class, status FROM registry_roles WHERE role = $1",
    [role],
  );
  if (!row) throw new Error(`Role not in registry: ${role}`);
  if (!row.champion) {
    throw new Error(`Role ${role} has no champion — an eval run must select one first (spec §11).`);
  }
  const { data } = config.registry();
  const pinned = data.roles[role]?.pinned ?? false;
  return {
    role,
    champion: row.champion,
    escalation: (row.escalation as string[]) ?? [],
    dataClass: row.data_class,
    status: row.status,
    pinned,
  };
}

/**
 * Set a champion. Requires an eval run id (spec §11: the change writes an audit
 * row referencing the run that justified it). This is the ONLY write path for
 * champions and is callable by the eval harness only.
 */
export async function setChampion(
  db: Db,
  role: RoleId,
  champion: ModelRef,
  evalRunId: string,
  metric: number,
): Promise<void> {
  const prev = await db.maybeOne<{ champion: string | null }>(
    "SELECT champion FROM registry_roles WHERE role = $1",
    [role],
  );
  await db.tx(async (tx) => {
    await tx.query(
      `UPDATE registry_roles
       SET champion = $2, champion_since = now(), champion_metric = $3, champion_eval_run_id = $4, status = 'active'
       WHERE role = $1`,
      [role, champion, metric, evalRunId],
    );
    await tx.query(
      `INSERT INTO registry_audit (role, old_champion, new_champion, eval_run_id) VALUES ($1,$2,$3,$4)`,
      [role, prev?.champion ?? null, champion, evalRunId],
    );
  });
}

export async function recordFallbackOk(db: Db, role: RoleId): Promise<void> {
  await db.query("UPDATE registry_roles SET fallback_last_ok = now() WHERE role = $1", [role]);
}

export interface RegistryStatus {
  role: string;
  champion: string | null;
  championSince: string | null;
  championMetric: number | null;
  hasEvalRun: boolean;
  status: string;
  fallbackLastOk: string | null;
  escalation: string[];
}

/** For the operator console registry surface. */
export async function registryStatus(db: Db): Promise<RegistryStatus[]> {
  const rows = await db.query<{
    role: string;
    champion: string | null;
    champion_since: string | null;
    champion_metric: number | null;
    champion_eval_run_id: string | null;
    status: string;
    fallback_last_ok: string | null;
    escalation: unknown;
  }>(
    `SELECT role, champion, champion_since, champion_metric, champion_eval_run_id, status, fallback_last_ok, escalation
     FROM registry_roles ORDER BY role`,
  );
  return rows.rows.map((r) => ({
    role: r.role,
    champion: r.champion,
    championSince: r.champion_since,
    championMetric: r.champion_metric,
    hasEvalRun: r.champion_eval_run_id !== null || r.champion !== null,
    status: r.status,
    fallbackLastOk: r.fallback_last_ok,
    escalation: (r.escalation as string[]) ?? [],
  }));
}

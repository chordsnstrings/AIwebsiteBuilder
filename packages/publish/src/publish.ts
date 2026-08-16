// MF12 — getting it out, and only what was approved.
//
// ⛔ `publishApproved` reads state = 'approved' and nothing else. There is no
// argument, flag or option that lets a draft reach a connector, because the
// approval step is the only thing standing between a model's sentence and a
// business's public profile.

import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { channelById, type Channel, type ConnectorId } from "./catalogue.ts";

export interface ConnectorInput {
  publicationId: string;
  customerId: string;
  channel: Channel;
  topic: string;
  body: string;
  payload: Record<string, unknown>;
  /** Pass this to the platform. A retry after a timeout must be the same post. */
  idempotencyKey: string;
}

export type ConnectorResult = { ok: true; externalId: string } | { ok: false; error: string; retryable?: boolean };
export type Connector = (input: ConnectorInput) => Promise<ConnectorResult>;
export type Connectors = Partial<Record<ConnectorId, Connector>>;

export type ApproveResult =
  | { ok: true; edited: boolean }
  | { ok: false; reason: "unknown" | "not_draft" | "refused" | "too_long"; detail?: string };

/**
 * The owner signs the words off, optionally after changing them.
 *
 * ⛔ An edit is applied BEFORE the state moves, because the database refuses to
 * change the body of anything already approved. What went out has to be what
 * they read.
 */
export async function approvePublication(
  db: Db,
  publicationId: string,
  by: string,
  edit?: { body?: string; payload?: Record<string, unknown> },
): Promise<ApproveResult> {
  return db.tx(async (tx) => {
    const row = await tx.maybeOne<{ state: string; channel: string; body: string }>(
      "SELECT state, channel, body FROM publications WHERE id = $1 FOR UPDATE",
      [publicationId],
    );
    if (row === null) return { ok: false as const, reason: "unknown" as const };
    if (row.state !== "draft") return { ok: false as const, reason: "not_draft" as const, detail: row.state };

    const channel = channelById(row.channel);
    const newBody = edit?.body;
    if (newBody !== undefined && channel !== undefined && channel.maxChars > 0 && newBody.length > channel.maxChars) {
      return { ok: false as const, reason: "too_long" as const, detail: `limit ${channel.maxChars}` };
    }
    const edited = newBody !== undefined && newBody !== row.body;
    if (newBody !== undefined || edit?.payload !== undefined) {
      await tx.query(
        "UPDATE publications SET body = COALESCE($2, body), payload = COALESCE($3::jsonb, payload) WHERE id = $1",
        [publicationId, newBody ?? null, edit?.payload === undefined ? null : JSON.stringify(edit.payload)],
      );
    }
    await tx.query(
      "UPDATE publications SET state = 'approved', approved_at = now(), approved_by = $2, edited = $3 WHERE id = $1",
      [publicationId, by, edited],
    );
    return { ok: true as const, edited };
  });
}

export async function rejectPublication(db: Db, publicationId: string, reason: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE publications SET state = 'rejected', rejected_reason = $2 WHERE id = $1 AND state = 'draft'",
    [publicationId, reason],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface PublishRunResult {
  published: number;
  failed: number;
  /** Held back because the channel published too recently for this customer. */
  deferred: number;
  /** No connector for the channel's platform on this deployment. */
  unconnected: number;
}

const DAY_MS = 86_400_000;
const MAX_ATTEMPTS = 3;

/**
 * Send everything approved and due.
 *
 * ⛔ The cadence floor is applied HERE rather than at approval. An owner working
 * through their queue on a Sunday evening approves eight posts in ten minutes;
 * releasing all eight is a business that looks automated, which is the one thing
 * this whole product exists to avoid.
 */
export async function publishApproved(
  db: Db,
  connectors: Connectors,
  now: Date = new Date(),
  opts: { customerId?: string | undefined; limit?: number } = {},
): Promise<PublishRunResult> {
  const rows = await db.query<{
    id: string; customer_id: string; channel: string; topic: string;
    body: string; payload: Record<string, unknown>; idempotency_key: string; attempts: number;
  }>(
    `SELECT id, customer_id, channel, topic, body, payload, idempotency_key, attempts
       FROM publications
      WHERE state = 'approved' AND attempts < $1
        AND ($2::uuid IS NULL OR customer_id = $2)
      ORDER BY approved_at ASC
      LIMIT $3`,
    [MAX_ATTEMPTS, opts.customerId ?? null, opts.limit ?? 200],
  );

  const result: PublishRunResult = { published: 0, failed: 0, deferred: 0, unconnected: 0 };
  // Held within this sweep as well as against history, so two approvals of the
  // same channel in one batch cannot both go out.
  const releasedThisRun = new Map<string, number>();

  for (const row of rows.rows) {
    const channel = channelById(row.channel);
    if (channel === undefined) continue;
    const connector = connectors[channel.connector];
    if (connector === undefined) {
      result.unconnected += 1;
      continue;
    }

    if (channel.cadenceDays > 0) {
      const cadenceMs = channel.cadenceDays * DAY_MS;
      const slot = `${row.customer_id}:${row.channel}`;
      const inRun = releasedThisRun.get(slot);
      if (inRun !== undefined && now.getTime() - inRun < cadenceMs) {
        result.deferred += 1;
        continue;
      }
      const last = await db.maybeOne<{ published_at: Date }>(
        `SELECT published_at FROM publications
          WHERE customer_id = $1 AND channel = $2 AND state = 'published' AND published_at IS NOT NULL
          ORDER BY published_at DESC LIMIT 1`,
        [row.customer_id, row.channel],
      );
      if (last !== null && now.getTime() - new Date(last.published_at).getTime() < cadenceMs) {
        result.deferred += 1;
        continue;
      }
    }

    let outcome: ConnectorResult;
    try {
      outcome = await connector({
        publicationId: row.id,
        customerId: row.customer_id,
        channel,
        topic: row.topic,
        body: row.body,
        payload: row.payload ?? {},
        idempotencyKey: row.idempotency_key,
      });
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
    }

    if (outcome.ok) {
      await db.query(
        "UPDATE publications SET state = 'published', published_at = $2, external_id = $3, attempts = attempts + 1, last_error = NULL WHERE id = $1",
        [row.id, now, outcome.externalId],
      );
      releasedThisRun.set(`${row.customer_id}:${row.channel}`, now.getTime());
      result.published += 1;
      await emit({
        eventType: "publication.published",
        subject: { kind: "publication", id: row.id },
        payload: { channel: row.channel, externalId: outcome.externalId },
      });
      continue;
    }

    const attempts = row.attempts + 1;
    // ⛔ A non-retryable failure stops immediately. Retrying a rejected post
    // three times against a platform that already said no is how an account
    // gets rate-limited, and the third attempt tells us nothing the first did
    // not.
    const terminal = outcome.retryable === false || attempts >= MAX_ATTEMPTS;
    await db.query(
      "UPDATE publications SET attempts = $2, last_error = $3, state = $4 WHERE id = $1",
      [row.id, attempts, outcome.error, terminal ? "failed" : "approved"],
    );
    result.failed += 1;
  }
  return result;
}

export interface PublicationRow {
  id: string;
  channel: string;
  label: string;
  topic: string;
  body: string;
  state: string;
  edited: boolean;
  sourceFacts: string[];
  approvedBy: string | null;
  publishedAt: Date | null;
  externalId: string | null;
  lastError: string | null;
}

/** The owner's queue: what is waiting for them, newest first. */
export async function pendingApproval(db: Db, customerId: string, limit = 50): Promise<PublicationRow[]> {
  return list(db, customerId, ["draft"], limit);
}

/** What actually went out, and under whose name it was approved. */
export async function publicationLog(db: Db, customerId: string, limit = 100): Promise<PublicationRow[]> {
  return list(db, customerId, ["published", "failed", "rejected", "approved"], limit);
}

async function list(db: Db, customerId: string, states: string[], limit: number): Promise<PublicationRow[]> {
  const rows = await db.query<{
    id: string; channel: string; topic: string; body: string; state: string; edited: boolean;
    source_facts: string[]; approved_by: string | null; published_at: Date | null;
    external_id: string | null; last_error: string | null;
  }>(
    `SELECT id, channel, topic, body, state, edited, source_facts, approved_by, published_at, external_id, last_error
       FROM publications
      WHERE customer_id = $1 AND state = ANY($2::text[])
      ORDER BY COALESCE(published_at, approved_at, drafted_at) DESC
      LIMIT $3`,
    [customerId, states, limit],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    label: channelById(r.channel)?.label ?? r.channel,
    topic: r.topic,
    body: r.body,
    state: r.state,
    edited: r.edited,
    sourceFacts: r.source_facts,
    approvedBy: r.approved_by,
    publishedAt: r.published_at === null ? null : new Date(r.published_at),
    externalId: r.external_id,
    lastError: r.last_error,
  }));
}

/**
 * Connectors for demo mode: they record and hand back an id, and they honour
 * the idempotency key so a replay returns the first id rather than a second
 * post.
 */
export function simulatedConnectors(): Connectors {
  const sent = new Map<string, string>();
  const one = (platform: string): Connector => async ({ idempotencyKey }) => {
    const existing = sent.get(idempotencyKey);
    if (existing !== undefined) return { ok: true, externalId: existing };
    const id = `${platform}_${idempotencyKey.slice(0, 12)}`;
    sent.set(idempotencyKey, id);
    return { ok: true, externalId: id };
  };
  return {
    gbp: one("gbp"), social: one("soc"), site: one("site"), reviews: one("rev"),
    listings: one("lst"), directory: one("dir"), feed: one("feed"), ads: one("ads"), search: one("srch"),
  };
}

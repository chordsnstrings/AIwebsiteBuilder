// MF13 — drafting the words.
//
// ⛔ A draft is GROUNDED and GUARDED. Grounded: the facts it may use are passed
// in from the knowledge base, and which ones were used is stored on the row, so
// a claim on a business's public profile can be traced back to something they
// told us. Guarded: the same refusal policy that stops their agent promising a
// 60-minute arrival applies to their marketing, because a promise is a promise
// whether it is made in a chat window or on a Google post.
//
// ⛔ And a draft is only ever a draft. Nothing here can reach a connector.

import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@adw/db";
import { refusalPolicy, refusalRuleMatches } from "@adw/concierge";
import { emit } from "@adw/telemetry";
import { channelFor, channelVersion, type Channel } from "./catalogue.ts";

export interface DraftInput {
  customerId: string;
  vertical: string;
  channel: string;
  topic: string;
  /** Verified KB facts the draft may draw on. Nothing else is available to it. */
  facts?: string[] | undefined;
  /** Structured channels (a feed, a directory record) supply this instead. */
  payload?: Record<string, unknown> | undefined;
  /** Prose supplied directly by the owner, skipping the drafter. */
  body?: string | undefined;
  idempotencyKey?: string | undefined;
}

/** Injected so demo mode, the model gateway and a test all take one path. */
export type Drafter = (input: {
  channel: Channel;
  vertical: string;
  topic: string;
  facts: string[];
  maxChars: number;
}) => Promise<{ body: string; usedFacts: string[] }>;

export type DraftResult =
  | { ok: true; publicationId: string; body: string; state: "draft" }
  | { ok: false; reason: "unknown_channel" | "refused" | "too_long" | "no_facts"; detail: string };

export function publicationKey(input: { customerId: string; channel: string; topic: string }): string {
  return createHash("sha256")
    .update(`${input.customerId}|${input.channel}|${input.topic.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

export async function draftPublication(
  db: Db,
  input: DraftInput,
  drafter: Drafter,
): Promise<DraftResult> {
  const channel = channelFor(input.vertical, input.channel);
  if (channel === undefined) {
    return { ok: false, reason: "unknown_channel", detail: `no channel "${input.channel}" for "${input.vertical}"` };
  }

  const facts = input.facts ?? [];
  let body = input.body ?? "";
  let usedFacts: string[] = [];

  if (channel.maxChars > 0 && input.body === undefined) {
    // ⛔ No facts, no draft. A model asked to write a promotional post about a
    // business it knows nothing about will invent the business — and the
    // invention goes out under their name.
    if (facts.length === 0) {
      return { ok: false, reason: "no_facts", detail: "a prose channel needs verified facts to draft from" };
    }
    const drafted = await drafter({
      channel, vertical: input.vertical, topic: input.topic, facts, maxChars: channel.maxChars,
    });
    body = drafted.body;
    usedFacts = drafted.usedFacts;
  }

  if (channel.maxChars > 0) {
    if (body.trim().length === 0) {
      return { ok: false, reason: "too_long", detail: "the draft was empty" };
    }
    // ⛔ Refused, never truncated. A post cut at 280 characters mid-sentence is
    // a business looking careless in public, and the cut lands wherever the
    // model happened to be — frequently in the middle of a price.
    if (body.length > channel.maxChars) {
      return { ok: false, reason: "too_long", detail: `${body.length} characters against a limit of ${channel.maxChars}` };
    }
    const blocked = guard(input.vertical, body, facts, input.body !== undefined);
    if (blocked !== null) {
      return { ok: false, reason: "refused", detail: blocked };
    }
  }

  const key = input.idempotencyKey ?? `${publicationKey(input)}:${randomUUID().slice(0, 8)}`;
  const row = await db.one<{ id: string }>(
    `INSERT INTO publications (customer_id, channel, channel_version, topic, body, payload, source_facts, idempotency_key, drafted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      input.customerId, channel.id, channelVersion(), input.topic, body,
      JSON.stringify(input.payload ?? {}), usedFacts, key,
      input.body === undefined ? "system" : "owner",
    ],
  );
  await emit({
    eventType: "publication.drafted",
    subject: { kind: "publication", id: row.id },
    payload: { channel: channel.id, approvalRequired: channel.approvalRequired },
  });
  return { ok: true, publicationId: row.id, body, state: "draft" };
}

/**
 * The refusal policy, applied to marketing copy.
 *
 * ⛔ Hard rules apply to everything. A guaranteed arrival time, a competitor
 * comparison or a request for card details is not sayable because a fact
 * exists — a promise is a promise whether it is made in a chat window or on a
 * Google post.
 *
 * ⛔ Groundable rules must TRACE. "Gas Safe registered" is publishable by a
 * business that is, and a lie for one that is not, so the test is not whether
 * the words look plausible but whether the claim appears in a fact the business
 * gave us. A model that introduces a credential of its own is refused, and a
 * model that repeats one from the knowledge base is not.
 *
 * Words the owner typed themselves are their own claim to make; only the hard
 * rules apply to those.
 */
function guard(vertical: string, body: string, facts: string[], ownerWritten: boolean): string | null {
  for (const rule of refusalPolicy(vertical).rules) {
    if (!refusalRuleMatches(rule, body)) continue;
    if (!rule.groundable) return rule.reason;
    if (ownerWritten) continue;
    if (!facts.some((fact) => refusalRuleMatches(rule, fact))) return rule.reason;
  }
  return null;
}

/**
 * A drafter that composes from the facts alone, for demo mode and tests.
 *
 * ⛔ Says only what it was given. The temptation is to write something that
 * reads well by adding "trusted local experts since 1994"; that sentence is a
 * claim about a business we cannot check, published in their name.
 */
export function factsOnlyDrafter(): Drafter {
  return async ({ topic, facts, maxChars }) => {
    const used = facts.slice(0, 3);
    const body = [`${topic}.`, ...used].join(" ").slice(0, Math.max(1, maxChars));
    return { body, usedFacts: used };
  };
}

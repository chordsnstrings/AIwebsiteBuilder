// Authorisation for the owner-facing API — who may act on WHICH customer.
//
// ⛔ EVERY ROUTE UNDER /agent AND /ops CHECKED AUTHENTICATION AND NOTHING ELSE.
// The uniform line was `if (user(c) === null) return 401`, forty times over. So
// any signed-in customer — a real one, with a real session, on the dashboard we
// shipped them — could read and write every other customer's enquiries, missed
// calls, documents, findings, bookings, reminders, reconciliations and Q&A
// packs by changing a uuid in the URL, and could read the whole enterprise
// acquisition pipeline from /ops/opportunities. There is no exploit to write:
// the URL is the exploit.
//
// It is enforced as MIDDLEWARE rather than a line in each handler for one
// reason: a per-handler check is a thing you can forget, and this codebase's
// signature failure is a control that exists everywhere except the one place it
// was needed. Here an unrecognised /agent path fails CLOSED — superadmin only —
// so a route added later is guarded before its author thinks about it, and the
// cost of forgetting is a 403 in development rather than a leak in production.
//
// The visitor surface is the explicit exception below, and it is explicit
// because getting it wrong silently breaks the customer's own website.
import type { Context, MiddlewareHandler, Next } from "hono";
import type { Db } from "@adw/db";
import type { SessionUser } from "@adw/auth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Denial {
  status: 401 | 403 | 404;
  error: string;
}

/**
 * Routes whose callers are the CUSTOMER'S customers, not our users.
 *
 * ⛔ A visitor asking a plumber's website a question has no account and never
 * will. Each of these protects itself with something other than a login — an
 * unguessable session id, a claim token, a scan gate, a signature — and the
 * comments at each handler say which. Adding a path here removes its
 * authentication entirely, so the list is closed by method as well as by path.
 */
export function isVisitorRoute(method: string, path: string): boolean {
  if (path === "/api/enquiry" || path === "/mcp/tools" || path === "/.well-known/mcp") return true;
  if (method !== "POST") {
    // The document checklist is opened from a magic link by the person filling
    // it in; `loadRequest` scopes it to the request id, which is the capability.
    return method === "GET" && path.startsWith("/agent/documents/");
  }
  return (
    path === "/agent/session" ||
    path === "/agent/ask" ||
    path === "/agent/turn" ||
    path === "/agent/uploads" ||
    path === "/agent/bookings" ||
    path.startsWith("/agent/documents/")
  );
}

/**
 * Which customer owns the row an id-addressed route acts on.
 *
 * One statement per resource, in one place, because the alternative is trusting
 * forty handlers to each remember to join back to `customers`. A resource
 * missing from this map is not assumed safe — `resolveOwner` reports it as
 * unknown and the middleware refuses.
 */
const OWNER_QUERY: Readonly<Record<string, string>> = {
  gaps: "SELECT customer_id FROM agent_gaps WHERE id = $1",
  packs: "SELECT customer_id FROM qa_packs WHERE id = $1",
  uploads: "SELECT customer_id FROM uploads WHERE id = $1",
  bookings: "SELECT customer_id FROM bookings WHERE id = $1",
  enquiries: "SELECT customer_id FROM enquiries WHERE id = $1",
  reminders: "SELECT customer_id FROM reminders WHERE id = $1",
  journeys: "SELECT customer_id FROM journey_runs WHERE id = $1",
  watches: "SELECT customer_id FROM watch_subscriptions WHERE id = $1",
  findings: "SELECT customer_id FROM watch_findings WHERE id = $1",
  publications: "SELECT customer_id FROM publications WHERE id = $1",
  assets: "SELECT customer_id FROM generated_assets WHERE id = $1",
  calls: "SELECT customer_id FROM calls WHERE id = $1",
  queue: "SELECT customer_id FROM exceptions WHERE id = $1",
  reconciliations: "SELECT customer_id FROM recon_runs WHERE id = $1",
  // `/agent/reconciliations/differences/:matchId/resolve` addresses a row one
  // join away from the run that owns it.
  "reconciliations/differences":
    "SELECT r.customer_id FROM recon_matches m JOIN recon_runs r ON r.id = m.run_id WHERE m.id = $1",
};

export type Owner =
  | { kind: "customer"; customerId: string }
  /** The row exists and belongs to no customer — a speculative pack or gap. */
  | { kind: "unowned" }
  | { kind: "missing" }
  /** No ownership statement for this resource; the middleware fails closed. */
  | { kind: "unknown_resource" };

export async function resolveOwner(db: Db, resource: string, id: string): Promise<Owner> {
  const sql = OWNER_QUERY[resource];
  if (sql === undefined) return { kind: "unknown_resource" };
  const row = await db.maybeOne<{ customer_id: string | null }>(sql, [id]);
  if (row === null) return { kind: "missing" };
  return row.customer_id === null ? { kind: "unowned" } : { kind: "customer", customerId: row.customer_id };
}

/**
 * May this caller act on this customer?
 *
 * ⛔ A superadmin passes everywhere — that is the operator console, and every
 * one of its reads is already logged. A customer passes only on their own id.
 * A customer session carrying a null `customerId` passes nowhere: it is a
 * half-provisioned account, and treating "no customer" as "any customer" is the
 * exact shape of the bug this file exists to close.
 */
export function mayActOn(u: SessionUser | null, customerId: string | null): Denial | null {
  if (u === null) return { status: 401, error: "unauthorised" };
  if (u.role === "superadmin") return null;
  if (customerId === null) return { status: 403, error: "forbidden" };
  return u.customerId === customerId ? null : { status: 403, error: "forbidden" };
}

/** What the middleware decides for one already-resolved owner. */
export function decideForOwner(u: SessionUser | null, owner: Owner): Denial | null {
  switch (owner.kind) {
    case "customer":
      return mayActOn(u, owner.customerId);
    case "unowned":
      // A speculative pack or a preview gap belongs to a business we have not
      // sold to. Only an operator may touch one; a customer approving an answer
      // into a stranger's pack is the same violation as reading their enquiries.
      return u !== null && u.role === "superadmin" ? null : { status: 403, error: "forbidden" };
    case "missing":
      // ⛔ 404 only AFTER establishing the caller is signed in. Answering
      // "not found" to an anonymous prober turns this route into an oracle for
      // which ids exist.
      return u === null ? { status: 401, error: "unauthorised" } : { status: 404, error: "not found" };
    case "unknown_resource":
      return u !== null && u.role === "superadmin" ? null : { status: 403, error: "forbidden" };
  }
}

/**
 * Splits `/agent/<a>/<b>/…` into what has to be checked.
 *
 * Two shapes reach here. `/agent/<uuid>/…` names the customer directly. Every
 * other `/agent/<resource>/<id>/…` names a row, and the row names the customer.
 */
export interface Target {
  kind: "customer" | "resource" | "operator" | "open";
  customerId?: string;
  resource?: string;
  id?: string;
}

export function classify(method: string, path: string): Target {
  if (isVisitorRoute(method, path)) return { kind: "open" };
  // ⛔ /ops is the operator console — the acquisition pipeline, the worklist,
  // every customer's name. `user(c) !== null` let any signed-in customer read
  // all of it.
  if (path.startsWith("/ops/")) return { kind: "operator" };
  if (!path.startsWith("/agent/")) return { kind: "open" };

  const seg = path.split("/").filter((s) => s !== "");
  const a = seg[1];
  if (a === undefined) return { kind: "operator" };
  if (UUID_RE.test(a)) return { kind: "customer", customerId: a };

  // `reconciliations/differences/:matchId` is the one two-word resource.
  const compound = seg[2] === "differences" ? `${a}/${seg[2]}` : null;
  const resource = compound ?? a;
  const id = compound === null ? seg[2] : seg[3];
  if (id === undefined || !UUID_RE.test(id)) {
    // A collection route with no id and no customer in the path — nothing here
    // scopes it, so only an operator may call it.
    return { kind: "operator" };
  }
  return { kind: "resource", resource, id };
}

export interface TenancyDeps {
  db: Db;
  /** Same hook the routes use, so tests inject a caller without a cookie. */
  currentUser: (c: Context<{ Variables: { user: SessionUser | null } }>) => SessionUser | null;
}

export function tenancyMiddleware(deps: TenancyDeps): MiddlewareHandler<{ Variables: { user: SessionUser | null } }> {
  return async (c: Context<{ Variables: { user: SessionUser | null } }>, next: Next) => {
    // Preflight carries no cookie by definition; corsMiddleware answers it.
    if (c.req.method === "OPTIONS") return next();

    const target = classify(c.req.method, c.req.path);
    if (target.kind === "open") return next();

    const u = deps.currentUser(c);
    let denial: Denial | null;
    if (target.kind === "operator") {
      // ⛔ 403 for BOTH the anonymous caller and the signed-in non-operator,
      // matching `requireOperator` in app.ts. The console's own routes have
      // always answered that way and its suite asserts it: a uniform refusal
      // does not tell an unauthenticated prober whether the difference between
      // them is a missing cookie or the wrong role. The `/agent` surface keeps
      // the 401/403 split because its handlers and their tests distinguish
      // "sign in" from "not yours", which is a real difference to an owner
      // whose session merely expired.
      denial = u !== null && u.role === "superadmin" ? null : { status: 403, error: "forbidden" };
    } else if (target.kind === "customer") {
      denial = mayActOn(u, target.customerId ?? null);
    } else {
      // ⛔ Resolve ownership BEFORE the handler runs. Checking afterwards means
      // the write already happened.
      denial = decideForOwner(u, await resolveOwner(deps.db, target.resource ?? "", target.id ?? ""));
    }
    if (denial !== null) return c.json({ error: denial.error }, denial.status);
    return next();
  };
}

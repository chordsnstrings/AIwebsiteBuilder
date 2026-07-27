// Server entrypoint. The app itself lives in app.ts so it can be exercised in
// tests without binding a port.
import { serve } from "@hono/node-server";
import { unsubscribeSecret } from "@adw/compliance";
import { buildApp, resolveForceMock } from "./app.ts";

// Fail fast on the secrets whose absence is silent rather than loud. A missing
// unsubscribe secret does not break a request — it breaks every unsubscribe link
// in mail that has already left the building, months later, invisibly.
unsubscribeSecret();

const mock = resolveForceMock();
const { app, db } = await buildApp();
const port = Number(process.env.PORT ?? 8787);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ADW API listening on http://localhost:${info.port} — adapters: ${mock ? "mock" : "vault-resolved"}`);
});

// Drain on signal so an in-flight gate decision or webhook effect finishes
// rather than being killed halfway through its transaction.
async function shutdown(signal: string): Promise<void> {
  console.log(`[api] ${signal} — draining`);
  server.close();
  await db.close().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

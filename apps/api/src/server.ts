// Server entrypoint. The app itself lives in app.ts so it can be exercised in
// tests without binding a port.
import { serve } from "@hono/node-server";
import { buildApp } from "./app.ts";

const app = await buildApp();
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ADW API (demo mode) listening on http://localhost:${info.port}`);
});

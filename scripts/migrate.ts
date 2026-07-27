import { createDb, migrate } from "../packages/db/src/index.ts";

const url = process.argv[2] ?? process.env.DATABASE_URL;
const db = await createDb({ backend: "pg", url });
const result = await migrate(db);
console.log(`applied: ${result.applied.length ? result.applied.join(", ") : "(none)"}`);
console.log(`skipped: ${result.skipped.length}`);
await db.close();

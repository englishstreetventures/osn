import { createApp } from "./app";
import { createDb, seedDb } from "./db/setup";
import { createR2Stub } from "./services/r2-imports";

const db = createDb(":memory:");
await seedDb(db);

const origins = (process.env.WEB_ORIGIN ?? "http://localhost:4321,http://localhost:4322")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const webOrigin = origins[0];
const port = Number(process.env.PORT ?? 8787);

const organiserToken = process.env.ORGANISER_TOKEN ?? "dev-organiser-token";
const r2 = createR2Stub();

const app = createApp(db, { webOrigin, allowedOrigins: origins, organiserToken, r2 });

console.log(`Organiser token: ${organiserToken}`);

const server = Bun.serve({ port, fetch: app.fetch });
console.log(`API running at http://localhost:${server.port}`);

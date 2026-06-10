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

const r2 = createR2Stub();

const app = createApp(db, {
  webOrigin,
  allowedOrigins: origins,
  r2,
  osnJwksUrl: process.env.OSN_JWKS_URL,
  osnAudience: process.env.OSN_AUDIENCE,
});

const server = Bun.serve({ port, fetch: app.fetch });
console.log(`API running at http://localhost:${server.port}`);

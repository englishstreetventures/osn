import { createApp } from "./app";
import { createDb, seedDb } from "./db/setup";

const db = createDb(":memory:");
await seedDb(db);

const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:4321";
const port = Number(process.env.PORT ?? 8787);

const app = createApp(db, webOrigin);

const server = Bun.serve({ port, fetch: app.fetch });
console.log(`API running at http://localhost:${server.port}`);

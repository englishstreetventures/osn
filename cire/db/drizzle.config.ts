import { defineConfig } from "drizzle-kit";

// `db:studio` needs a concrete DB to read. cire runs on Cloudflare D1; in local
// dev that's a miniflare-managed SQLite file under cire/api/.wrangler. Point
// drizzle-kit at it so `bun run --cwd cire/db db:studio` opens the local D1.
// The hashed filename is the hash miniflare derives from the local database id
// in cire/api/wrangler.toml (`local:cire-db`): it changes only with that id.
const LOCAL_D1 =
  "../api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/d3a96ac368f6f049b150e9ba40a04ca6858b02e9484c48067366aec03fd4bb9d.sqlite";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  dbCredentials: { url: process.env.CIRE_DATABASE_URL ?? LOCAL_D1 },
});

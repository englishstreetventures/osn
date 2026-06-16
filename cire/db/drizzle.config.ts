import { defineConfig } from "drizzle-kit";

// `db:studio` needs a concrete DB to read. cire runs on Cloudflare D1; in local
// dev that's a miniflare-managed SQLite file under cire/api/.wrangler. Point
// drizzle-kit at it so `bun run --cwd cire/db db:studio` opens the local D1.
// The hashed filename is the D1 database id's content hash — stable until the
// local D1 is recreated (e.g. `db:reset`); regenerate the path if it changes.
const LOCAL_D1 =
  "../api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/7ae86edae7bfe89da20089bef615fb0a2e5e34e7b8de0a602e18548b85922710.sqlite";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  dbCredentials: { url: process.env.CIRE_DATABASE_URL ?? LOCAL_D1 },
});

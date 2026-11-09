import { defineConfig } from "drizzle-kit";

/**
 * The local SQLite file `db:push` builds, relative to this package.
 * `src/push-triggers.ts` adds the triggers to the same file.
 */
export const localDbUrl = process.env.OSN_DATABASE_URL || "../../data/osn.db";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: localDbUrl,
  },
});

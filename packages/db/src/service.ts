import { Context, Layer, Effect } from "effect";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DbService {
  readonly db: BunSQLiteDatabase<typeof schema>;
}

export class Db extends Context.Tag("@osn/db/Db")<Db, DbService>() {}

export const DbLive = Layer.effect(
  Db,
  Effect.sync(() => {
    const dbPath = process.env.DATABASE_URL || resolve(__dirname, "../../../data/osn.db");
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite, { schema });
    return { db };
  }),
);

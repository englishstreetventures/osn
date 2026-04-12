import { Context } from "effect";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDbLive } from "@shared/db-utils";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DbService {
  readonly db: BunSQLiteDatabase<typeof schema>;
}

export class Db extends Context.Tag("@zap/db/Db")<Db, DbService>() {}

export const DbLive = makeDbLive(
  Db,
  process.env.ZAP_DATABASE_URL || resolve(__dirname, "../../../data/zap.db"),
  schema,
);

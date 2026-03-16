import { Context } from "effect";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDbLive } from "@utils/db";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DbService {
  readonly db: BunSQLiteDatabase<typeof schema>;
}

export class Db extends Context.Tag("@osn/db/Db")<Db, DbService>() {}

export const DbLive = makeDbLive(
  Db,
  process.env.OSN_DATABASE_URL || resolve(__dirname, "../../../data/osn.db"),
  schema,
);

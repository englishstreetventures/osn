import { Context, Layer } from "effect";
import { db } from "./client";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type * as schema from "./schema";

export interface DbService {
  readonly db: BunSQLiteDatabase<typeof schema>;
}

export class Db extends Context.Tag("@osn/db/Db")<Db, DbService>() {}

export const DbLive = Layer.succeed(Db, { db });

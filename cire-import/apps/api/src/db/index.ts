import { Context } from "effect";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type * as schema from "@cire/db";

export type Db = BunSQLiteDatabase<typeof schema>;

export class DbService extends Context.Tag("DbService")<DbService, Db>() {}

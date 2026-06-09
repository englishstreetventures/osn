import type * as schema from "@cire/db";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Context } from "effect";

export type Db = BunSQLiteDatabase<typeof schema>;

export class DbService extends Context.Tag("DbService")<DbService, Db>() {}

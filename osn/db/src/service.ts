import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { D1Database } from "@cloudflare/workers-types";
import { makeDbLive, makeD1DbLive, type Db as DbHandle } from "@shared/db-utils";
import { Context, type Layer } from "effect";

import * as schema from "./schema";

/**
 * bun:sqlite path, resolved LAZILY. `fileURLToPath(import.meta.url)` throws on
 * workerd (`import.meta.url` is undefined there), so it must not run at module
 * load — it would crash the Worker isolate at startup even though the Workers
 * path never builds `DbLive` (it uses `makeDbD1Live`). Computed inside the
 * `makeDbLive` thunk, which only runs on Bun.
 */
const resolveLocalDbPath = (): string =>
  process.env.OSN_DATABASE_URL ||
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/osn.db");

export interface DbService {
  // Broadened over both SQLite result kinds so the same query code runs against
  // bun:sqlite (the `local` env) and Cloudflare D1 (`dev`/`staging`/`prod`).
  readonly db: DbHandle<typeof schema>;
}

export class Db extends Context.Tag("@osn/db/Db")<Db, DbService>() {}

/** bun:sqlite-backed layer — the `local` environment (dev servers + tests). */
export const DbLive = makeDbLive(Db, resolveLocalDbPath, schema);

/** D1-backed layer for the Workers runtime (`dev`/`staging`/`prod`). */
export const makeDbD1Live = (d1: D1Database): Layer.Layer<Db> => makeD1DbLive(Db, d1, schema);

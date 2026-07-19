import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { D1Database } from "@cloudflare/workers-types";
import { makeDbLive, makeD1DbLive, type Db as DbHandle } from "@shared/db-utils";
import { Context, type Layer } from "effect";

import * as schema from "./schema";

export interface DbService {
  // Broadened over both SQLite result kinds so the same query code runs against
  // bun:sqlite (the `local` env) and Cloudflare D1 (`dev`/`staging`/`prod`).
  readonly db: DbHandle<typeof schema>;
}

export class Db extends Context.Tag("@zap/db/Db")<Db, DbService>() {}

/**
 * bun:sqlite-backed layer — the `local` environment (dev servers + tests).
 * The path is a THUNK so the Bun-only `fileURLToPath(import.meta.url)` derivation
 * is deferred INTO the lazy Layer — it must NOT run at module load, because the
 * Workers entry imports this module (for `makeDbD1Live`) and `import.meta.url` is
 * undefined on workerd (deploy-time module eval crashes otherwise). On Workers
 * `DbLive`'s layer is never built (the entry uses the D1 layer), so the thunk
 * never runs there.
 */
export const DbLive = makeDbLive(
  Db,
  () =>
    process.env.ZAP_DATABASE_URL ||
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/zap.db"),
  schema,
);

/** D1-backed layer for the Workers runtime (`dev`/`staging`/`prod`). */
export const makeDbD1Live = (d1: D1Database): Layer.Layer<Db> => makeD1DbLive(Db, d1, schema);

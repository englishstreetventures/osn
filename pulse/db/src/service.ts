import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { D1Database } from "@cloudflare/workers-types";
import { makeDbLive, makeD1DbLive, type Db as DbHandle } from "@shared/db-utils";
import { Context, type Layer } from "effect";

import * as schema from "./schema";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DbService {
  // Broadened over both SQLite result kinds so the same query code runs against
  // bun:sqlite (the `local` env) and Cloudflare D1 (`dev`/`staging`/`prod`).
  readonly db: DbHandle<typeof schema>;
}

export class Db extends Context.Tag("@pulse/db/Db")<Db, DbService>() {}

/** bun:sqlite-backed layer — the `local` environment (dev servers + tests). */
export const DbLive = makeDbLive(
  Db,
  process.env.PULSE_DATABASE_URL || resolve(__dirname, "../../../data/pulse.db"),
  schema,
);

/** D1-backed layer for the Workers runtime (`dev`/`staging`/`prod`). */
export const makeDbD1Live = (d1: D1Database): Layer.Layer<Db> => makeD1DbLive(Db, d1, schema);

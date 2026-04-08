import { Effect, Layer, type Context } from "effect";
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export function createDrizzleClient<S extends Record<string, unknown>>(
  dbPath: string,
  schema: S,
): BunSQLiteDatabase<S> {
  const sqlite = new Database(dbPath);
  return drizzle(sqlite, { schema });
}

export function makeDbLive<S extends Record<string, unknown>>(
  tag: Context.Tag<any, { readonly db: BunSQLiteDatabase<S> }>,
  dbPath: string,
  schema: S,
) {
  return Layer.effect(
    tag,
    Effect.sync(() => ({ db: createDrizzleClient(dbPath, schema) })),
  );
}

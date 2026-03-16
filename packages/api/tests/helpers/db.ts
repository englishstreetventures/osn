import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Layer } from "effect";
import * as schema from "@pulse/db/schema";
import { Db } from "@pulse/db/service";

export function createTestLayer() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      venue TEXT,
      category TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      status TEXT NOT NULL DEFAULT 'upcoming',
      image_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const db = drizzle(sqlite, { schema });
  return Layer.succeed(Db, { db });
}

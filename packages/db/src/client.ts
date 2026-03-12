import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Database is stored at project root /data/osn.db
const dbPath = process.env.DATABASE_URL || resolve(__dirname, "../../../data/osn.db");

const sqlite = new Database(dbPath);
export const db = drizzle(sqlite, { schema });

import { NodePgDatabase } from "drizzle-orm/node-postgres"

import { db } from "#db";

export type Context = {
  db: NodePgDatabase
};

export const createContext = (): Context => ({
  db
});

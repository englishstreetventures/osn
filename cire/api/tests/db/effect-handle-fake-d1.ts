import type { Database } from "bun:sqlite";

import type { D1QueryClient } from "../../src/db/d1-session";

/**
 * A D1 binding over bun:sqlite, answering the calls the drizzle D1 driver makes:
 * prepare, then bind, then all or raw. `onPrepare` sees each statement as it is
 * prepared, so a test can tell which session a query rode.
 */
export function fakeD1(db: Database, onPrepare: (query: string) => void = () => {}): D1QueryClient {
  return {
    prepare(query: string) {
      onPrepare(query);
      const stmt = db.query(query);
      return {
        bind(...params: unknown[]) {
          return {
            all: async () => ({
              results: stmt.all(...(params as never[])),
              success: true,
              meta: {},
            }),
            raw: async () => stmt.values(...(params as never[])),
          };
        },
      };
    },
    batch: async () => {
      throw new Error("batch is not used in stage 1");
    },
    // Safety: the fake implements the two members the layer calls (`prepare`, `batch`);
    // `D1QueryClient` is the wider `Pick` the session shim names.
  } as unknown as D1QueryClient;
}

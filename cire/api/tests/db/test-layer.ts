import { Layer, Effect } from "effect";

import { DbService } from "../../src/db/index";
import { createDb, seedDb } from "../../src/db/setup";

export const TestDbLayer = Layer.scoped(
  DbService,
  Effect.sync(() => {
    const db = createDb(":memory:");
    seedDb(db);
    return db;
  }),
);

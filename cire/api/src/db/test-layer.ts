import { Layer, Effect } from "effect";

import { DbService } from "./index";
import { createDb, seedDb } from "./setup";

export const TestDbLayer = Layer.scoped(
  DbService,
  Effect.sync(() => {
    const db = createDb(":memory:");
    seedDb(db);
    return db;
  }),
);

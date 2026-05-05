import { Layer, Effect } from "effect";
import { DbService } from "./index";
import { createDb, seedDb } from "./setup";

export const TestDbLayer = Layer.scoped(
  DbService,
  Effect.gen(function* () {
    const db = createDb(":memory:");
    yield* Effect.promise(() => seedDb(db));
    return db;
  }),
);

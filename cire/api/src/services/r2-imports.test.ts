import { describe, it, expect } from "bun:test";

import { Effect, Layer } from "effect";

import { R2Service, createR2Stub, fetchUpload, storeUpload, R2Error } from "./r2-imports";

describe("R2Service (in-memory stub)", () => {
  it("stores and fetches an uploaded events.csv + guests.csv pair", async () => {
    const stub = createR2Stub();
    const layer = Layer.succeed(R2Service, stub);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const keys = yield* storeUpload("events,csv\n", "guests,csv\n", "import-abc");
        const events = yield* fetchUpload(keys.eventsKey);
        const guests = yield* fetchUpload(keys.guestsKey);
        return { keys, events, guests };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.keys.eventsKey).toBe("imports/import-abc/events.csv");
    expect(result.keys.guestsKey).toBe("imports/import-abc/guests.csv");
    expect(result.events).toBe("events,csv\n");
    expect(result.guests).toBe("guests,csv\n");
    expect(stub._store.size).toBe(2);
  });

  it("fails with R2Error when the key is missing", async () => {
    const stub = createR2Stub();
    const layer = Layer.succeed(R2Service, stub);

    const error = await Effect.runPromise(
      Effect.flip(fetchUpload("imports/missing/events.csv")).pipe(Effect.provide(layer)),
    );
    expect(error).toBeInstanceOf(R2Error);
  });
});

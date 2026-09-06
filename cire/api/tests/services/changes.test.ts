import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID } from "@cire/db";
import { Effect, Either } from "effect";

import { decodeChangeBody } from "../../src/services/changes";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";

const withDb = effWith(TestDbLayer);

describe("decodeChangeBody: editor scope", () => {
  it(
    "a desiredState body carrying scope: 'events' decodes to scope: 'events'",
    withDb(
      Effect.gen(function* () {
        const decoded = yield* decodeChangeBody(
          { desiredState: { events: [], families: [] }, scope: "events" },
          BOOTSTRAP_WEDDING_ID,
        );
        expect(decoded.scope).toBe("events");
        expect(decoded.kind).toBe("editor");
      }),
    ),
  );

  it(
    "a desiredState body omitting scope still decodes to scope: 'both'",
    withDb(
      Effect.gen(function* () {
        const decoded = yield* decodeChangeBody(
          { desiredState: { events: [], families: [] } },
          BOOTSTRAP_WEDDING_ID,
        );
        expect(decoded.scope).toBe("both");
        expect(decoded.kind).toBe("editor");
      }),
    ),
  );
  it(
    "a body carrying both a desiredState and a CSV slot is refused, not guessed at",
    withDb(
      Effect.gen(function* () {
        const result = yield* Effect.either(
          decodeChangeBody(
            {
              desiredState: { events: [], families: [] },
              guestsCsv: "Family ID,Family Name,Guest First Name,Guest Last Name\n1,A,B,C",
            },
            BOOTSTRAP_WEDDING_ID,
          ),
        );
        // Which door the union picks would otherwise hang on whether the
        // `desiredState` happened to parse, and the two doors apply opposite
        // `removeManual`/`matchByName` options.
        expect(Either.isLeft(result)).toBe(true);
      }),
    ),
  );

  it(
    "a desiredState body carrying an unknown scope is refused",
    withDb(
      Effect.gen(function* () {
        const result = yield* Effect.either(
          decodeChangeBody(
            { desiredState: { events: [], families: [] }, scope: "everything" },
            BOOTSTRAP_WEDDING_ID,
          ),
        );
        expect(Either.isLeft(result)).toBe(true);
      }),
    ),
  );
});

import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, imports, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Result } from "effect";

import { DbService } from "../../src/db";
import {
  clearedHalves,
  decodeChangeBody,
  GENESIS_REVISION,
  headRevision,
} from "../../src/services/changes";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";

const withDb = effWith(TestDbLayer);

/** The fields every editor body carries besides its draft. */
const EDITOR = { removeManual: true, baseRevision: GENESIS_REVISION } as const;

describe("decodeChangeBody: editor scope", () => {
  it(
    "a desiredState body carrying scope: 'events' decodes to scope: 'events'",
    withDb(
      Effect.gen(function* () {
        const decoded = yield* decodeChangeBody(
          { desiredState: { events: [], families: [] }, scope: "events", ...EDITOR },
          BOOTSTRAP_WEDDING_ID,
        );
        expect(decoded.scope).toBe("events");
        expect(decoded.kind).toBe("editor");
      }),
    ),
  );

  it(
    "a desiredState body carrying scope: 'guests' decodes to scope: 'guests'",
    withDb(
      Effect.gen(function* () {
        const decoded = yield* decodeChangeBody(
          { desiredState: { events: [], families: [] }, scope: "guests", ...EDITOR },
          BOOTSTRAP_WEDDING_ID,
        );
        expect(decoded.scope).toBe("guests");
      }),
    ),
  );

  it(
    "a desiredState body omitting scope still decodes to scope: 'both'",
    withDb(
      Effect.gen(function* () {
        const decoded = yield* decodeChangeBody(
          { desiredState: { events: [], families: [] }, ...EDITOR },
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
        const result = yield* Effect.result(
          decodeChangeBody(
            {
              desiredState: { events: [], families: [] },
              ...EDITOR,
              guestsCsv: "Family ID,Family Name,Guest First Name,Guest Last Name\n1,A,B,C",
            },
            BOOTSTRAP_WEDDING_ID,
          ),
        );
        // Which door the union picks would otherwise hang on whether the
        // `desiredState` happened to parse, and the two doors apply opposite
        // `removeManual`/`matchByName` options.
        expect(Result.isFailure(result)).toBe(true);
      }),
    ),
  );

  it(
    "a desiredState body carrying an unknown scope is refused",
    withDb(
      Effect.gen(function* () {
        const result = yield* Effect.result(
          decodeChangeBody(
            { desiredState: { events: [], families: [] }, scope: "everything", ...EDITOR },
            BOOTSTRAP_WEDDING_ID,
          ),
        );
        expect(Result.isFailure(result)).toBe(true);
      }),
    ),
  );
});

describe("decodeChangeBody: the editor body states its contract", () => {
  it(
    "decodes removeManual and baseRevision from the body",
    withDb(
      Effect.gen(function* () {
        const decoded = yield* decodeChangeBody(
          {
            desiredState: { events: [], families: [] },
            scope: "guests",
            removeManual: true,
            baseRevision: "rev_loaded",
          },
          BOOTSTRAP_WEDDING_ID,
        );
        expect(decoded.removeManual).toBe(true);
        expect(decoded.baseRevision).toBe("rev_loaded");
        expect(decoded.matchByName).toBe(false);
      }),
    ),
  );

  // Each of these is a draft whose author did not say what it was built on, or
  // asked for something the editor door never does. None may fall through to
  // the spreadsheet door (which needs a sheet), so each is refused outright.
  for (const [label, body] of [
    ["without baseRevision", { removeManual: true }],
    ["without removeManual", { baseRevision: GENESIS_REVISION }],
    ["with removeManual: false", { removeManual: false, baseRevision: GENESIS_REVISION }],
  ] as const) {
    it(
      `refuses a draft ${label}`,
      withDb(
        Effect.gen(function* () {
          const result = yield* Effect.result(
            decodeChangeBody(
              { desiredState: { events: [], families: [] }, scope: "guests", ...body },
              BOOTSTRAP_WEDDING_ID,
            ),
          );
          expect(Result.isFailure(result)).toBe(true);
        }),
      ),
    );
  }

  it(
    "a spreadsheet upload carries no base revision",
    withDb(
      Effect.gen(function* () {
        const decoded = yield* decodeChangeBody(
          {
            eventsCsv:
              "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL\nMehndi,2026-09-18T16:00:00+10:00,,Australia/Sydney,,,,,,",
          },
          BOOTSTRAP_WEDDING_ID,
        );
        expect(decoded.kind).toBe("import");
        expect(decoded.baseRevision).toBeNull();
      }),
    ),
  );
});

describe("clearedHalves", () => {
  const plan = (eventRemoves: number, familyRemoves: number) => ({
    eventRemoves: Array.from({ length: eventRemoves }, (_, i) => ({ id: `e${i}`, name: "E" })),
    familyRemoves: Array.from({ length: familyRemoves }, (_, i) => ({
      id: `f${i}`,
      familyName: "F",
    })),
  });
  const EVENT = {
    name: "Mehndi",
    startAt: "2026-09-18T16:00:00+10:00",
    endAt: "",
    timezone: "Australia/Sydney",
    location: null,
    address: null,
    dressCodeDescription: null,
    dressCodePalette: [],
    pinterestUrl: null,
    mapsUrl: null,
    sortOrder: 0,
  };
  const FAMILY = { familyName: "Sharma", guests: [] };

  it("counts every household an empty guest half removes", () => {
    expect(clearedHalves({ events: [EVENT], families: [] }, plan(0, 3), "guests")).toEqual({
      events: 0,
      households: 3,
    });
  });

  it("counts every event an empty schedule removes", () => {
    expect(clearedHalves({ events: [], families: [] }, plan(2, 0), "events")).toEqual({
      events: 2,
      households: 0,
    });
  });

  it("is null when the emptied half had nothing in it", () => {
    expect(clearedHalves({ events: [EVENT], families: [] }, plan(0, 0), "guests")).toBeNull();
  });

  it("is null when the draft still populates the half it removes from", () => {
    // Removing some households is an ordinary edit; only removing ALL of them
    // is the case that needs confirming.
    expect(clearedHalves({ events: [EVENT], families: [FAMILY] }, plan(0, 2), "guests")).toBeNull();
  });

  it("ignores the half the scope does not manage", () => {
    // An events save carries no households at all, and that is not a removal —
    // even with removals in the other half's slot, only the scope decides.
    expect(clearedHalves({ events: [EVENT], families: [] }, plan(0, 3), "events")).toBeNull();
    expect(clearedHalves({ events: [], families: [FAMILY] }, plan(3, 0), "guests")).toBeNull();
  });

  it("reports both halves on a 'both' save that empties both", () => {
    expect(clearedHalves({ events: [], families: [] }, plan(1, 4), "both")).toEqual({
      events: 1,
      households: 4,
    });
  });
});

describe("headRevision", () => {
  /** Record a committed change row the way apply does. */
  function commit(id: string, at: number) {
    return Effect.gen(function* () {
      const db = yield* DbService;
      db.insert(imports)
        .values({
          id,
          weddingId: BOOTSTRAP_WEDDING_ID,
          uploadedAt: at,
          format: "csv",
          eventsR2Key: `imports/${id}/events.csv`,
          guestsR2Key: `imports/${id}/guests.csv`,
          summary: "{}",
          status: "applied",
          appliedAt: at,
        })
        .run();
    });
  }

  function revert(id: string, at: number) {
    return Effect.gen(function* () {
      const db = yield* DbService;
      db.update(imports)
        .set({ status: "reverted", revertedAt: at })
        .where(eq(imports.id, id))
        .run();
    });
  }

  it(
    "is genesis until a change commits, and a preview row does not count",
    withDb(
      Effect.gen(function* () {
        expect(yield* headRevision(BOOTSTRAP_WEDDING_ID)).toBe(GENESIS_REVISION);
        const db = yield* DbService;
        db.insert(imports)
          .values({
            id: "chg_preview",
            weddingId: BOOTSTRAP_WEDDING_ID,
            uploadedAt: 1_000,
            format: "csv",
            eventsR2Key: "k",
            guestsR2Key: "k",
            summary: "{}",
            status: "preview",
          })
          .run();
        expect(yield* headRevision(BOOTSTRAP_WEDDING_ID)).toBe(GENESIS_REVISION);
      }),
    ),
  );

  it(
    "moves when a change commits",
    withDb(
      Effect.gen(function* () {
        yield* commit("chg_1", 1_000);
        const first = yield* headRevision(BOOTSTRAP_WEDDING_ID);
        expect(first).not.toBe(GENESIS_REVISION);
        yield* commit("chg_2", 2_000);
        expect(yield* headRevision(BOOTSTRAP_WEDDING_ID)).not.toBe(first);
      }),
    ),
  );

  it(
    "moves when the NEWEST change is reverted — the row that was the head stays the head",
    withDb(
      Effect.gen(function* () {
        yield* commit("chg_1", 1_000);
        yield* commit("chg_2", 2_000);
        const before = yield* headRevision(BOOTSTRAP_WEDDING_ID);
        yield* revert("chg_2", 3_000);
        expect(yield* headRevision(BOOTSTRAP_WEDDING_ID)).not.toBe(before);
      }),
    ),
  );

  it(
    "moves when a revert commits with an OLDER timestamp than the head",
    withDb(
      Effect.gen(function* () {
        // A revert stamps `revertedAt` before its write set commits, so one that
        // started before a concurrent apply can land after it carrying the
        // earlier time. A newest-row token would not move; the wedding did.
        yield* commit("chg_1", 1_000);
        yield* commit("chg_2", 5_000);
        const before = yield* headRevision(BOOTSTRAP_WEDDING_ID);
        yield* revert("chg_1", 4_000);
        expect(yield* headRevision(BOOTSTRAP_WEDDING_ID)).not.toBe(before);
      }),
    ),
  );

  it(
    "moves when a change commits in the same millisecond as the head",
    withDb(
      Effect.gen(function* () {
        yield* commit("chg_1", 1_000);
        const before = yield* headRevision(BOOTSTRAP_WEDDING_ID);
        yield* commit("chg_2", 1_000);
        expect(yield* headRevision(BOOTSTRAP_WEDDING_ID)).not.toBe(before);
      }),
    ),
  );

  it(
    "ignores another wedding's changes",
    withDb(
      Effect.gen(function* () {
        yield* commit("chg_1", 1_000);
        const before = yield* headRevision(BOOTSTRAP_WEDDING_ID);
        const db = yield* DbService;
        db.insert(weddings)
          .values({
            id: "wed_elsewhere",
            slug: "elsewhere",
            displayName: "Elsewhere",
            ownerOsnProfileId: "usr_elsewhere",
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .run();
        db.insert(imports)
          .values({
            id: "chg_elsewhere",
            weddingId: "wed_elsewhere",
            uploadedAt: 2_000,
            format: "csv",
            eventsR2Key: "k",
            guestsR2Key: "k",
            summary: "{}",
            status: "applied",
            appliedAt: 2_000,
          })
          .run();
        expect(yield* headRevision(BOOTSTRAP_WEDDING_ID)).toBe(before);
      }),
    ),
  );

  it(
    "is stable while nothing commits",
    withDb(
      Effect.gen(function* () {
        yield* commit("chg_b", 2_000);
        yield* commit("chg_a", 1_000);
        const first = yield* headRevision(BOOTSTRAP_WEDDING_ID);
        expect(yield* headRevision(BOOTSTRAP_WEDDING_ID)).toBe(first);
      }),
    ),
  );
});

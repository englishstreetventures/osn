import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, imports, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Result } from "effect";

import { DbService } from "../../src/db";
import {
  ChangeConflict,
  CLAIM_TTL_MS,
  claimChanges,
  clearedHalves,
  commitClaimStatement,
  committedRevision,
  decodeChangeBody,
  headRevision,
  releaseClaim,
  underClaim,
} from "../../src/services/changes";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";

const withDb = effWith(TestDbLayer);

/** The fields every editor body carries besides its draft. */
const EDITOR = { removeManual: true, baseRevision: "0" } as const;

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
    ["without removeManual", { baseRevision: "0" }],
    ["with removeManual: false", { removeManual: false, baseRevision: "0" }],
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

describe("headRevision and the change claim", () => {
  const W = BOOTSTRAP_WEDDING_ID;

  /** Claim at the current head and commit, the way apply and revert end. */
  function commitOne() {
    return Effect.gen(function* () {
      const claim = yield* claimChanges(W, yield* headRevision(W));
      const db = yield* DbService;
      yield* Effect.promise(async () => {
        await commitClaimStatement(db, claim);
      });
      return claim;
    });
  }

  function claimState() {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* Effect.promise(async () =>
        db
          .select({ claim: weddings.changeClaim, at: weddings.changeClaimedAt })
          .from(weddings)
          .where(eq(weddings.id, W))
          .all(),
      );
      return rows[0]!;
    });
  }

  it(
    "is 0 on a new wedding, and a preview row does not move it",
    withDb(
      Effect.gen(function* () {
        expect(yield* headRevision(W)).toBe("0");
        const db = yield* DbService;
        db.insert(imports)
          .values({
            id: "chg_preview",
            weddingId: W,
            uploadedAt: 1_000,
            format: "csv",
            eventsR2Key: "k",
            guestsR2Key: "k",
            summary: "{}",
            status: "preview",
          })
          .run();
        expect(yield* headRevision(W)).toBe("0");
      }),
    ),
  );

  it(
    "moves one on each committed change, and the committed revision says so",
    withDb(
      Effect.gen(function* () {
        const first = yield* commitOne();
        expect(yield* headRevision(W)).toBe("1");
        expect(committedRevision(first)).toBe("1");
        yield* commitOne();
        expect(yield* headRevision(W)).toBe("2");
        expect((yield* claimState()).claim).toBeNull();
      }),
    ),
  );

  it(
    "gives the wedding to exactly one of two changes prepared against the same head",
    withDb(
      Effect.gen(function* () {
        const head = yield* headRevision(W);
        yield* claimChanges(W, head);
        const second = yield* Effect.flip(claimChanges(W, head));
        expect(second).toBeInstanceOf(ChangeConflict);
        expect(second.reason).toBe("in_progress");
      }),
    ),
  );

  it(
    "refuses a claim at a head that has since moved",
    withDb(
      Effect.gen(function* () {
        const stale = yield* headRevision(W);
        yield* commitOne();
        const refused = yield* Effect.flip(claimChanges(W, stale));
        expect(refused.reason).toBe("moved");
      }),
    ),
  );

  it.each(["genesis", "01", " 1", "1e0", "", "a".repeat(64)])(
    "refuses a revision no head ever was (%j)",
    (revision) =>
      withDb(
        Effect.gen(function* () {
          const refused = yield* Effect.flip(claimChanges(W, revision));
          expect(refused.reason).toBe("moved");
          expect((yield* claimState()).claim).toBeNull();
        }),
      )(),
  );

  it(
    "a release after a failure that wrote nothing leaves the head where it was",
    withDb(
      Effect.gen(function* () {
        const claim = yield* claimChanges(W, "0");
        yield* releaseClaim(claim, false);
        expect(yield* headRevision(W)).toBe("0");
        // The same preview can be confirmed again.
        yield* claimChanges(W, "0");
      }),
    ),
  );

  it(
    "a release after a failure that may have written moves the head",
    withDb(
      Effect.gen(function* () {
        const claim = yield* claimChanges(W, "0");
        yield* releaseClaim(claim, true);
        expect(yield* headRevision(W)).toBe("1");
        expect((yield* claimState()).claim).toBeNull();
      }),
    ),
  );

  it(
    "underClaim moves the head only for a failure it cannot place before the writes",
    withDb(
      Effect.gen(function* () {
        const early = yield* claimChanges(W, "0");
        const failWith = (tag: "Early" | "Late") => Effect.fail({ _tag: tag });
        yield* Effect.flip(underClaim(early, failWith("Early"), (e) => e._tag === "Early"));
        expect(yield* headRevision(W)).toBe("0");

        const late = yield* claimChanges(W, "0");
        yield* Effect.flip(underClaim(late, failWith("Late"), (e) => e._tag === "Early"));
        expect(yield* headRevision(W)).toBe("1");

        const dead = yield* claimChanges(W, "1");
        yield* Effect.exit(underClaim(dead, Effect.die("boom"), () => true));
        expect(yield* headRevision(W)).toBe("2");
        expect((yield* claimState()).claim).toBeNull();
      }),
    ),
  );

  it(
    "expires a claim whose holder died, moving the head, and tells the caller it moved",
    withDb(
      Effect.gen(function* () {
        yield* claimChanges(W, "0");
        const db = yield* DbService;
        db.update(weddings)
          .set({ changeClaimedAt: Date.now() - CLAIM_TTL_MS - 1 })
          .where(eq(weddings.id, W))
          .run();

        const refused = yield* Effect.flip(claimChanges(W, "0"));
        expect(refused.reason).toBe("moved");
        expect(yield* headRevision(W)).toBe("1");
        expect((yield* claimState()).claim).toBeNull();
        // A draft re-read at the new head can now take the wedding.
        yield* claimChanges(W, "1");
      }),
    ),
  );

  it(
    "the commit statement fails, and moves nothing, when the claim is no longer this change's",
    withDb(
      Effect.gen(function* () {
        const claim = yield* claimChanges(W, "0");
        const db = yield* DbService;
        db.update(weddings).set({ changeClaim: "someone-else" }).where(eq(weddings.id, W)).run();
        const failed = yield* Effect.exit(
          Effect.tryPromise(async () => {
            await commitClaimStatement(db, claim);
          }),
        );
        expect(failed._tag).toBe("Failure");
        expect(yield* headRevision(W)).toBe("0");
        expect((yield* claimState()).claim).toBe("someone-else");
      }),
    ),
  );

  it(
    "ignores another wedding's changes",
    withDb(
      Effect.gen(function* () {
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
        const claim = yield* claimChanges("wed_elsewhere", "0");
        yield* Effect.promise(async () => {
          await commitClaimStatement(db, claim);
        });
        expect(yield* headRevision("wed_elsewhere")).toBe("1");
        expect(yield* headRevision(W)).toBe("0");
        // And a claim on one wedding does not hold another.
        yield* claimChanges(W, "0");
      }),
    ),
  );
});

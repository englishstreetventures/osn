import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, families } from "@cire/db";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../db";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import { claimService } from "./claim";
import { hostCodeService, HostCodeError } from "./host-code";

const withDb = effWith(TestDbLayer);

describe("hostCodeService.ensureForWedding", () => {
  it(
    "mints a HOST-* code and links the host guest to every event",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const { publicId, slug } = yield* hostCodeService.ensureForWedding(BOOTSTRAP_WEDDING_ID);
        expect(publicId).toMatch(/^HOST-[A-F0-9]{32}$/);
        // Returns the wedding slug for the path-routed preview link.
        expect(slug).toBe("cire-wedding");

        const allEvents = yield* claimService.listEvents(BOOTSTRAP_WEDDING_ID);
        const claimed = yield* claimService.lookup(publicId);
        expect(claimed.preview).toBe(true);
        expect(claimed.events.map((e) => e.id).toSorted()).toEqual(
          allEvents.map((e) => e.id).toSorted(),
        );

        // Exactly one host family exists for the wedding.
        const hostFamilies = yield* Effect.promise(() =>
          Promise.resolve(
            db
              .select()
              .from(families)
              .where(and(eq(families.weddingId, BOOTSTRAP_WEDDING_ID), eq(families.kind, "host")))
              .all(),
          ),
        );
        expect(hostFamilies).toHaveLength(1);
      }),
    ),
  );

  it(
    "is idempotent — repeated calls reuse the same code and host family",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const first = yield* hostCodeService.ensureForWedding(BOOTSTRAP_WEDDING_ID);
        const second = yield* hostCodeService.ensureForWedding(BOOTSTRAP_WEDDING_ID);
        expect(second.publicId).toBe(first.publicId);

        const hostFamilies = yield* Effect.promise(() =>
          Promise.resolve(
            db
              .select()
              .from(families)
              .where(and(eq(families.weddingId, BOOTSTRAP_WEDDING_ID), eq(families.kind, "host")))
              .all(),
          ),
        );
        expect(hostFamilies).toHaveLength(1);
      }),
    ),
  );

  it(
    "re-links events added after the host family was created",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const { publicId } = yield* hostCodeService.ensureForWedding(BOOTSTRAP_WEDDING_ID);

        // A new event lands (e.g. via a later spreadsheet import).
        yield* Effect.promise(() =>
          Promise.resolve(
            db
              .insert(events)
              .values({
                id: "evt_after_host",
                weddingId: BOOTSTRAP_WEDDING_ID,
                slug: "after-host",
                name: "Afterparty",
                description: "",
                startAt: "2027-02-02T20:00:00+10:00",
                endAt: "2027-02-03T02:00:00+10:00",
                timezone: "Australia/Sydney",
                sortOrder: 99,
              })
              .run(),
          ),
        );

        // Before re-ensuring, the host doesn't see it yet.
        const before = yield* claimService.lookup(publicId);
        expect(before.events.some((e) => e.id === "evt_after_host")).toBe(false);

        yield* hostCodeService.ensureForWedding(BOOTSTRAP_WEDDING_ID);
        const after = yield* claimService.lookup(publicId);
        expect(after.events.some((e) => e.id === "evt_after_host")).toBe(true);
      }),
    ),
  );

  it("fails with HostCodeError when a DB write throws", async () => {
    // A Db whose reads pass through to a seeded DB but whose writes throw, so
    // the family insert fails inside the service's `write` wrapper.
    const real = createDb(":memory:");
    seedDb(real);
    const failing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "insert") {
          return () => {
            throw new Error("simulated write failure");
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as unknown as Db;

    const error = await Effect.runPromise(
      hostCodeService
        .ensureForWedding(BOOTSTRAP_WEDDING_ID)
        .pipe(Effect.provideService(DbService, failing), Effect.flip),
    );
    expect(error).toBeInstanceOf(HostCodeError);
    expect(error.reason).toBe("insert family");
  });
});

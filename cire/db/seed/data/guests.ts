// Canonical dev/test seed families + guests — the SINGLE source of truth.
// Consumed two ways, both derived from THIS module:
//   - cire/api/src/db/setup.ts#seedDb reads it for the in-memory test seed. It
//     mints fresh family/guest row ids per run (crypto.randomUUID), so the
//     `id` fields below are NOT used there — they exist only so the local-D1
//     seed can pin stable UUIDs (dev claim links don't drift between seeds).
//   - cire/db/seed/generate.ts derives seed/dev-seed.sql from it, emitting the
//     stable `id`s below; cire/db/seed/seed.test.ts fails CI if the committed
//     SQL drifts. Keep the VALUES byte-identical — existing tests assert them.

export type SeedGuest = {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  // Event ids this guest is invited to (FKs into events.ts).
  readonly events: readonly string[];
};

export type SeedFamily = {
  readonly id: string;
  readonly publicId: string;
  readonly familyName: string;
  readonly guests: readonly SeedGuest[];
};

export const guests = [
  {
    id: "a0000000-0000-4000-8000-000000000001",
    publicId: "TESTONE-IVY-AA11",
    familyName: "Testfamily",
    guests: [
      {
        id: "b0000000-0000-4000-8000-000000000001",
        firstName: "Ada",
        lastName: "Testfamily",
        // catholic + hindu + reception
        events: [
          "9f7a2c14-1b3d-4e5f-8a01-000000000001",
          "9f7a2c14-1b3d-4e5f-8a01-000000000003",
          "9f7a2c14-1b3d-4e5f-8a01-000000000004",
        ],
      },
    ],
  },
  {
    id: "a0000000-0000-4000-8000-000000000002",
    publicId: "TESTTWO-OAK-BB22",
    familyName: "Sampleton",
    guests: [
      {
        id: "b0000000-0000-4000-8000-000000000002",
        firstName: "Bo",
        lastName: "Sampleton",
        // hindu + reception
        events: ["9f7a2c14-1b3d-4e5f-8a01-000000000003", "9f7a2c14-1b3d-4e5f-8a01-000000000004"],
      },
      {
        id: "b0000000-0000-4000-8000-000000000003",
        firstName: "Cleo",
        lastName: "Sampleton",
        // hindu + reception
        events: ["9f7a2c14-1b3d-4e5f-8a01-000000000003", "9f7a2c14-1b3d-4e5f-8a01-000000000004"],
      },
      {
        id: "b0000000-0000-4000-8000-000000000004",
        firstName: "Dot",
        lastName: "Sampleton",
        // hindu only
        events: ["9f7a2c14-1b3d-4e5f-8a01-000000000003"],
      },
    ],
  },
  {
    id: "a0000000-0000-4000-8000-000000000003",
    publicId: "TESTTRE-DEW-CC33",
    familyName: "Exampleton",
    guests: [
      {
        id: "b0000000-0000-4000-8000-000000000005",
        firstName: "Nori",
        lastName: "Exampleton",
        // catholic + hindu
        events: ["9f7a2c14-1b3d-4e5f-8a01-000000000001", "9f7a2c14-1b3d-4e5f-8a01-000000000003"],
      },
    ],
  },
  {
    id: "a0000000-0000-4000-8000-000000000004",
    publicId: "TESTFOR-JOY-DD44",
    familyName: "Placeholder",
    guests: [
      {
        id: "b0000000-0000-4000-8000-000000000006",
        firstName: "Eli",
        lastName: "Placeholder",
        // all five (default demo code — exercises every event)
        events: [
          "9f7a2c14-1b3d-4e5f-8a01-000000000001",
          "9f7a2c14-1b3d-4e5f-8a01-000000000002",
          "9f7a2c14-1b3d-4e5f-8a01-000000000003",
          "9f7a2c14-1b3d-4e5f-8a01-000000000004",
          "9f7a2c14-1b3d-4e5f-8a01-000000000005",
        ],
      },
    ],
  },
] as const satisfies readonly SeedFamily[];

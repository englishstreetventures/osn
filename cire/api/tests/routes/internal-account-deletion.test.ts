import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime } from "bun:test";

import {
  hostRsvpNotices,
  organiserSessions,
  registrySettings,
  weddingHosts,
  weddings,
} from "@cire/db";
import { generateArcKeyPair } from "@shared/crypto/jwk";
import {
  DELETION_RECORD_MAX_PROFILES,
  DELETION_RECORD_MAX_SEATS,
  type DeletionRecord,
  type DeletionRecordStore,
  DeletionRecordWriteError,
  memoryDeletionRecordStore,
  missingDeletionRecordStore,
} from "@shared/db-utils/deletion-records";
import { makeLogEmailLive } from "@shared/email";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { AppOptions } from "../../src/app";
import { createApp } from "../../src/app";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import {
  MAX_LOWER_SEATS_PER_CALL,
  MAX_OWNED_WEDDINGS_PER_CALL,
} from "../../src/services/account-erasure";
import {
  appRequest,
  beforeStatement,
  failAfterRunning,
  failStatements,
  jsonBody,
} from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { captureSpans } from "../test-helpers/capture-spans";
import { counterValue } from "../test-helpers/metrics-harness";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { KID_SECRET, OSN_HOLDS, OSN_ISSUER, osnArc } from "../test-helpers/osn-arc";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";

/**
 * osn-api's two account-deletion calls on cire-api: who may make them and
 * what they refuse.
 */

const PREVIEW = "/internal/account-deletion-preview";
const ERASE = "/internal/account-deleted";
const PORTAL = "https://host.example.test";
const P = "usr_erased";
const OTHER = "usr_other_owner";
const EDITOR = "usr_editor";

let arc: Awaited<ReturnType<typeof osnArc>>;
let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});
beforeEach(async () => {
  arc = await osnArc();
});
afterEach(() => {
  arc.restore();
  setSystemTime();
});

function setup(
  owners: readonly string[] = [P, OTHER],
  osnArcKidSecret?: string,
  deletionRecords: DeletionRecordStore = memoryDeletionRecordStore(),
  extra: Partial<AppOptions> = {},
) {
  const db = createDb(":memory:");
  insertWedding(db, { id: "w1", slug: "slug-w1", displayName: "Ama & Jonah", owners });
  db.insert(weddingHosts)
    .values({
      id: "whost_editor",
      weddingId: "w1",
      osnProfileId: EDITOR,
      addedByOsnProfileId: P,
      role: "editor",
      createdAt: new Date(),
    })
    .run();
  const app = createApp(db, {
    deletionRecords,
    osnIssuerUrl: OSN_ISSUER,
    osnTestKey: auth.key,
    organiserOrigin: PORTAL,
    osnArcKidSecret,
    ...extra,
  });
  return { db, app };
}

const post = (
  app: ReturnType<typeof createApp>,
  path: string,
  authorization: string | null,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  appRequest(app, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const previewBody = { profileIds: [P], deletesAt: Math.floor(Date.now() / 1000) };
const eraseBody = {
  accountId: "acc_erased",
  profileIds: [P],
  choices: {},
  deleteEverything: false,
};

const untouched = (db: TestDb) =>
  db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, P)).all().length === 1;

describe("ARC on the account-deletion calls (refusals)", () => {
  it("no token is refused, and nothing is written", async () => {
    const { db, app } = setup();
    for (const [path, body] of [
      [PREVIEW, previewBody],
      [ERASE, eraseBody],
    ] as const) {
      const res = await post(app, path, null, body);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
    expect(untouched(db)).toBe(true);
  });

  it("a token from an issuer other than osn-api is refused", async () => {
    const { db, app } = setup();
    const res = await post(
      app,
      ERASE,
      await arc.token("account:erase", { iss: "zap-api" }),
      eraseBody,
    );
    expect(res.status).toBe(401);
    expect(untouched(db)).toBe(true);
  });

  it("a token for another app's audience is refused", async () => {
    const { db, app } = setup();
    const res = await post(
      app,
      ERASE,
      await arc.token("account:erase", { aud: "zap-api" }),
      eraseBody,
    );
    expect(res.status).toBe(401);
    expect(untouched(db)).toBe(true);
  });

  it("each call needs its own scope", async () => {
    const { db, app } = setup();
    const erase = await post(app, ERASE, await arc.token("account:deletion-preview"), eraseBody);
    expect(erase.status).toBe(401);
    const preview = await post(app, PREVIEW, await arc.token("account:erase"), previewBody);
    expect(preview.status).toBe(401);
    expect(untouched(db)).toBe(true);
  });

  it("with no kid secret, refuses a made-up kid, and remembers it as unknown", async () => {
    const { app } = setup();
    const madeUp = await arc.token("account:erase", { kid: "made-up-kid" });
    expect((await post(app, ERASE, madeUp, eraseBody)).status).toBe(401);
    expect((await post(app, ERASE, madeUp, eraseBody)).status).toBe(401);
    expect(arc.fetches()).toBe(1);
  });

  it("a token signed by another key under osn-api's published kid is refused", async () => {
    const { db, app } = setup();
    const other = await generateArcKeyPair();
    const forged = await arc.token("account:erase", { signWith: other.privateKey });
    expect((await post(app, ERASE, forged, eraseBody)).status).toBe(401);
    expect(untouched(db)).toBe(true);
  });

  it("an expired token is refused", async () => {
    const { db, app } = setup();
    const token = await arc.token("account:erase", { ttl: 1 });
    setSystemTime(new Date(Date.now() + 10 * 60 * 1000));
    expect((await post(app, ERASE, token, eraseBody)).status).toBe(401);
    expect(untouched(db)).toBe(true);
  });

  it("a valid token sent as a Bearer token is refused", async () => {
    const { db, app } = setup();
    const bearer = (await arc.token("account:erase")).replace(/^ARC /, "Bearer ");
    expect((await post(app, ERASE, bearer, eraseBody)).status).toBe(401);
    expect(untouched(db)).toBe(true);
  });

  const badProfileIds: ReadonlyArray<readonly string[]> = [
    ["not-a-profile"],
    ["xusr_a"],
    ["usr_a-b"],
    Array.from({ length: 101 }, (_, i) => `usr_${i}`),
  ];

  it("an erasure body outside the contract is refused before anything is written", async () => {
    const { db, app } = setup();
    const token = await arc.token("account:erase");
    for (const body of [
      "{not json",
      ...badProfileIds.map((profileIds) => ({ ...eraseBody, profileIds })),
      { ...eraseBody, accountId: "" },
      { ...eraseBody, choices: { "cire:wedding:w1": { choice: "x".repeat(33) } } },
      {
        ...eraseBody,
        choices: Object.fromEntries(
          Array.from({ length: 501 }, (_, i) => [`a${i}`, { choice: "delete" }]),
        ),
      },
    ]) {
      const res = await post(app, ERASE, token, body);
      expect({ body: JSON.stringify(body).slice(0, 60), status: res.status }).toEqual({
        body: JSON.stringify(body).slice(0, 60),
        status: 400,
      });
    }
    expect(untouched(db)).toBe(true);
  });

  it("five hundred answers are within the contract", async () => {
    const { app } = setup();
    const choices = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`a${i}`, { choice: "delete" }]),
    );
    const res = await post(app, ERASE, await arc.token("account:erase"), {
      ...eraseBody,
      choices,
    });
    expect(res.status).toBe(200);
  });

  it("a preview body outside the contract is refused", async () => {
    const { app } = setup();
    const token = await arc.token("account:deletion-preview");
    const { deletesAt } = previewBody;
    for (const body of [
      "{not json",
      ...badProfileIds.map((profileIds) => ({ profileIds, deletesAt })),
      { profileIds: [P] },
      { profileIds: [P], deletesAt: 1.5 },
      { profileIds: [P], deletesAt: -1 },
      { profileIds: [P], deletesAt: 32_503_680_001 },
      { deletesAt },
    ]) {
      const res = await post(app, PREVIEW, token, body);
      expect({ body: JSON.stringify(body).slice(0, 60), status: res.status }).toEqual({
        body: JSON.stringify(body).slice(0, 60),
        status: 400,
      });
      expect(await jsonBody(res)).toEqual({ error: "invalid_request" });
    }
  });

  it("osn-api's calls carry no browser Origin, and the origin guard does not stand in their way", async () => {
    const { app } = setup();
    const token = await arc.token("account:deletion-preview");
    const res = await post(app, PREVIEW, token, previewBody, {
      origin: "https://elsewhere.example",
    });
    expect(res.status).toBe(200);
  });
});

const previews = (result: "ok" | "error") =>
  counterValue(CIRE_METRICS.accountDeletionPreviews, { result });
const erasures = (result: "done" | "not_finished" | "error") =>
  counterValue(CIRE_METRICS.accountDeletionErasures, { result });

/**
 * cire-api holding `OSN_ARC_KID_SECRET`: it refuses a kid with no MAC under
 * that secret before it fetches osn-api's key list, and never falls back to
 * admitting a kid it cannot check.
 */
describe("ARC on the account-deletion calls, with the kid secret", () => {
  const madeUpKids = (expiry: string) => [
    "made-up-kid",
    crypto.randomUUID(),
    `${crypto.randomUUID()}.${expiry}`,
    `${crypto.randomUUID()}.${expiry}.${"A".repeat(22)}`,
    `${crypto.randomUUID()}.${expiry}.${"A".repeat(22)}.${"A".repeat(22)}`,
  ];

  it("refuses made-up kids, published or not, on both calls, before any fetch", async () => {
    const { db, app } = setup([P, OTHER], KID_SECRET);
    const [, expiry = ""] = arc.kid.split(".");
    for (const kid of madeUpKids(expiry)) {
      for (const [path, scope, body] of [
        [PREVIEW, "account:deletion-preview", previewBody],
        [ERASE, "account:erase", eraseBody],
      ] as const) {
        const res = await post(app, path, await arc.tokenUnderKid(scope, kid), body);
        expect({ kid, path, status: res.status }).toEqual({ kid, path, status: 401 });
      }
    }
    expect(arc.fetches()).toBe(0);
    expect(untouched(db)).toBe(true);
  });

  it("admits osn-api's real key once osn-api holds the secret too, after one fetch", async () => {
    const { app } = setup([P, OTHER], KID_SECRET);
    const preview = await post(
      app,
      PREVIEW,
      await arc.token("account:deletion-preview"),
      previewBody,
    );
    expect(preview.status).toBe(200);
    expect(arc.fetches()).toBe(1);
  });

  it("refuses a key osn-api minted holding only the service secret, before any fetch", async () => {
    arc.restore();
    arc = await osnArc(OSN_HOLDS["the service secret"]);
    const { db, app } = setup([P, OTHER], KID_SECRET);
    const res = await post(app, ERASE, await arc.token("account:erase"), eraseBody);
    expect(res.status).toBe(401);
    expect(arc.fetches()).toBe(0);
    expect(untouched(db)).toBe(true);
  });

  it("without the secret, admits that key, as it admits any kid it cannot check", async () => {
    arc.restore();
    arc = await osnArc(OSN_HOLDS["the service secret"]);
    const { app } = setup();
    const res = await post(app, ERASE, await arc.token("account:erase"), eraseBody);
    expect(res.status).toBe(200);
  });
});

describe("the account-deletion calls", () => {
  it("preview answers the contract's shape: a wedding the person alone owns is an action", async () => {
    const { app } = setup([P]);
    const before = await previews("ok");
    const res = await post(app, PREVIEW, await arc.token("account:deletion-preview"), previewBody);
    expect(res.status).toBe(200);
    expect(await previews("ok")).toBe(before + 1);
    expect(await jsonBody(res)).toEqual({
      openActions: [
        {
          id: "cire:wedding:w1",
          kind: "wedding_sole_owner",
          label: expect.any(String),
          choices: [{ choice: "delete", description: expect.any(String), erasedOn: null }],
          defaultChoice: null,
          link: `${PORTAL}/#/w/w1/settings/export`,
        },
      ],
    });
  });

  it("preview lists each wedding whose payout account the person holds as an action that does not block, with the Express line only for an account cire made", async () => {
    const { db, app } = setup();
    for (const [id, type] of [
      ["w_null", null],
      ["w_express", "express"],
      ["w_standard", "standard"],
    ] as const) {
      insertWedding(db, { id, slug: `slug-${id}`, displayName: id, owners: [P, OTHER] });
      db.insert(registrySettings)
        .values({
          weddingId: id,
          stripeAccountId: `acct_${id}`,
          stripeAccountType: type,
          stripeConnectedByOsnProfileId: P,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
    }
    const res = await post(app, PREVIEW, await arc.token("account:deletion-preview"), previewBody);
    expect(res.status).toBe(200);
    const { openActions } = (await jsonBody(res)) as {
      openActions: {
        id: string;
        kind: string;
        choices: { choice: string; description: string; erasedOn: null }[];
        defaultChoice: string | null;
        link: string | null;
      }[];
    };
    expect(
      openActions.map((a) => ({
        id: a.id,
        kind: a.kind,
        choices: a.choices.map((c) => c.choice),
        defaultChoice: a.defaultChoice,
        link: a.link,
        express: a.choices[0]?.description.includes("connect.stripe.com/express_login"),
      })),
    ).toEqual(
      // Seats made in the same instant: by wedding id.
      (
        [
          ["w_express", true],
          ["w_null", true],
          ["w_standard", false],
        ] as const
      ).map(([id, express]) => ({
        id: `cire:payout:${id}`,
        kind: "wedding_payout_account",
        choices: ["close"],
        defaultChoice: "close",
        link: `${PORTAL}/#/w/${id}/registry/settings`,
        express,
      })),
    );
  });

  it("erase removes the person's seat from a wedding another owner keeps, and keeps nothing", async () => {
    const { db, app } = setup();
    const before = await erasures("done");
    const res = await post(app, ERASE, await arc.token("account:erase"), eraseBody);
    expect(res.status).toBe(200);
    expect(await erasures("done")).toBe(before + 1);
    expect(await jsonBody(res)).toEqual({ kept: [] });
    expect(db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, P)).all()).toEqual(
      [],
    );
  });

  it.each([
    ["answered delete", { choices: { "cire:wedding:w1": { choice: "delete" } } }],
    ["deleting everything", { deleteEverything: true }],
    ["with no answer stored", { choices: undefined, deleteEverything: undefined }],
    ["with an email address, which is ignored", { email: "person@example.test" }],
  ] as const)(
    "erase deletes a wedding the person alone owns, and keeps nothing, %s",
    async (_label, extra) => {
      const { db, app } = setup([P]);
      const res = await post(app, ERASE, await arc.token("account:erase"), {
        ...eraseBody,
        ...extra,
      });
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ kept: [] });
      const [row] = db.select().from(weddings).where(eq(weddings.id, "w1")).all();
      expect(row?.deletedAt).not.toBeNull();
    },
  );

  it("answers 503 not finished while weddings the person owns remain", async () => {
    const { db, app } = setup();
    for (let i = 0; i < 4; i += 1) {
      insertWedding(db, {
        id: `wx${i}`,
        slug: `slug-wx${i}`,
        displayName: `W${i}`,
        owners: [P, OTHER],
      });
    }
    const token = await arc.token("account:erase");
    const before = await erasures("not_finished");
    const first = await post(app, ERASE, token, eraseBody);
    expect(first.status).toBe(503);
    expect(await jsonBody(first)).toEqual({ error: "not_finished" });
    expect(await erasures("not_finished")).toBe(before + 1);
    const second = await post(app, ERASE, token, eraseBody);
    expect(second.status).toBe(200);
  });

  // osn-api reads any 2xx as cire finished and goes on to the hard delete, so
  // a failed batch must answer 500 for osn-api to call again.
  // Each case fails the first statement of one step: on bun:sqlite a batch is
  // not atomic, and on D1 a failed batch writes nothing.
  it.each([
    ["the read of owned weddings", /^select .* from "wedding_hosts"/i],
    ["a wedding's batch", /^update "weddings" set "deleted_at"/i],
    ["the account's clean-up", /^delete from "host_rsvp_notices" where .*NOT EXISTS/i],
  ])("a failure in %s answers 500, and the next call finishes", async (_step, pattern) => {
    const { db, app } = setup([P]);
    const token = await arc.token("account:erase");
    const failing = failStatements(db, (statement) => pattern.test(statement));
    const before = await erasures("error");
    const res = await post(app, ERASE, token, eraseBody);
    expect(res.status).toBe(500);
    expect(await jsonBody(res)).toEqual({ error: "internal_error" });
    expect(await erasures("error")).toBe(before + 1);
    expect(failing.failed()).toBeGreaterThan(0);

    failing.restore();
    expect((await post(app, ERASE, token, eraseBody)).status).toBe(200);
    expect(untouched(db)).toBe(false);
  });

  it("a failed preview answers 500", async () => {
    const { db, app } = setup([P]);
    failStatements(db, (statement) => /from "wedding_hosts"/i.test(statement));
    const before = await previews("error");
    const res = await post(app, PREVIEW, await arc.token("account:deletion-preview"), previewBody);
    expect(res.status).toBe(500);
    expect(await jsonBody(res)).toEqual({ error: "internal_error" });
    expect(await previews("error")).toBe(before + 1);
  });
});

describe("a seat the erased person created", () => {
  it("is listed with no adder, and nobody is looked up for it", async () => {
    const db = createDb(":memory:");
    insertWedding(db, { id: "w1", slug: "slug-w1", displayName: "W", owners: ["usr_owner"] });
    db.insert(weddingHosts)
      .values({
        id: "whost_editor",
        weddingId: "w1",
        osnProfileId: EDITOR,
        addedByOsnProfileId: P,
        role: "editor",
        createdAt: new Date(),
      })
      .run();
    // The owner seat stays named by its adder, whose handle resolves.
    db.update(weddingHosts)
      .set({ addedByOsnProfileId: OTHER })
      .where(eq(weddingHosts.osnProfileId, "usr_owner"))
      .run();
    const asked: string[] = [];
    const app = createApp(db, {
      deletionRecords: memoryDeletionRecordStore(),
      osnIssuerUrl: OSN_ISSUER,
      osnTestKey: auth.key,
      organiserOrigin: PORTAL,
      resolveOsnProfileDisplays: async (ids) => {
        asked.push(...ids);
        return new Map(
          [EDITOR, OTHER, "usr_owner"].map((id) => [
            id,
            { handle: `h_${id}`, displayName: null, avatarUrl: null },
          ]),
        );
      },
    });
    expect((await post(app, ERASE, await arc.token("account:erase"), eraseBody)).status).toBe(200);

    const res = await appRequest(app, "/api/organiser/weddings/w1/hosts", {
      headers: { Authorization: `Bearer ${await auth.sign("usr_owner")}` },
    });
    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as {
      hosts: {
        osnProfileId: string;
        handle?: string;
        addedByOsnProfileId?: string;
        addedByHandle?: string;
      }[];
    };
    const editorSeat = body.hosts.find((h) => h.osnProfileId === EDITOR);
    expect(editorSeat).toBeDefined();
    expect(editorSeat && "addedByOsnProfileId" in editorSeat).toBe(false);
    expect(editorSeat && "addedByHandle" in editorSeat).toBe(false);
    // The seat's own holder is still named.
    expect(editorSeat?.handle).toBe(`h_${EDITOR}`);
    expect(body.hosts.find((h) => h.osnProfileId === "usr_owner")).toMatchObject({
      addedByOsnProfileId: OTHER,
      addedByHandle: `h_${OTHER}`,
    });
    expect(asked).toContain(EDITOR);
    expect(asked).toContain(OTHER);
    expect(asked).not.toContain("deleted");
    expect(asked).not.toContain(P);
  });
});

/**
 * Each erasure osn-api's fan-out asks of cire is recorded outside cire's
 * database before anything is erased (`lib/deletion-records.ts`), so a
 * restore of cire's database alone cannot bring the person's data back once
 * osn-api has marked cire done. The other owner's seat is checked untouched.
 */
describe("the deletion record of an erasure", () => {
  const otherSeat = (db: TestDb) =>
    db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, OTHER)).all().length;

  it("records the erasure it accepts, with the account's and its profiles' ids only", async () => {
    const store = memoryDeletionRecordStore();
    const { db, app } = setup([P, OTHER], undefined, store);
    const res = await post(app, ERASE, await arc.token("account:erase"), eraseBody);
    expect(res.status).toBe(200);
    expect(store.records()).toEqual([
      {
        v: 1,
        kind: "account_erased",
        at: expect.any(Number),
        accountId: "acc_erased",
        profileIds: [P],
        // Another owner keeps the wedding: a replay takes the seat and
        // deletes nothing, whoever owns it on the restored rows.
        outcome: {
          deletedWeddings: [],
          removedSeats: [{ weddingId: "w1", profileId: P }],
          unsettledWeddings: [],
          cleanUp: "done",
          finished: true,
        },
      },
    ]);
    expect(JSON.stringify(store.records())).not.toContain(OTHER);
    expect(otherSeat(db)).toBe(1);
  });

  it("records the wedding it deleted when the person owned it alone", async () => {
    const store = memoryDeletionRecordStore();
    const { db, app } = setup([P], undefined, store);
    expect((await post(app, ERASE, await arc.token("account:erase"), eraseBody)).status).toBe(200);
    expect(store.records()).toEqual([
      expect.objectContaining({
        kind: "account_erased",
        outcome: {
          deletedWeddings: ["w1"],
          removedSeats: [{ weddingId: "w1", profileId: P }],
          unsettledWeddings: [],
          cleanUp: "done",
          finished: true,
        },
      }),
    ]);
    expect(db.select().from(weddings).where(eq(weddings.id, "w1")).get()?.deletedAt).not.toBeNull();
  });

  it("records a call that leaves owned weddings for the next as not finished", async () => {
    const store = memoryDeletionRecordStore();
    const { app, db } = setup([P], undefined, store);
    // More weddings than one call takes, so the clean-up waits for a later call.
    for (const id of ["w2", "w3", "w4"]) {
      insertWedding(db, { id, slug: `slug-${id}`, displayName: id, owners: [P] });
    }
    const res = await post(app, ERASE, await arc.token("account:erase"), eraseBody);
    expect(await jsonBody(res)).toEqual({ error: "not_finished" });
    const [record] = store.records() as Extract<DeletionRecord, { kind: "account_erased" }>[];
    expect(record?.outcome).toEqual(
      expect.objectContaining({ cleanUp: "not_run", finished: false, unsettledWeddings: [] }),
    );
    expect(record?.outcome?.deletedWeddings).toHaveLength(3);
  });

  it("records what the erasure did whether the owners' email to a payout holder's wedding goes or fails", async () => {
    const holds = (db: TestDb) =>
      db
        .insert(registrySettings)
        .values({
          weddingId: "w1",
          stripeAccountId: "acct_w1",
          stripeConnectedByOsnProfileId: P,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
    for (const lookup of ["answers", "fails"] as const) {
      const store = memoryDeletionRecordStore();
      const mail = makeLogEmailLive();
      const { db, app } = setup([P, OTHER], undefined, store, {
        emailLayer: mail.layer,
        organiserEmailLookup: async (ids) => {
          if (lookup === "fails") throw new Error("osn-api is down");
          return {
            answered: true,
            emails: new Map(ids.map((id) => [id, `${id}@example.test`] as const)),
          };
        },
      });
      holds(db);
      let res: Response | undefined;
      const logs = await captureLogs(async () => {
        res = await post(app, ERASE, await arc.token("account:erase"), eraseBody);
      });
      // The email never decides the answer or the record.
      expect({ lookup, status: res!.status }).toEqual({ lookup, status: 200 });
      expect(store.records()).toEqual([
        expect.objectContaining({
          kind: "account_erased",
          outcome: {
            deletedWeddings: [],
            removedSeats: [{ weddingId: "w1", profileId: P }],
            unsettledWeddings: [],
            cleanUp: "done",
            finished: true,
          },
        }),
      ]);
      expect(mail.recorded()).toHaveLength(lookup === "answers" ? 1 : 0);
      // The test's log transport prints each message it is handed, address
      // included; production sends through Resend. Every other line names
      // neither the person nor the owner's address.
      const lines = logs
        .split(/\n(?=\[\d{2}:\d{2}:\d{2}\.\d{3}\])/)
        .filter((line) => !line.includes("[email:log]"));
      for (const named of [P, "acc_erased", `${OTHER}@example.test`]) {
        for (const line of lines) expect(line).not.toContain(named);
      }
    }
  });

  it("answers the erasure when its outcome cannot be written, and logs the record by its key alone", async () => {
    const memory = memoryDeletionRecordStore();
    const keys: string[] = [];
    const store: DeletionRecordStore = {
      ...memory,
      write: (record) =>
        memory.write(record).pipe(Effect.tap(({ key }) => Effect.sync(() => keys.push(key)))),
      rewrite: ({ kind, key }) =>
        Effect.fail(new DeletionRecordWriteError({ kind, reason: "timeout", key })),
    };
    const { app } = setup([P, OTHER], undefined, store);
    const token = await arc.token("account:erase");
    let res: Response | undefined;
    const logs = await captureLogs(async () => {
      res = await post(app, ERASE, token, eraseBody);
    });
    expect(res!.status).toBe(200);
    // The record as first written: a replay deletes no wedding for it.
    expect(memory.records()).toEqual([expect.not.objectContaining({ outcome: expect.anything() })]);
    expect(keys).toHaveLength(1);
    expect(logs).toContain("deletion record settle failed");
    expect(logs).toContain("kind: account_erased");
    expect(logs).toContain("reason: timeout");
    expect(logs).toContain(`key: ${keys[0]}`);
    // The erasure's own log names the wedding; nothing names the person.
    for (const named of [P, OTHER, "acc_erased"]) {
      expect(logs).not.toContain(named);
    }
  });

  it("records nothing for a body past the bound on answers", async () => {
    const store = memoryDeletionRecordStore();
    const { app } = setup([P, OTHER], undefined, store);
    const res = await post(app, ERASE, await arc.token("account:erase"), {
      ...eraseBody,
      choices: Object.fromEntries(
        Array.from({ length: 501 }, (_, i) => [`cire:wedding:w${i}`, "delete"]),
      ),
    });
    expect(res.status).toBe(400);
    expect(store.records()).toEqual([]);
  });

  it("records nothing for a caller refused at the token check", async () => {
    const store = memoryDeletionRecordStore();
    const { db, app } = setup([P, OTHER], undefined, store);
    expect((await post(app, ERASE, null, eraseBody)).status).toBe(401);
    expect(
      (await post(app, ERASE, await arc.token("account:erase", { iss: "zap-api" }), eraseBody))
        .status,
    ).toBe(401);
    expect(store.records()).toEqual([]);
    expect(untouched(db)).toBe(true);
  });

  it("answers 500, erasing nothing, for an account id the record refuses", async () => {
    const store = memoryDeletionRecordStore();
    const { db, app } = setup([P, OTHER], undefined, store);
    const res = await post(app, ERASE, await arc.token("account:erase"), {
      ...eraseBody,
      accountId: "acc erased",
    });
    expect({ status: res.status, body: await jsonBody(res) }).toEqual({
      status: 500,
      body: { error: "internal_error" },
    });
    expect(store.records()).toEqual([]);
    expect(untouched(db)).toBe(true);
  });

  it("keeps the record of an erasure that fails part way, saying what it did before", async () => {
    const store = memoryDeletionRecordStore();
    const { db, app } = setup([P], undefined, store);
    // The wedding's batch commits; the account's clean-up then fails.
    const failing = failStatements(db, (statement) =>
      /^delete from "registry_stripe_oauth_states"/i.test(statement),
    );
    const res = await post(app, ERASE, await arc.token("account:erase"), eraseBody);
    failing.restore();
    expect(res.status).toBe(500);
    expect(failing.failed()).toBeGreaterThan(0);
    const [record, ...rest] = store.records();
    expect(rest).toEqual([]);
    expect((record as Extract<DeletionRecord, { kind: "account_erased" }>).outcome).toEqual({
      deletedWeddings: ["w1"],
      removedSeats: [{ weddingId: "w1", profileId: P }],
      unsettledWeddings: [],
      // The clean-up's batch was sent when the call failed.
      cleanUp: "unsettled",
      finished: false,
    });
  });

  it("an erasure that fails part way names no one in its logs or its spans", async () => {
    const { db, app } = setup([P, OTHER]);
    const token = await arc.token("account:erase");
    const failing = failStatements(db, (statement) =>
      /^delete from "registry_stripe_oauth_states"/i.test(statement),
    );
    let res: Response | undefined;
    let spans: Awaited<ReturnType<typeof captureSpans>> = [];
    const logs = await captureLogs(async () => {
      spans = await captureSpans(async () => {
        res = await post(app, ERASE, token, eraseBody);
      });
    });
    failing.restore();
    expect(res!.status).toBe(500);
    // The wedding's batch committed before the failure: the seat is gone.
    expect(untouched(db)).toBe(false);

    const people = [P, OTHER, EDITOR, "acc_erased"];
    for (const named of people) expect(logs).not.toContain(named);
    // The failure's own lines name no wedding either. (Each wedding the
    // erasure reached is logged by its id as it goes, by design.)
    const entries = logs.split(/\n(?=\[\d{2}:\d{2}:\d{2}\.\d{3}\])/);
    const failures = entries.filter((entry) => /failed/.test(entry));
    expect(failures.length).toBeGreaterThan(0);
    for (const entry of failures) expect(entry).not.toContain("w1");

    const values = (span: (typeof spans)[number]) => JSON.stringify(span.attributes);
    for (const span of spans) {
      for (const named of people) expect(values(span)).not.toContain(named);
    }
    const failed = spans.filter((span) => "error.type" in span.attributes);
    expect(failed.map((span) => span.attributes["error.type"])).toContain("AccountErasureError");
    for (const span of failed) expect(values(span)).not.toContain("w1");
  });

  /** The wedding batch's own delete of the account's seats. */
  const weddingSeatDelete = (statement: string) =>
    /^delete from "wedding_hosts" where \(\("wedding_hosts"."wedding_id" = \?/i.test(statement);

  it("lists a wedding whose batch committed but answered an error as unsettled, naming no one in logs or spans", async () => {
    const store = memoryDeletionRecordStore();
    const { db, app } = setup([P, OTHER], undefined, store);
    const token = await arc.token("account:erase");
    // Every statement of the wedding's batch runs; its last one then throws,
    // as a D1 batch can commit and its answer still be lost.
    const failing = failAfterRunning(db, weddingSeatDelete);
    let res: Response | undefined;
    let spans: Awaited<ReturnType<typeof captureSpans>> = [];
    const logs = await captureLogs(async () => {
      spans = await captureSpans(async () => {
        res = await post(app, ERASE, token, eraseBody);
      });
    });
    failing.restore();
    expect(res!.status).toBe(500);
    expect(failing.failed()).toBe(1);
    expect(untouched(db)).toBe(false);
    // The database never confirmed what the batch did, so the record lists
    // nothing for the wedding and leaves it to a person.
    expect(store.records()).toEqual([
      expect.objectContaining({
        kind: "account_erased",
        outcome: {
          deletedWeddings: [],
          removedSeats: [],
          unsettledWeddings: ["w1"],
          cleanUp: "not_run",
          finished: false,
        },
      }),
    ]);
    // The wedding batch's failure names the wedding, by design, and no one.
    expect(logs).toContain("account erasure: a wedding's batch failed");
    for (const named of [P, OTHER, EDITOR, "acc_erased"]) {
      expect(logs).not.toContain(named);
      for (const span of spans) expect(JSON.stringify(span.attributes)).not.toContain(named);
    }
  });

  it("answers 500 and records nothing done when ending the sessions fails, before any wedding", async () => {
    const store = memoryDeletionRecordStore();
    const { db, app } = setup([P], undefined, store);
    const failing = failStatements(db, (statement) =>
      /^delete from "organiser_sessions"/i.test(statement),
    );
    const res = await post(app, ERASE, await arc.token("account:erase"), eraseBody);
    failing.restore();
    expect({ status: res.status, body: await jsonBody(res) }).toEqual({
      status: 500,
      body: { error: "internal_error" },
    });
    expect(untouched(db)).toBe(true);
    expect(store.records()).toEqual([
      expect.objectContaining({
        outcome: {
          deletedWeddings: [],
          removedSeats: [],
          unsettledWeddings: [],
          cleanUp: "not_run",
          finished: false,
        },
      }),
    ]);
  });

  it("lists a wedding whose batch failed before it wrote as unsettled", async () => {
    const store = memoryDeletionRecordStore();
    const { db, app } = setup([P], undefined, store);
    const failing = failStatements(db, (statement) =>
      /^update "weddings" set "deleted_at"/i.test(statement),
    );
    const res = await post(app, ERASE, await arc.token("account:erase"), eraseBody);
    failing.restore();
    expect(res.status).toBe(500);
    expect(untouched(db)).toBe(true);
    expect(store.records()).toEqual([
      expect.objectContaining({
        outcome: {
          deletedWeddings: [],
          removedSeats: [],
          unsettledWeddings: ["w1"],
          cleanUp: "not_run",
          finished: false,
        },
      }),
    ]);
  });

  it("leaves a seat added after the call's first read to a later step, which records it", async () => {
    const store = memoryDeletionRecordStore();
    const { db, app } = setup([P], undefined, store);
    const SECOND = "usr_erased_second";
    const body = { ...eraseBody, profileIds: [P, SECOND] };
    // The batch's answer will be lost after it runs.
    const failing = failAfterRunning(db, weddingSeatDelete);
    // Another request seats the account's second profile on the wedding just
    // before the wedding's batch takes the seats it read.
    beforeStatement(
      db,
      /^delete from "wedding_hosts" where \(\("wedding_hosts"."wedding_id" = \?/i,
      () =>
        db
          .insert(weddingHosts)
          .values({
            id: "whost_second",
            weddingId: "w1",
            osnProfileId: SECOND,
            addedByOsnProfileId: P,
            role: "editor",
            createdAt: new Date(),
          })
          .run(),
    );
    expect((await post(app, ERASE, await arc.token("account:erase"), body)).status).toBe(500);
    failing.restore();
    // The batch took only the seat it read; the new one stands.
    expect(
      db
        .select({ id: weddingHosts.id })
        .from(weddingHosts)
        .where(eq(weddingHosts.weddingId, "w1"))
        .all(),
    ).toEqual(expect.arrayContaining([{ id: "whost_second" }]));

    // osn-api's next call takes it in the clean-up, and its record lists it.
    // The first call's wedding stays unsettled: a seat listed on it later
    // says nothing about what its batch did.
    expect((await post(app, ERASE, await arc.token("account:erase"), body)).status).toBe(200);
    const [first, second] = store.records() as Extract<
      DeletionRecord,
      { kind: "account_erased" }
    >[];
    expect(first?.outcome).toEqual(
      expect.objectContaining({ unsettledWeddings: ["w1"], removedSeats: [] }),
    );
    expect(second?.outcome?.removedSeats).toEqual([{ weddingId: "w1", profileId: SECOND }]);
    expect(
      db
        .select()
        .from(weddingHosts)
        .where(eq(weddingHosts.weddingId, "w1"))
        .all()
        .map((r) => r.osnProfileId),
    ).not.toEqual(expect.arrayContaining([P]));
    expect(
      db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, SECOND)).all(),
    ).toEqual([]);
  });

  it("leaves the notice row of a seat added after the call's first read with that seat", async () => {
    const { db, app } = setup([P, OTHER]);
    const SECOND = "usr_erased_second";
    // Another request seats the account's second profile as an owner, with
    // its notice row, just before the wedding's batch.
    beforeStatement(
      db,
      /^delete from "host_rsvp_notices" where \(\("host_rsvp_notices"."wedding_id" = \?/i,
      () => {
        db.insert(weddingHosts)
          .values({
            id: "whost_second",
            weddingId: "w1",
            osnProfileId: SECOND,
            addedByOsnProfileId: OTHER,
            role: "owner",
            createdAt: new Date(),
          })
          .run();
        db.insert(hostRsvpNotices)
          .values({
            weddingId: "w1",
            osnProfileId: SECOND,
            digestEnabled: false,
            updatedAt: new Date(),
          })
          .run();
      },
    );
    const res = await post(app, ERASE, await arc.token("account:erase"), {
      ...eraseBody,
      profileIds: [P, SECOND],
    });
    // The seat stands, so the call leaves it for the next.
    expect(await jsonBody(res)).toEqual({ error: "not_finished" });
    expect(
      db.select().from(hostRsvpNotices).where(eq(hostRsvpNotices.osnProfileId, SECOND)).all(),
    ).toEqual([expect.objectContaining({ weddingId: "w1", digestEnabled: false })]);
  });

  it("records a wedding the batch deleted though another request had taken the seats first", async () => {
    const store = memoryDeletionRecordStore();
    const { db, app } = setup([P], undefined, store);
    // The wedding is deleted; then, before the batch takes the seats, another
    // request has taken them.
    beforeStatement(
      db,
      /^delete from "wedding_hosts" where \(\("wedding_hosts"."wedding_id" = \?/i,
      () => db.delete(weddingHosts).where(eq(weddingHosts.weddingId, "w1")).run(),
    );
    expect((await post(app, ERASE, await arc.token("account:erase"), eraseBody)).status).toBe(200);
    expect(store.records()).toEqual([
      expect.objectContaining({
        outcome: expect.objectContaining({ deletedWeddings: ["w1"], removedSeats: [] }),
      }),
    ]);
  });

  it("takes seats below owner a bounded share at a time, every share fitting its record", async () => {
    // The most seats one call can remove fits the most a record lists.
    expect(
      MAX_OWNED_WEDDINGS_PER_CALL * DELETION_RECORD_MAX_PROFILES + MAX_LOWER_SEATS_PER_CALL,
    ).toBeLessThanOrEqual(DELETION_RECORD_MAX_SEATS);

    const store = memoryDeletionRecordStore();
    const { db, app } = setup([P], undefined, store);
    await seedOrganiserSession(db, P);
    const sessions = () =>
      db.select().from(organiserSessions).where(eq(organiserSessions.osnProfileId, P)).all();
    const viewed = Array.from({ length: MAX_LOWER_SEATS_PER_CALL + 1 }, (_, i) => `wv${i}`);
    for (const id of viewed) {
      insertWedding(db, { id, slug: `slug-${id}`, displayName: id, owners: [OTHER] });
      db.insert(weddingHosts)
        .values({
          id: `whost_${id}`,
          weddingId: id,
          osnProfileId: P,
          addedByOsnProfileId: OTHER,
          role: "viewer",
          createdAt: new Date(),
        })
        .run();
    }
    const first = await post(app, ERASE, await arc.token("account:erase"), eraseBody);
    expect(await jsonBody(first)).toEqual({ error: "not_finished" });
    const [firstRecord] = store.records() as Extract<DeletionRecord, { kind: "account_erased" }>[];
    expect(firstRecord?.outcome).toEqual(
      expect.objectContaining({ deletedWeddings: ["w1"], cleanUp: "done", finished: false }),
    );
    // The wedding's seat and the clean-up's share of the seats below owner.
    expect(firstRecord?.outcome?.removedSeats).toHaveLength(1 + MAX_LOWER_SEATS_PER_CALL);
    // An account's erasure ends the sessions at once, seats left or not:
    // osn-api makes the next call.
    expect(sessions()).toEqual([]);

    expect((await post(app, ERASE, await arc.token("account:erase"), eraseBody)).status).toBe(200);
    const second = (store.records() as Extract<DeletionRecord, { kind: "account_erased" }>[])[1];
    expect(second?.outcome).toEqual(
      expect.objectContaining({ deletedWeddings: [], cleanUp: "done", finished: true }),
    );
    expect(second?.outcome?.removedSeats).toHaveLength(1);
    expect(sessions()).toEqual([]);
    expect(db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, P)).all()).toEqual(
      [],
    );
  });

  it("answers 503, erasing nothing, when the record cannot be written, so osn-api calls again", async () => {
    const { db, app } = setup([P, OTHER], undefined, missingDeletionRecordStore());
    const before = await erasures("error");
    const res = await post(app, ERASE, await arc.token("account:erase"), eraseBody);
    expect(await erasures("error")).toBe(before + 1);
    expect({ status: res.status, body: await jsonBody(res) }).toEqual({
      status: 503,
      body: { error: "not_recorded" },
    });
    expect(untouched(db)).toBe(true);
    expect(otherSeat(db)).toBe(1);
  });
});

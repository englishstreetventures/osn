import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime } from "bun:test";

import { registrySettings, weddingHosts, weddings } from "@cire/db";
import { generateArcKeyPair } from "@shared/crypto/jwk";
import { eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { appRequest, failStatements, jsonBody } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";
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

function setup(owners: readonly string[] = [P, OTHER], osnArcKidSecret?: string) {
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
    osnIssuerUrl: OSN_ISSUER,
    osnTestKey: auth.key,
    organiserOrigin: PORTAL,
    osnArcKidSecret,
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

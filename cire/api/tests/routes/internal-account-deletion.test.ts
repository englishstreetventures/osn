import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { weddingHosts } from "@cire/db";
import { eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { appRequest, jsonBody } from "../test-helpers";
import { OSN_ISSUER, osnArc } from "../test-helpers/osn-arc";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";

/**
 * osn-api's two account-deletion calls on cire-api: who may make them and
 * what they refuse. Each test names its failure mode in `NEW-FEAT.md`.
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
afterEach(() => arc.restore());

function setup(owners: readonly string[] = [P, OTHER]) {
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
  email: "Person@Example.test",
};

const untouched = (db: TestDb) =>
  db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, P)).all().length === 1;

describe("ARC on the account-deletion calls (refusals)", () => {
  it("F1: no token is refused, and nothing is written", async () => {
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

  it("F2: a token from an issuer other than osn-api is refused", async () => {
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

  it("F3: a token for another app's audience is refused", async () => {
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

  it("F4: each call needs its own scope", async () => {
    const { db, app } = setup();
    const erase = await post(app, ERASE, await arc.token("account:deletion-preview"), eraseBody);
    expect(erase.status).toBe(401);
    const preview = await post(app, PREVIEW, await arc.token("account:erase"), previewBody);
    expect(preview.status).toBe(401);
    expect(untouched(db)).toBe(true);
  });

  it("F5: with no kid secret, a made-up kid costs one fetch of the public key set, then the cache", async () => {
    const { app } = setup();
    const madeUp = await arc.token("account:erase", { kid: "made-up-kid" });
    expect((await post(app, ERASE, madeUp, eraseBody)).status).toBe(401);
    expect((await post(app, ERASE, madeUp, eraseBody)).status).toBe(401);
    expect(arc.fetches()).toBe(1);
  });

  it("F6: a body outside the contract is refused before anything is written", async () => {
    const { db, app } = setup();
    const token = await arc.token("account:erase");
    for (const body of [
      "{not json",
      { ...eraseBody, profileIds: ["not-a-profile"] },
      { ...eraseBody, profileIds: Array.from({ length: 101 }, (_, i) => `usr_${i}`) },
      { ...eraseBody, accountId: "" },
      { ...eraseBody, choices: { "cire:wedding:w1": { choice: "x".repeat(33) } } },
    ]) {
      const res = await post(app, ERASE, token, body);
      expect(res.status).toBe(400);
    }
    expect(untouched(db)).toBe(true);
  });

  it("F7: osn-api's calls carry no browser Origin, and the origin guard does not stand in their way", async () => {
    const { app } = setup();
    const token = await arc.token("account:deletion-preview");
    const res = await post(app, PREVIEW, token, previewBody, {
      origin: "https://elsewhere.example",
    });
    expect(res.status).toBe(200);
  });
});

describe("the account-deletion calls", () => {
  it("preview answers the contract's shape", async () => {
    const { app } = setup();
    const res = await post(app, PREVIEW, await arc.token("account:deletion-preview"), previewBody);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      openActions: [
        {
          id: "cire:wedding:w1",
          kind: "wedding_co_owned",
          label: expect.any(String),
          choices: [],
          defaultChoice: null,
          link: null,
        },
      ],
    });
  });

  it("erase removes the person's seat from a wedding another owner keeps, and keeps nothing", async () => {
    const { db, app } = setup();
    const res = await post(app, ERASE, await arc.token("account:erase"), eraseBody);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ kept: [] });
    expect(db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, P)).all()).toEqual(
      [],
    );
  });

  it("both calls refuse with 500 while the person alone owns a wedding, and change nothing", async () => {
    const { db, app } = setup([P]);
    const preview = await post(
      app,
      PREVIEW,
      await arc.token("account:deletion-preview"),
      previewBody,
    );
    expect(preview.status).toBe(500);
    const erase = await post(app, ERASE, await arc.token("account:erase"), eraseBody);
    expect(erase.status).toBe(500);
    expect(untouched(db)).toBe(true);
  });

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
    const first = await post(app, ERASE, token, eraseBody);
    expect(first.status).toBe(503);
    expect(await jsonBody(first)).toEqual({ error: "not_finished" });
    const second = await post(app, ERASE, token, eraseBody);
    expect(second.status).toBe(200);
  });
});

describe("a seat the erased person created (F43)", () => {
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
    const asked: string[] = [];
    const app = createApp(db, {
      osnIssuerUrl: OSN_ISSUER,
      osnTestKey: auth.key,
      organiserOrigin: PORTAL,
      resolveOsnProfileDisplays: async (ids) => {
        asked.push(...ids);
        return new Map();
      },
    });
    expect((await post(app, ERASE, await arc.token("account:erase"), eraseBody)).status).toBe(200);

    const res = await appRequest(app, "/api/organiser/weddings/w1/hosts", {
      headers: { Authorization: `Bearer ${await auth.sign("usr_owner")}` },
    });
    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as {
      hosts: { osnProfileId: string; addedByOsnProfileId?: string }[];
    };
    const editorSeat = body.hosts.find((h) => h.osnProfileId === EDITOR);
    expect(editorSeat).toBeDefined();
    expect(editorSeat && "addedByOsnProfileId" in editorSeat).toBe(false);
    expect(asked).not.toContain("deleted");
    expect(asked).not.toContain(P);
  });
});

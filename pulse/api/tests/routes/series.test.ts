import { makeAccessTokenSigner, type AccessTokenSigner } from "@shared/crypto/testing";
import { Effect } from "effect";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createSeriesRoutes } from "../../src/routes/series";
import { createTestLayer, seedEvent } from "../helpers/db";
import { TEST_VERIFICATION } from "../helpers/verification";

let signer: AccessTokenSigner;
let testPublicKey: CryptoKey;

beforeAll(async () => {
  signer = await makeAccessTokenSigner();
  testPublicKey = signer.publicKey;
});

const makeToken = (profileId: string) => signer.sign(profileId);

const futureIso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const post = (
  app: ReturnType<typeof createSeriesRoutes>,
  path: string,
  body: unknown,
  token?: string,
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const get = (app: ReturnType<typeof createSeriesRoutes>, path: string, token?: string) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );

const del = (app: ReturnType<typeof createSeriesRoutes>, path: string, token?: string) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );

describe("series routes", () => {
  let app: ReturnType<typeof createSeriesRoutes>;
  let layer: ReturnType<typeof createTestLayer>;
  let aliceToken: string;
  let bobToken: string;

  beforeEach(async () => {
    layer = createTestLayer();
    app = createSeriesRoutes(layer, TEST_VERIFICATION, testPublicKey);
    aliceToken = await makeToken("usr_alice");
    bobToken = await makeToken("usr_bob");
  });

  it("POST /series returns 401 without a token", async () => {
    const res = await post(app, "/series", {
      title: "W",
      rrule: "FREQ=WEEKLY;COUNT=2",
      dtstart: futureIso(5),
    });
    expect(res.status).toBe(401);
  });

  it("POST /series creates a series and materializes instances", async () => {
    const res = await post(
      app,
      "/series",
      {
        title: "Weekly Yoga",
        rrule: "FREQ=WEEKLY;COUNT=4",
        dtstart: futureIso(5),
        category: "wellness",
      },
      aliceToken,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { series: { id: string }; instances: unknown[] };
    expect(body.series.id).toMatch(/^srs_/);
    expect(body.instances).toHaveLength(4);
  });

  it("GET /series/:id returns 404 for unknown id", async () => {
    const res = await get(app, "/series/srs_missing");
    expect(res.status).toBe(404);
  });

  // A private series' metadata is the organiser's, or a viewer's who can see
  // one of its instances; anyone else gets the same 404 as an unknown id.
  const createPrivateSeries = async () => {
    const create = await post(
      app,
      "/series",
      {
        title: "Members",
        rrule: "FREQ=WEEKLY;COUNT=2",
        dtstart: futureIso(3),
        visibility: "private",
      },
      aliceToken,
    );
    expect(create.status).toBe(201);
    return ((await create.json()) as { series: { id: string } }).series.id;
  };

  it("GET /series/:id answers 404 to a signed-in stranger for a private series", async () => {
    const seriesId = await createPrivateSeries();
    const res = await get(app, `/series/${seriesId}`, bobToken);
    expect(res.status).toBe(404);
  });

  it("GET /series/:id answers 200 to the organiser of a private series", async () => {
    const seriesId = await createPrivateSeries();
    const res = await get(app, `/series/${seriesId}`, aliceToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { series: { id: string } };
    expect(body.series.id).toBe(seriesId);
  });

  it("GET /series/:id/instances defaults to upcoming", async () => {
    const create = await post(
      app,
      "/series",
      { title: "W", rrule: "FREQ=WEEKLY;COUNT=3", dtstart: futureIso(3) },
      aliceToken,
    );
    const created = (await create.json()) as { series: { id: string } };
    // An instance of the same series that has already happened.
    const past = await Effect.runPromise(
      seedEvent({
        title: "W",
        startTime: new Date(Date.now() - 7 * 86_400_000),
        createdByProfileId: "usr_alice",
        seriesId: created.series.id,
      }).pipe(Effect.provide(layer)),
    );
    const res = await get(app, `/series/${created.series.id}/instances`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instances: { id: string; seriesId: string | null }[] };
    expect(body.instances).toHaveLength(3);
    expect(body.instances.map((i) => i.id)).not.toContain(past.id);
    for (const i of body.instances) expect(i.seriesId).toBe(created.series.id);
  });

  it("PATCH /series/:id by a non-owner returns 403", async () => {
    const create = await post(
      app,
      "/series",
      { title: "W", rrule: "FREQ=WEEKLY;COUNT=2", dtstart: futureIso(3) },
      aliceToken,
    );
    const created = (await create.json()) as { series: { id: string } };
    const res = await app.handle(
      new Request(`http://localhost/series/${created.series.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bobToken}` },
        body: JSON.stringify({ title: "Hax" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("DELETE /series/:id cancels a series", async () => {
    const create = await post(
      app,
      "/series",
      { title: "W", rrule: "FREQ=WEEKLY;COUNT=2", dtstart: futureIso(3) },
      aliceToken,
    );
    const created = (await create.json()) as { series: { id: string } };
    const res = await del(app, `/series/${created.series.id}`, aliceToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cancelled: number };
    expect(body.cancelled).toBeGreaterThan(0);
  });
});

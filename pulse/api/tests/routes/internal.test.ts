import { eventRsvps, events, pulseWebSessions } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createInternalRoutes, MAX_ACCOUNT_PROFILE_IDS } from "../../src/routes/internal";
import { createTestLayer, seedCloseFriend, seedEvent } from "../helpers/db";
import { osnArc } from "../helpers/osn-arc";

/**
 * Route-level coverage for the `/internal` group, every route of which only
 * osn-api calls, verified against the keys osn-api publishes: the deletion
 * preview, the session end, the erasure and the export. Each refuses a call
 * with no token, another service's token, a token for another audience, and a
 * token without its own scope.
 */

let arc: Awaited<ReturnType<typeof osnArc>>;

beforeEach(async () => {
  arc = await osnArc();
});

afterEach(() => {
  arc.restore();
});

function post(
  app: ReturnType<typeof createInternalRoutes>,
  path: string,
  body: unknown,
  auth?: string,
) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

const routes = () => createInternalRoutes(createTestLayer(), arc.verification);

const ROUTES = [
  {
    path: "/internal/account-deletion-preview",
    scope: "account:deletion-preview",
    body: { profileIds: ["usr_x"], deletesAt: 1_900_000_000 },
  },
  {
    path: "/internal/account-sessions/revoke",
    scope: "account:sessions-revoke",
    body: { profileIds: ["usr_x"] },
  },
  {
    path: "/internal/account-deleted",
    scope: "account:erase",
    body: { accountId: "acc_x", profileIds: ["usr_x"], choices: {}, deleteEverything: false },
  },
  {
    path: "/internal/account-export",
    scope: "account:export",
    body: { account_id: "acc_x", profile_ids: ["usr_x"] },
  },
] as const;

describe("internal routes — refusals", () => {
  for (const route of ROUTES) {
    it(`${route.path} refuses no token, another issuer, another audience and another scope`, async () => {
      const app = routes();
      const other = route.scope === "account:erase" ? "account:export" : "account:erase";
      for (const auth of [
        undefined,
        await arc.token(route.scope, { iss: "cire-api" }),
        await arc.token(route.scope, { aud: "zap-api" }),
        await arc.token(other),
      ]) {
        expect((await post(app, route.path, route.body, auth)).status).toBe(401);
      }
      expect((await post(app, route.path, route.body, await arc.token(route.scope))).status).toBe(
        200,
      );
    });
  }

  it("refuses a published key under a kid with no MAC or a wrong one, before any fetch", async () => {
    const [, expiry] = arc.kid.split(".");
    for (const kid of [
      `${crypto.randomUUID()}.${expiry}`,
      `${crypto.randomUUID()}.${expiry}.${"A".repeat(22)}`,
    ]) {
      const before = arc.fetches();
      const res = await post(
        routes(),
        "/internal/account-deletion-preview",
        { profileIds: ["usr_x"], deletesAt: 1_900_000_000 },
        await arc.tokenUnderKid("account:deletion-preview", kid),
      );
      expect(res.status).toBe(401);
      expect(arc.fetches()).toBe(before);
    }
  });

  it.each([
    ["holds no secret", undefined],
    ["holds a secret too short to key the MAC", "s".repeat(31)],
  ])("admits that kid when Pulse %s: the secret is what refuses it", async (_label, secret) => {
    if (secret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = secret;
    const [, expiry] = arc.kid.split(".");
    const res = await post(
      routes(),
      "/internal/account-deletion-preview",
      { profileIds: ["usr_x"], deletesAt: 1_900_000_000 },
      await arc.tokenUnderKid("account:deletion-preview", `${crypto.randomUUID()}.${expiry}`),
    );
    expect(res.status).toBe(200);
  });

  it("no longer takes key registrations: osn-api publishes its keys instead", async () => {
    const res = await post(routes(), "/internal/register-service", {}, "Bearer x");
    expect(res.status).toBe(404);
  });
});

describe("internal routes — the account deletion", () => {
  const PROFILE = "usr_host";
  const deletesAt = 1_900_000_000;

  it("the preview answers the host's upcoming events with their choices", async () => {
    const layer = createTestLayer();
    const event = await Effect.runPromise(
      seedEvent({
        title: "Picnic",
        startTime: new Date(Date.now() + 86_400_000),
        createdByProfileId: PROFILE,
      }).pipe(Effect.provide(layer)),
    );
    const app = createInternalRoutes(layer, arc.verification);
    const res = await post(
      app,
      "/internal/account-deletion-preview",
      { profileIds: [PROFILE], deletesAt },
      await arc.token("account:deletion-preview"),
    );
    expect(res.status).toBe(200);
    const { openActions } = (await res.json()) as {
      openActions: { id: string; defaultChoice: string; choices: { erasedOn: number | null }[] }[];
    };
    expect(openActions.map((a) => a.id)).toEqual([`pulse:event:${event.id}`]);
    expect(openActions[0]!.defaultChoice).toBe("cancel");
    expect(openActions[0]!.choices.map((c) => c.erasedOn)).toEqual([deletesAt + 14 * 86_400, null]);
  });

  it("the erasure takes the answers and answers what Pulse kept", async () => {
    const layer = createTestLayer();
    const kept = await Effect.runPromise(
      seedEvent({
        title: "Kept",
        startTime: new Date(Date.now() + 86_400_000),
        createdByProfileId: PROFILE,
      }).pipe(Effect.provide(layer)),
    );
    const gone = await Effect.runPromise(
      seedEvent({
        title: "Gone",
        startTime: new Date(Date.now() + 86_400_000),
        createdByProfileId: PROFILE,
      }).pipe(Effect.provide(layer)),
    );
    const app = createInternalRoutes(layer, arc.verification);
    const res = await post(
      app,
      "/internal/account-deleted",
      {
        accountId: "acc_host",
        profileIds: [PROFILE],
        choices: { [`pulse:event:${gone.id}`]: { choice: "delete" } },
        deleteEverything: false,
      },
      await arc.token("account:erase"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kept: { what: string; erasedOn: number; requestUrl: null }[];
    };
    expect(body.kept).toHaveLength(1);
    expect(body.kept[0]!.what).toBe("1 event you hosted, shown to its guests as cancelled");
    const left = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Db;
        return yield* Effect.promise(() => db.select({ id: events.id }).from(events));
      }).pipe(Effect.provide(layer)),
    );
    expect(left.map((e) => e.id)).toEqual([kept.id]);
  });

  it("the session end deletes the profiles' web sessions", async () => {
    const layer = createTestLayer();
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.promise(() =>
          db.insert(pulseWebSessions).values({
            id: "pws_1",
            token: "hash-1",
            osnProfileId: PROFILE,
            osnSub: "sub",
            expiresAt: new Date(Date.now() + 86_400_000),
            createdAt: new Date(),
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
    const res = await post(
      createInternalRoutes(layer, arc.verification),
      "/internal/account-sessions/revoke",
      { profileIds: [PROFILE] },
      await arc.token("account:sessions-revoke"),
    );
    expect(await res.json()).toEqual({ revoked: 1 });
    const left = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Db;
        return yield* Effect.promise(() =>
          db.select().from(pulseWebSessions).where(eq(pulseWebSessions.osnProfileId, PROFILE)),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(left).toEqual([]);
  });
});

const seedRsvp = (
  eventId: string,
  profileId: string,
  extra: { status?: "going" | "maybe" | "not_going" | "invited"; shareSourceFirst?: string } = {},
): Effect.Effect<void, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db.insert(eventRsvps).values({
        id: "rsvp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
        eventId,
        profileId,
        status: extra.status ?? "going",
        shareSourceFirst: extra.shareSourceFirst ?? null,
        createdAt: new Date(),
      }),
    );
  });

describe("internal routes — ARC-gated account-export", () => {
  async function exportToken(scope: string) {
    return (await arc.token(scope)).replace(/^ARC /, "");
  }

  it("streams NDJSON lines for seeded rsvps / events / close-friends", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer, arc.verification);

    const event = await Effect.runPromise(
      seedEvent({
        title: "Rooftop Session",
        startTime: "2030-06-01T10:00:00.000Z",
        createdByProfileId: "usr_export",
      }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedRsvp(event.id, "usr_export", { shareSourceFirst: "instagram" }).pipe(
        Effect.provide(layer),
      ),
    );
    await Effect.runPromise(
      seedCloseFriend("usr_export", "usr_friend").pipe(Effect.provide(layer)),
    );

    const token = await exportToken("account:export");
    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_export", profile_ids: ["usr_export"] },
      `ARC ${token}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const text = await res.text();
    const lines = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const sections = lines.map((l) => l.section);
    expect(sections).toContain("pulse.rsvps");
    expect(sections).toContain("pulse.events_hosted");
    expect(sections).toContain("pulse.close_friends");

    const rsvp = lines.find((l) => l.section === "pulse.rsvps");
    expect(rsvp.record.eventId).toBe(event.id);
    expect(rsvp.record.shareSourceFirst).toBe("instagram");

    const hosted = lines.find((l) => l.section === "pulse.events_hosted");
    expect(hosted.record.id).toBe(event.id);
    expect(hosted.record.title).toBe("Rooftop Session");

    const cf = lines.find((l) => l.section === "pulse.close_friends");
    expect(cf.record.friendId).toBe("usr_friend");
  });

  it("refuses more profile ids than the erasure route accepts, before any read", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer, arc.verification);
    const token = await exportToken("account:export");
    const tooMany = Array.from({ length: MAX_ACCOUNT_PROFILE_IDS + 1 }, (_, i) => `usr_${i}`);

    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_many", profile_ids: tooMany },
      `ARC ${token}`,
    );

    expect(res.status).toBe(422);
    const atCap = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_many", profile_ids: tooMany.slice(0, MAX_ACCOUNT_PROFILE_IDS) },
      `ARC ${await exportToken("account:export")}`,
    );
    expect(atCap.status).toBe(200);
  });

  it("returns 200 with an empty body when profile_ids is empty", async () => {
    const app = routes();
    const token = await exportToken("account:export");
    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_none", profile_ids: [] },
      `ARC ${token}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

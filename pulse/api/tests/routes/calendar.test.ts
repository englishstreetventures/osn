import { Database } from "bun:sqlite";

import * as schema from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { generateArcKeyPair } from "@shared/crypto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { SignJWT } from "jose";
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";

import { createEventsRoutes } from "../../src/routes/events";
import type { ProfileDisplay } from "../../src/services/graphBridge";
import { createTestLayer } from "../helpers/db";

// Db layer over a schema-less SQLite — every query fails, so the calendar
// route hits its catch-all → 500 branch.
const brokenLayer = () => Layer.succeed(Db, { db: drizzle(new Database(":memory:"), { schema }) });

vi.mock("../../src/services/graphBridge", () => ({
  GraphBridgeError: class GraphBridgeError {
    _tag = "GraphBridgeError";
    constructor(public args: { cause: unknown }) {}
  },
  getConnectionIds: vi.fn(),
  getProfileDisplays: vi.fn(),
}));

import * as bridge from "../../src/services/graphBridge";

const FUTURE = "2030-06-01T10:00:00.000Z";
const LATER = "2030-06-02T10:00:00.000Z";

let testPrivateKey: CryptoKey;
let testPublicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateArcKeyPair();
  testPrivateKey = pair.privateKey;
  testPublicKey = pair.publicKey;
});

const makeToken = (profileId: string) =>
  new SignJWT({ sub: profileId })
    .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
    .setAudience("osn-access")
    .sign(testPrivateKey);

const post = (
  app: ReturnType<typeof createEventsRoutes>,
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

const get = (app: ReturnType<typeof createEventsRoutes>, path: string, token?: string) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );

interface CalendarBody {
  entries: {
    event: { id: string; title: string };
    myStatus: "going" | "maybe" | null;
    isHost: boolean;
  }[];
}

describe("GET /events/calendar", () => {
  let app: ReturnType<typeof createEventsRoutes>;
  let meToken: string;
  let aliceToken: string;

  beforeEach(async () => {
    vi.mocked(bridge.getConnectionIds).mockReturnValue(Effect.succeed(new Set<string>()));
    vi.mocked(bridge.getProfileDisplays).mockReturnValue(
      Effect.succeed(new Map<string, ProfileDisplay>()),
    );
    app = createEventsRoutes(createTestLayer(), "", testPublicKey);
    meToken = await makeToken("usr_me");
    aliceToken = await makeToken("usr_alice");
  });

  it("returns 401 without a token", async () => {
    const res = await get(app, "/events/calendar");
    expect(res.status).toBe(401);
  });

  it("returns events the viewer is going to and hosting", async () => {
    // Alice hosts an event; "me" RSVPs going.
    const created = await post(
      app,
      "/events",
      { title: "Alice's Party", startTime: LATER },
      aliceToken,
    );
    const { event } = (await created.json()) as { event: { id: string } };
    await post(app, `/events/${event.id}/rsvps`, { status: "going" }, meToken);
    // "me" hosts their own event.
    await post(app, "/events", { title: "My Workshop", startTime: FUTURE }, meToken);

    const res = await get(app, "/events/calendar", meToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CalendarBody;
    // Ordered by start time: FUTURE (my workshop) before LATER (Alice's party).
    expect(body.entries.map((e) => e.event.title)).toEqual(["My Workshop", "Alice's Party"]);

    const mine = body.entries.find((e) => e.event.title === "My Workshop")!;
    expect(mine.isHost).toBe(true);

    const party = body.entries.find((e) => e.event.title === "Alice's Party")!;
    expect(party.isHost).toBe(false);
    expect(party.myStatus).toBe("going");
  });

  it("honours the ?limit query param", async () => {
    await post(app, "/events", { title: "First", startTime: FUTURE }, meToken);
    await post(app, "/events", { title: "Second", startTime: LATER }, meToken);

    const res = await get(app, "/events/calendar?limit=1", meToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CalendarBody;
    expect(body.entries).toHaveLength(1);
  });

  it("falls back to the default limit on a non-numeric ?limit", async () => {
    await post(app, "/events", { title: "First", startTime: FUTURE }, meToken);
    await post(app, "/events", { title: "Second", startTime: LATER }, meToken);

    const res = await get(app, "/events/calendar?limit=abc", meToken);
    // NaN must not reach the SQL LIMIT — the route falls back to the default.
    expect(res.status).toBe(200);
    const body = (await res.json()) as CalendarBody;
    expect(body.entries).toHaveLength(2);
  });

  it("returns 500 when the calendar query fails", async () => {
    const brokenApp = createEventsRoutes(brokenLayer(), "", testPublicKey);
    const res = await get(brokenApp, "/events/calendar", meToken);
    expect(res.status).toBe(500);
  });
});

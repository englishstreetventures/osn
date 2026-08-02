import { describe, it, expect, beforeAll } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";

import { createApp } from "../app";
import type { AppOptions } from "../app";
import { createDb } from "../db/setup";
import type {
  OsnConnectionSearchResolver,
  OsnHandleSearchResolver,
  OsnHandleSuggestion,
} from "../services/osn-bridge";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

const ORGANISER = "usr_organiser";

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/** One suggestion as the route emits it (bridge shape + the `connected` flag). */
interface Suggestion extends OsnHandleSuggestion {
  connected: boolean;
}

/** Global handle namespace: prefix-matched, mirrors osn-api's search shape. */
const FIXTURES: OsnHandleSuggestion[] = [
  { profileId: "usr_alice", handle: "alice", displayName: "Alice" },
  { profileId: "usr_alina", handle: "alina", displayName: null },
  { profileId: "usr_bob", handle: "bob", displayName: "Bob" },
];
const stubSearch: OsnHandleSearchResolver = async (prefix) => {
  const p = (prefix.startsWith("@") ? prefix.slice(1) : prefix).trim().toLowerCase();
  if (p.length < 2) return [];
  return FIXTURES.filter((f) => f.handle.startsWith(p));
};

/**
 * ORGANISER's own connections. `alina` is deliberately in BOTH sets so the
 * dedupe + "connections win" ordering is observable; `zoe` is a connection the
 * global handle search never returns.
 */
const CONNECTIONS: OsnHandleSuggestion[] = [
  { profileId: "usr_alina", handle: "alina", displayName: "Alina Rao" },
  { profileId: "usr_zoe", handle: "zoe", displayName: "Zoe" },
];
/** Connection stub: empty query ⇒ the whole list (the on-focus case). */
const stubConnections: OsnConnectionSearchResolver = async (profileId, prefix) => {
  if (profileId !== ORGANISER) return [];
  const p = (prefix.startsWith("@") ? prefix.slice(1) : prefix).trim().toLowerCase();
  if (p.length === 0) return CONNECTIONS;
  return CONNECTIONS.filter(
    (c) => c.handle.startsWith(p) || (c.displayName?.toLowerCase().includes(p) ?? false),
  );
};

/** Resolvers that throw — stand in for osn-api returning a 5xx. */
const throwingSearch: OsnHandleSearchResolver = async () => {
  throw new Error("osn-api 500");
};
const throwingConnections: OsnConnectionSearchResolver = async () => {
  throw new Error("osn-api 500");
};

function buildApp(overrides: Partial<AppOptions> = {}) {
  const db = createDb(":memory:");
  const app = createApp(db, {
    osnTestKey: auth.key,
    resolveOsnHandleSearch: stubSearch,
    resolveOsnConnectionSearch: stubConnections,
    ...overrides,
  });
  return { db, app };
}

async function req(app: ReturnType<typeof buildApp>["app"], path: string, profileId?: string) {
  const headers: Record<string, string> = {};
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, { method: "GET", headers });
}

const searchPath = (q: string) => `/api/organiser/handle-search?q=${encodeURIComponent(q)}`;

const profiles = async (res: Response) =>
  ((await res.json()) as { profiles: Suggestion[] }).profiles;

describe("GET /api/organiser/handle-search", () => {
  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    const res = await req(app, searchPath("al"));
    expect(res.status).toBe(401);
  });

  it("ranks the organiser's own connections above global handle matches", async () => {
    const { app } = buildApp();
    const res = await req(app, searchPath("al"), ORGANISER);
    expect(res.status).toBe(200);
    const body = await profiles(res);
    // alina is a connection AND a global match — she leads, marked connected,
    // and appears exactly once. alice follows from the global search.
    expect(body.map((p) => p.handle)).toEqual(["alina", "alice"]);
    expect(body[0]).toEqual({
      profileId: "usr_alina",
      handle: "alina",
      // The connection source wins the dedupe, so its display name is the one
      // surfaced — not the global search's null.
      displayName: "Alina Rao",
      connected: true,
    });
    expect(body[1]!.connected).toBe(false);
  });

  it("returns the organiser's connections for a blank query (the on-focus case)", async () => {
    const { app } = buildApp();
    const res = await req(app, searchPath(""), ORGANISER);
    expect(res.status).toBe(200);
    const body = await profiles(res);
    expect(body.map((p) => p.handle)).toEqual(["alina", "zoe"]);
    expect(body.every((p) => p.connected)).toBe(true);
  });

  it("returns connections for a whitespace-only query too", async () => {
    const { app } = buildApp();
    const res = await req(app, searchPath("   "), ORGANISER);
    expect(res.status).toBe(200);
    expect((await profiles(res)).map((p) => p.handle)).toEqual(["alina", "zoe"]);
  });

  it("returns connections when the query param is missing entirely", async () => {
    const { app } = buildApp();
    const res = await req(app, "/api/organiser/handle-search", ORGANISER);
    expect(res.status).toBe(200);
    expect((await profiles(res)).map((p) => p.handle)).toEqual(["alina", "zoe"]);
  });

  it("matches a connection on display name, not just handle", async () => {
    const { app } = buildApp();
    const res = await req(app, searchPath("rao"), ORGANISER);
    const body = await profiles(res);
    expect(body.map((p) => p.handle)).toEqual(["alina"]);
    expect(body[0]!.connected).toBe(true);
  });

  it("still finds a non-connection by handle — a co-host need not be a connection", async () => {
    const { app } = buildApp();
    const res = await req(app, searchPath("bo"), ORGANISER);
    const body = await profiles(res);
    expect(body.map((p) => p.handle)).toEqual(["bob"]);
    expect(body[0]!.connected).toBe(false);
  });

  it("never suggests the caller to themselves", async () => {
    // The caller IS usr_alice here, and "al" would otherwise match her.
    const { app } = buildApp();
    const res = await req(app, searchPath("al"), "usr_alice");
    const body = await profiles(res);
    expect(body.map((p) => p.handle)).toEqual(["alina"]);
    // usr_alice is not this caller's connection, so nothing is flagged.
    expect(body[0]!.connected).toBe(false);
  });

  it("filters the caller out of the CONNECTIONS source too, not just the global one", async () => {
    // The test above only exercises the global loop, because the connection
    // stub returns nothing for a non-ORGANISER caller. Seeding the caller into
    // the connections result is what proves both loops honour the self-filter.
    const { app } = buildApp({
      resolveOsnConnectionSearch: async () => [
        { profileId: ORGANISER, handle: "organiser", displayName: "Me" },
        { profileId: "usr_zoe", handle: "zoe", displayName: "Zoe" },
      ],
      resolveOsnHandleSearch: async () => [],
    });
    const res = await req(app, searchPath("o"), ORGANISER);
    expect((await profiles(res)).map((p) => p.handle)).toEqual(["zoe"]);
  });

  it("skips the global search below its 2-char floor (osn-api would answer empty)", async () => {
    let globalCalls = 0;
    let connectionCalls = 0;
    const { app } = buildApp({
      resolveOsnHandleSearch: async () => {
        globalCalls++;
        return [];
      },
      resolveOsnConnectionSearch: async () => {
        connectionCalls++;
        return [];
      },
    });
    // "@a" normalises to "a" — one character, below osn-api's floor. Calling it
    // would cost an ARC signature and a round trip to be handed back nothing.
    for (const q of ["a", "@", "@a"]) {
      // eslint-disable-next-line no-await-in-loop -- sequential assertions
      const res = await req(app, searchPath(q), ORGANISER);
      expect(res.status).toBe(200);
    }
    expect(globalCalls).toBe(0);
    // The connection source has no floor — it searches the caller's own graph.
    expect(connectionCalls).toBe(3);

    // Two characters clears the floor and the global source runs.
    await req(app, searchPath("al"), ORGANISER);
    expect(globalCalls).toBe(1);
  });

  it("scopes connections to the calling organiser, not to whoever asks", async () => {
    const { app } = buildApp();
    // A different signed-in organiser has no connections in the stub — they get
    // global matches only, none of them flagged as connected.
    const res = await req(app, searchPath("al"), "usr_someone_else");
    const body = await profiles(res);
    expect(body.map((p) => p.handle)).toEqual(["alice", "alina"]);
    expect(body.some((p) => p.connected)).toBe(false);
  });

  it("caps the merged list at 8 suggestions", async () => {
    const many: OsnHandleSuggestion[] = Array.from({ length: 12 }, (_, i) => ({
      profileId: `usr_${i}`,
      handle: `user${i}`,
      displayName: null,
    }));
    const { app } = buildApp({
      resolveOsnConnectionSearch: async () => many.slice(0, 6),
      resolveOsnHandleSearch: async () => many.slice(6),
    });
    const res = await req(app, searchPath("user"), ORGANISER);
    const body = await profiles(res);
    expect(body).toHaveLength(8);
    // The cap is applied after ranking, so all 6 connections survive it.
    expect(body.filter((p) => p.connected)).toHaveLength(6);
  });

  it("caps at 8 when the connections source alone overflows it", async () => {
    // Exercises the break in the FIRST loop — the branch the mixed test above
    // never reaches. A cap applied only after merging would pass that one.
    const many: OsnHandleSuggestion[] = Array.from({ length: 10 }, (_, i) => ({
      profileId: `usr_${i}`,
      handle: `user${i}`,
      displayName: null,
    }));
    const { app } = buildApp({
      resolveOsnConnectionSearch: async () => many,
      resolveOsnHandleSearch: async () => [
        { profileId: "usr_global", handle: "userglobal", displayName: null },
      ],
    });
    const res = await req(app, searchPath("user"), ORGANISER);
    const body = await profiles(res);
    expect(body).toHaveLength(8);
    expect(body.every((p) => p.connected)).toBe(true);
    // The global result is crowded out entirely — connections rank first.
    expect(body.some((p) => p.handle === "userglobal")).toBe(false);
  });

  it("falls back to the global search when no connection resolver is configured", async () => {
    const { app } = buildApp({ resolveOsnConnectionSearch: undefined });
    const res = await req(app, searchPath("al"), ORGANISER);
    expect(res.status).toBe(200);
    const body = await profiles(res);
    expect(body.map((p) => p.handle)).toEqual(["alice", "alina"]);
    expect(body.some((p) => p.connected)).toBe(false);
  });

  it("serves connections alone when no global search resolver is configured", async () => {
    const { app } = buildApp({ resolveOsnHandleSearch: undefined });
    const res = await req(app, searchPath("al"), ORGANISER);
    expect(res.status).toBe(200);
    expect((await profiles(res)).map((p) => p.handle)).toEqual(["alina"]);
  });

  it("returns an empty list (503-free) when no ARC resolver at all is configured", async () => {
    const { app } = buildApp({
      resolveOsnHandleSearch: undefined,
      resolveOsnConnectionSearch: undefined,
    });
    const res = await req(app, searchPath("al"), ORGANISER);
    expect(res.status).toBe(200);
    expect(await profiles(res)).toEqual([]);
  });

  it("FAIL-SOFT: returns an empty list (never 500) when both resolvers throw", async () => {
    const { app } = buildApp({
      resolveOsnHandleSearch: throwingSearch,
      resolveOsnConnectionSearch: throwingConnections,
    });
    const res = await req(app, searchPath("al"), ORGANISER);
    expect(res.status).toBe(200);
    expect(await profiles(res)).toEqual([]);
  });

  it("FAIL-SOFT: a throwing connection lookup does not lose the global matches", async () => {
    // One source failing must degrade that source only — the organiser can still
    // find and add a co-host by typing their handle in full.
    const { app } = buildApp({ resolveOsnConnectionSearch: throwingConnections });
    const res = await req(app, searchPath("al"), ORGANISER);
    expect(res.status).toBe(200);
    expect((await profiles(res)).map((p) => p.handle)).toEqual(["alice", "alina"]);
  });

  it("FAIL-SOFT: a throwing global search does not lose the connections", async () => {
    const { app } = buildApp({ resolveOsnHandleSearch: throwingSearch });
    const res = await req(app, searchPath("al"), ORGANISER);
    expect(res.status).toBe(200);
    const body = await profiles(res);
    expect(body.map((p) => p.handle)).toEqual(["alina"]);
    expect(body[0]!.connected).toBe(true);
  });

  it("rate-limits keystroke spam (per-IP limiter on this route)", async () => {
    const { app } = buildApp({
      handleSearchLimiter: createRateLimiter({ maxRequests: 2, windowMs: 60_000 }),
    });
    const first = await req(app, searchPath("al"), ORGANISER);
    const second = await req(app, searchPath("al"), ORGANISER);
    const third = await req(app, searchPath("al"), ORGANISER);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });
});

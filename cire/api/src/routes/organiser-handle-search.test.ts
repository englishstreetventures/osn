import { describe, it, expect, beforeAll } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";

import { createApp } from "../app";
import type { AppOptions } from "../app";
import { createDb } from "../db/setup";
import type { OsnHandleSearchResolver, OsnHandleSuggestion } from "../services/osn-bridge";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

const ORGANISER = "usr_organiser";

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/** Search stub: prefix-matches a small fixed handle set, mirrors osn-api shape. */
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

/** Search resolver that throws — stands in for osn-api returning a 5xx. */
const throwingSearch: OsnHandleSearchResolver = async () => {
  throw new Error("osn-api 500");
};

function buildApp(overrides: Partial<AppOptions> = {}) {
  const db = createDb(":memory:");
  const app = createApp(db, {
    osnTestKey: auth.key,
    resolveOsnHandleSearch: stubSearch,
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

describe("GET /api/organiser/handle-search", () => {
  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    const res = await req(app, searchPath("al"));
    expect(res.status).toBe(401);
  });

  it("returns prefix matches for a signed-in organiser (no wedding scope needed)", async () => {
    const { app } = buildApp();
    const res = await req(app, searchPath("al"), ORGANISER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: OsnHandleSuggestion[] };
    expect(body.profiles.map((p) => p.handle)).toEqual(["alice", "alina"]);
    expect(body.profiles[0]).toEqual({
      profileId: "usr_alice",
      handle: "alice",
      displayName: "Alice",
    });
  });

  it("returns an empty list for a blank query", async () => {
    const { app } = buildApp();
    const res = await req(app, searchPath("   "), ORGANISER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: OsnHandleSuggestion[] };
    expect(body.profiles).toEqual([]);
  });

  it("returns an empty list when the query param is missing entirely", async () => {
    const { app } = buildApp();
    const res = await req(app, "/api/organiser/handle-search", ORGANISER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: OsnHandleSuggestion[] };
    expect(body.profiles).toEqual([]);
  });

  it("returns an empty list (503-free) when no ARC search resolver is configured", async () => {
    const { app } = buildApp({ resolveOsnHandleSearch: undefined });
    const res = await req(app, searchPath("al"), ORGANISER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: OsnHandleSuggestion[] };
    expect(body.profiles).toEqual([]);
  });

  it("FAIL-SOFT: returns an empty list (never 500) when the resolver throws", async () => {
    const { app } = buildApp({ resolveOsnHandleSearch: throwingSearch });
    const res = await req(app, searchPath("al"), ORGANISER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: OsnHandleSuggestion[] };
    expect(body.profiles).toEqual([]);
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

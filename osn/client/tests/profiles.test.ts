import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import { OsnAuth, createOsnAuthLive } from "../src/service";
import { createMemoryStorage } from "../src/storage";

const config = { issuerUrl: "https://osn.example.com", clientId: "test-client" };

function createTestLayer() {
  return createOsnAuthLive(config).pipe(Layer.provide(createMemoryStorage()));
}

type JsonResponse = { status?: number; body: unknown };

/**
 * Stub `fetch` with routing by request pathname. Every unstubbed path 404s —
 * surfaces missing mocks quickly in tests.
 */
function stubFetchByPath(handlers: Record<string, JsonResponse | JsonResponse[]>): {
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const consumed: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      const pathname = new URL(url).pathname;
      const entry = handlers[pathname];
      if (!entry) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: "Unstubbed path: " + pathname }),
        });
      }
      const match = Array.isArray(entry)
        ? (entry[consumed[pathname] ?? 0] ?? entry[entry.length - 1]!)
        : entry;
      consumed[pathname] = (consumed[pathname] ?? 0) + 1;
      return Promise.resolve({
        ok: (match.status ?? 200) < 400,
        status: match.status ?? 200,
        json: () => Promise.resolve(match.body),
      });
    }),
  );
  return { calls };
}

function meFor(profileId: string, handle = "alice") {
  return {
    profile: {
      id: profileId,
      handle,
      email: "a@b.com",
      displayName: null,
      avatarUrl: null,
    },
    activeProfileId: profileId,
    scopes: ["openid", "profile"],
  };
}

/** Seeds an account session for the given profile. Requires a fetch stub for /me. */
function seedSession(profileId = "usr_aaaaaaaaaaaa") {
  return Effect.flatMap(OsnAuth, (auth) =>
    auth.setSession({
      accessToken: `acc_${profileId}`,
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: ["openid", "profile"],
    }),
  );
}

// ---------------------------------------------------------------------------
// getActiveProfile
// ---------------------------------------------------------------------------

it.effect("getActiveProfile returns null before login", () =>
  Effect.gen(function* () {
    const auth = yield* OsnAuth;
    const active = yield* auth.getActiveProfile();
    expect(active).toBeNull();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("getActiveProfile returns the profile ID after setSession", () =>
  Effect.gen(function* () {
    stubFetchByPath({ "/me": { body: meFor("usr_aaaaaaaaaaaa") } });
    const auth = yield* OsnAuth;
    yield* seedSession("usr_aaaaaaaaaaaa");
    const active = yield* auth.getActiveProfile();
    expect(active).toBe("usr_aaaaaaaaaaaa");
    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// getSession reconstructs from account session model
// ---------------------------------------------------------------------------

it.effect("getSession returns a Session reconstructed from the account session", () =>
  Effect.gen(function* () {
    stubFetchByPath({ "/me": { body: meFor("usr_aaaaaaaaaaaa") } });
    const auth = yield* OsnAuth;
    yield* seedSession("usr_aaaaaaaaaaaa");
    const session = yield* auth.getSession();
    expect(session).not.toBeNull();
    expect(session?.scopes).toEqual(["openid", "profile"]);
    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// listProfiles
// ---------------------------------------------------------------------------

it.effect("listProfiles calls GET /profiles/list with Bearer auth and returns the profiles", () =>
  Effect.gen(function* () {
    const profiles = [
      {
        id: "usr_aaaaaaaaaaaa",
        handle: "alice",
        email: "a@b.com",
        displayName: null,
        avatarUrl: null,
      },
      {
        id: "usr_bbbbbbbbbbbb",
        handle: "bob",
        email: "a@b.com",
        displayName: "Bob",
        avatarUrl: null,
      },
    ];

    const { calls } = stubFetchByPath({
      "/me": { body: meFor("usr_aaaaaaaaaaaa") },
      "/profiles/list": { body: { profiles } },
    });

    const auth = yield* OsnAuth;
    yield* seedSession();
    const result = yield* auth.listProfiles();

    expect(result).toEqual(profiles);
    const listCall = calls.find((c) => c.url.endsWith("/profiles/list"));
    expect(listCall?.init?.method).toBe("GET");
    const headers = (listCall?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("listProfiles fails with ProfileManagementError when no session exists", () =>
  Effect.gen(function* () {
    const auth = yield* OsnAuth;
    const error = yield* Effect.flip(auth.listProfiles());
    expect(error._tag).toBe("ProfileManagementError");
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// switchProfile
// ---------------------------------------------------------------------------

it.effect("switchProfile updates the active profile and caches the new access token", () =>
  Effect.gen(function* () {
    const newProfileId = "usr_bbbbbbbbbbbb";
    const newAccessToken = `acc_${newProfileId}`;

    stubFetchByPath({
      "/me": { body: meFor("usr_aaaaaaaaaaaa") },
      "/profiles/switch": {
        body: {
          access_token: newAccessToken,
          expires_in: 3600,
          profile: {
            id: newProfileId,
            handle: "alt",
            email: "a@b.com",
            displayName: null,
            avatarUrl: null,
          },
        },
      },
    });

    const auth = yield* OsnAuth;
    yield* seedSession("usr_aaaaaaaaaaaa");

    const { session, profile } = yield* auth.switchProfile(newProfileId);

    expect(session.accessToken).toBe(newAccessToken);
    expect(profile.id).toBe(newProfileId);
    expect(profile.handle).toBe("alt");

    const active = yield* auth.getActiveProfile();
    expect(active).toBe(newProfileId);

    const currentSession = yield* auth.getSession();
    expect(currentSession?.accessToken).toBe(newAccessToken);

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// createProfile
// ---------------------------------------------------------------------------

it.effect("createProfile calls POST /profiles/create and returns the new profile", () =>
  Effect.gen(function* () {
    const newProfile = {
      id: "usr_cccccccccccc",
      handle: "charlie",
      email: "a@b.com",
      displayName: "Charlie",
      avatarUrl: null,
    };

    const { calls } = stubFetchByPath({
      "/me": { body: meFor("usr_aaaaaaaaaaaa") },
      "/profiles/create": { body: { profile: newProfile } },
    });

    const auth = yield* OsnAuth;
    yield* seedSession();
    const result = yield* auth.createProfile("charlie", "Charlie");

    expect(result).toEqual(newProfile);

    const createCall = calls.find((c) => c.url.endsWith("/profiles/create"))!;
    const headers = (createCall.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);
    const body = JSON.parse(createCall.init?.body as string);
    expect(body.handle).toBe("charlie");
    expect(body.display_name).toBe("Charlie");
    expect(body.refresh_token).toBeUndefined();

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("createProfile omits display_name when not provided", () =>
  Effect.gen(function* () {
    const { calls } = stubFetchByPath({
      "/me": { body: meFor("usr_aaaaaaaaaaaa") },
      "/profiles/create": {
        body: {
          profile: {
            id: "usr_cccccccccccc",
            handle: "charlie",
            email: "a@b.com",
            displayName: null,
            avatarUrl: null,
          },
        },
      },
    });

    const auth = yield* OsnAuth;
    yield* seedSession();
    yield* auth.createProfile("charlie");

    const createCall = calls.find((c) => c.url.endsWith("/profiles/create"))!;
    const body = JSON.parse(createCall.init?.body as string);
    expect(body.display_name).toBeUndefined();

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// deleteProfile
// ---------------------------------------------------------------------------

it.effect("deleteProfile removes the profile token from storage", () =>
  Effect.gen(function* () {
    const profileToDelete = "usr_bbbbbbbbbbbb";

    stubFetchByPath({
      "/me": { body: meFor("usr_aaaaaaaaaaaa") },
      "/profiles/switch": [
        {
          body: {
            access_token: `acc_${profileToDelete}`,
            expires_in: 3600,
            profile: {
              id: profileToDelete,
              handle: "alt",
              email: "a@b.com",
              displayName: null,
              avatarUrl: null,
            },
          },
        },
        {
          body: {
            access_token: "acc_usr_aaaaaaaaaaaa",
            expires_in: 3600,
            profile: {
              id: "usr_aaaaaaaaaaaa",
              handle: "main",
              email: "a@b.com",
              displayName: null,
              avatarUrl: null,
            },
          },
        },
      ],
      "/profiles/delete": { body: { deleted: true } },
    });

    const auth = yield* OsnAuth;
    yield* seedSession("usr_aaaaaaaaaaaa");

    yield* auth.switchProfile(profileToDelete);
    yield* auth.switchProfile("usr_aaaaaaaaaaaa");
    yield* auth.deleteProfile(profileToDelete);

    const active = yield* auth.getActiveProfile();
    expect(active).toBe("usr_aaaaaaaaaaaa");

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("deleteProfile switches active profile when deleting the current one", () =>
  Effect.gen(function* () {
    stubFetchByPath({
      "/me": { body: meFor("usr_aaaaaaaaaaaa") },
      "/profiles/switch": {
        body: {
          access_token: "acc_usr_bbbbbbbbbbbb",
          expires_in: 3600,
          profile: {
            id: "usr_bbbbbbbbbbbb",
            handle: "alt",
            email: "a@b.com",
            displayName: null,
            avatarUrl: null,
          },
        },
      },
      "/profiles/delete": { body: { deleted: true } },
    });

    const auth = yield* OsnAuth;
    yield* seedSession("usr_aaaaaaaaaaaa");

    yield* auth.switchProfile("usr_bbbbbbbbbbbb");
    expect(yield* auth.getActiveProfile()).toBe("usr_bbbbbbbbbbbb");

    yield* auth.deleteProfile("usr_bbbbbbbbbbbb");

    const active = yield* auth.getActiveProfile();
    expect(active).toBe("usr_aaaaaaaaaaaa");

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// logout clears everything
// ---------------------------------------------------------------------------

it.effect("logout clears both account session and legacy keys", () =>
  Effect.gen(function* () {
    stubFetchByPath({
      "/me": { body: meFor("usr_aaaaaaaaaaaa") },
      "/logout": { body: { success: true } },
    });
    const auth = yield* OsnAuth;
    yield* seedSession();

    yield* auth.logout();

    expect(yield* auth.getSession()).toBeNull();
    expect(yield* auth.getActiveProfile()).toBeNull();

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

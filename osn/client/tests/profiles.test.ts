import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import { OsnAuth, createOsnAuthLive } from "../src/service";
import { createMemoryStorage } from "../src/storage";

const config = { issuerUrl: "https://osn.example.com" };

function createTestLayer() {
  return createOsnAuthLive(config).pipe(Layer.provide(createMemoryStorage()));
}

/** Build a fake JWT whose payload contains the given `sub` claim. */
function fakeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub, iat: Date.now() }));
  return `${header}.${payload}.fake_signature`;
}

function seedSession(profileId = "usr_aaaaaaaaaaaa") {
  return Effect.flatMap(OsnAuth, (auth) =>
    auth.setSession({
      accessToken: fakeJwt(profileId),
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
    const auth = yield* OsnAuth;
    yield* seedSession("usr_aaaaaaaaaaaa");
    const active = yield* auth.getActiveProfile();
    expect(active).toBe("usr_aaaaaaaaaaaa");
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// getSession reconstructs from account session model
// ---------------------------------------------------------------------------

it.effect("getSession returns a Session reconstructed from the account session", () =>
  Effect.gen(function* () {
    const auth = yield* OsnAuth;
    yield* seedSession("usr_aaaaaaaaaaaa");
    const session = yield* auth.getSession();
    expect(session).not.toBeNull();
    expect(session?.accessToken).toBeTruthy();
    expect(session?.scopes).toEqual(["openid", "profile"]);
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

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ profiles }),
      }),
    );

    const auth = yield* OsnAuth;
    yield* seedSession();
    const result = yield* auth.listProfiles();

    expect(result).toEqual(profiles);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://osn.example.com/profiles/list",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer /) }),
      }),
    );

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
    const newAccessToken = fakeJwt(newProfileId);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: newAccessToken,
            expires_in: 3600,
            profile: {
              id: newProfileId,
              handle: "alt",
              email: "a@b.com",
              displayName: null,
              avatarUrl: null,
            },
          }),
      }),
    );

    const auth = yield* OsnAuth;
    yield* seedSession("usr_aaaaaaaaaaaa");

    const { session, profile } = yield* auth.switchProfile(newProfileId);

    expect(session.accessToken).toBe(newAccessToken);
    expect(profile.id).toBe(newProfileId);
    expect(profile.handle).toBe("alt");

    // Active profile should be updated
    const active = yield* auth.getActiveProfile();
    expect(active).toBe(newProfileId);

    // getSession should return the switched profile's session
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

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ profile: newProfile }),
      }),
    );

    const auth = yield* OsnAuth;
    yield* seedSession();
    const result = yield* auth.createProfile("charlie", "Charlie");

    expect(result).toEqual(newProfile);

    const call = vi.mocked(fetch).mock.calls[0]!;
    const headers = call[1]!.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);
    const body = JSON.parse(call[1]!.body as string);
    expect(body.handle).toBe("charlie");
    expect(body.display_name).toBe("Charlie");
    expect(body.refresh_token).toBeUndefined();

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("createProfile omits display_name when not provided", () =>
  Effect.gen(function* () {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            profile: {
              id: "usr_cccccccccccc",
              handle: "charlie",
              email: "a@b.com",
              displayName: null,
              avatarUrl: null,
            },
          }),
      }),
    );

    const auth = yield* OsnAuth;
    yield* seedSession();
    yield* auth.createProfile("charlie");

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
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

    vi.stubGlobal("fetch", vi.fn());

    // First mock: switchProfile to cache a second profile token
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: fakeJwt(profileToDelete),
          expires_in: 3600,
          profile: {
            id: profileToDelete,
            handle: "alt",
            email: "a@b.com",
            displayName: null,
            avatarUrl: null,
          },
        }),
    } as Response);

    // Second mock: switch back to original
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: fakeJwt("usr_aaaaaaaaaaaa"),
          expires_in: 3600,
          profile: {
            id: "usr_aaaaaaaaaaaa",
            handle: "main",
            email: "a@b.com",
            displayName: null,
            avatarUrl: null,
          },
        }),
    } as Response);

    // Third mock: deleteProfile
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ deleted: true }),
    } as Response);

    const auth = yield* OsnAuth;
    yield* seedSession("usr_aaaaaaaaaaaa");

    // Switch to second profile (caches its token)
    yield* auth.switchProfile(profileToDelete);
    // Switch back
    yield* auth.switchProfile("usr_aaaaaaaaaaaa");

    // Delete the second profile
    yield* auth.deleteProfile(profileToDelete);

    // Active profile should still be the original
    const active = yield* auth.getActiveProfile();
    expect(active).toBe("usr_aaaaaaaaaaaa");

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("deleteProfile switches active profile when deleting the current one", () =>
  Effect.gen(function* () {
    vi.stubGlobal("fetch", vi.fn());

    // Mock: switchProfile to a second profile
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: fakeJwt("usr_bbbbbbbbbbbb"),
          expires_in: 3600,
          profile: {
            id: "usr_bbbbbbbbbbbb",
            handle: "alt",
            email: "a@b.com",
            displayName: null,
            avatarUrl: null,
          },
        }),
    } as Response);

    // Mock: deleteProfile
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ deleted: true }),
    } as Response);

    const auth = yield* OsnAuth;
    yield* seedSession("usr_aaaaaaaaaaaa");

    // Switch to second profile
    yield* auth.switchProfile("usr_bbbbbbbbbbbb");
    expect(yield* auth.getActiveProfile()).toBe("usr_bbbbbbbbbbbb");

    // Delete the active (second) profile
    yield* auth.deleteProfile("usr_bbbbbbbbbbbb");

    // Should have fallen back to the original profile
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
    const auth = yield* OsnAuth;
    yield* seedSession();

    yield* auth.logout();

    expect(yield* auth.getSession()).toBeNull();
    expect(yield* auth.getActiveProfile()).toBeNull();
  }).pipe(Effect.provide(createTestLayer())),
);

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isAuthExpiredError } from "../src/errors";
import { createOsnAuthRuntime, type OsnAuthRuntime, type SessionChange } from "../src/runtime";
import { OsnAuth } from "../src/service";
import { Storage, createEphemeralStorage } from "../src/storage";
import { extractJwtSub, type AccountSession } from "../src/tokens";

/**
 * The page's one auth runtime: every authenticated client sends through its
 * `authFetch`. One test per way the renewal can fail that the E2E flow cannot
 * reach (NEW-FEAT.md F1–F19; F19's provider half is in `solid/context.test.tsx`).
 */

const ISSUER = "https://osn.example.com";
const API = `${ISSUER}/thing`;
const KEY = "@osn/client:account_session";
const DEFAULT = "usr_default00001";
const OTHER = "usr_other0000001";

afterEach(() => {
  vi.unstubAllGlobals();
});

const nowSec = () => Math.floor(Date.now() / 1000);

/** An unsigned JWT: the client reads `sub`, `iat` and `exp` without verifying. */
function jwt(claims: { sub: string; iat?: number; exp?: number; n?: number }): string {
  const enc = (o: object) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

/** A stored token for `sub` that expires in `ms`, with a 300 s lifetime in its claims. */
function token(sub: string, ms: number, n = 0) {
  const exp = nowSec() + Math.round(ms / 1000);
  return { accessToken: jwt({ sub, iat: exp - 300, exp, n }), expiresAt: Date.now() + ms };
}

function account(active: string, tokens: AccountSession["profileTokens"]): AccountSession {
  return {
    hasSession: true,
    activeProfileId: active,
    profileTokens: tokens,
    scopes: [],
    idToken: null,
  };
}

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let grants = 0;
/** What `/token` answers: a fresh token for the default profile. */
function grant(): Response {
  grants += 1;
  return json(200, {
    access_token: jwt({ sub: DEFAULT, iat: nowSec(), exp: nowSec() + 300, n: grants }),
    token_type: "Bearer",
    expires_in: 300,
    scope: "openid profile",
  });
}

function switched(profileId: string): Response {
  return json(200, {
    access_token: jwt({ sub: profileId, iat: nowSec(), exp: nowSec() + 300 }),
    expires_in: 300,
    profile: {
      id: profileId,
      handle: "other",
      email: "o@example.com",
      displayName: null,
      avatarUrl: null,
    },
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

type Route = (call: Call) => Response | Promise<Response>;

/** Stubs `fetch` with one handler per path; records every call. */
function stubFetch(routes: { token?: Route; switch?: Route; api?: Route }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      if (call.url === `${ISSUER}/token`) return (routes.token ?? grant)(call);
      if (call.url === `${ISSUER}/profiles/switch`)
        return (routes.switch ?? (() => switched(OTHER)))(call);
      return (routes.api ?? (() => json(200, { ok: true })))(call);
    }),
  );
  return {
    calls,
    to: (path: string) => calls.filter((c) => c.url === `${ISSUER}${path}`),
    api: () => calls.filter((c) => c.url === API),
  };
}

const bearer = (call: Call | undefined) =>
  call ? new Headers(call.init.headers).get("authorization") : null;

interface Harness {
  runtime: OsnAuthRuntime;
  changes: SessionChange[];
  stored: () => AccountSession | null;
}

function harness(seed?: AccountSession, storage = createEphemeralStorage()): Harness {
  if (seed) write(storage, seed);
  const runtime = createOsnAuthRuntime({ issuerUrl: ISSUER }, { storage });
  const changes: SessionChange[] = [];
  runtime.onSessionChange((change) => changes.push(change));
  return { runtime, changes, stored: () => read(storage) };
}

function write(storage: Layer.Layer<Storage>, value: AccountSession) {
  Effect.runSync(
    Effect.flatMap(Storage, (s) => s.set(KEY, JSON.stringify(value))).pipe(Effect.provide(storage)),
  );
}

function read(storage: Layer.Layer<Storage>): AccountSession | null {
  const raw = Effect.runSync(
    Effect.flatMap(Storage, (s) => s.get(KEY)).pipe(Effect.provide(storage)),
  );
  return raw ? (JSON.parse(raw) as AccountSession) : null;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

const tagOf = (err: unknown) => (err as { _tag?: string })._tag;

describe("authFetch on the page's runtime", () => {
  it("F1: a retry that is refused again ends the session and tells the listeners", async () => {
    const fetches = stubFetch({ api: () => json(401) });
    const { runtime, changes, stored } = harness(
      account(DEFAULT, { [DEFAULT]: token(DEFAULT, 120_000) }),
    );

    const err = await rejection(runtime.authFetch(API));

    expect(isAuthExpiredError(err)).toBe(true);
    expect(fetches.api()).toHaveLength(2);
    expect(fetches.to("/token")).toHaveLength(1);
    expect(changes).toEqual([{ kind: "ended" }]);
    expect(stored()).toBeNull();
  });

  it("F2: a 403 step-up refusal is returned as-is, with no refresh and the session kept", async () => {
    const fetches = stubFetch({ api: () => json(403, { error: "step_up_required" }) });
    const { runtime, changes, stored } = harness(
      account(DEFAULT, { [DEFAULT]: token(DEFAULT, 120_000) }),
    );

    const res = await runtime.authFetch(API, { method: "POST" });

    expect(res.status).toBe(403);
    expect(fetches.to("/token")).toHaveLength(0);
    expect(changes).toEqual([]);
    expect(stored()?.activeProfileId).toBe(DEFAULT);
  });

  it("F3: a caller-supplied Authorization header is replaced by the account's token", async () => {
    const fetches = stubFetch({});
    const live = token(DEFAULT, 120_000);
    const { runtime } = harness(account(DEFAULT, { [DEFAULT]: live }));

    await runtime.authFetch(API, {
      headers: { Authorization: "Bearer someone-elses", "X-Step-Up-Token": "su" },
    });

    const sent = new Headers(fetches.api()[0]!.init.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${live.accessToken}`);
    expect(sent.get("x-step-up-token")).toBe("su");
  });

  it("F4: renewing a non-default profile switches back to it and never sends the default's token", async () => {
    const fetches = stubFetch({});
    const { runtime, stored } = harness(account(OTHER, { [OTHER]: token(OTHER, -1_000) }));

    const res = await runtime.authFetch(API);

    expect(res.status).toBe(200);
    const [switchCall] = fetches.to("/profiles/switch");
    expect(switchCall?.init.credentials).toBe("include");
    expect(JSON.parse(String(switchCall?.init.body))).toEqual({ profile_id: OTHER });
    expect(fetches.api()).toHaveLength(1);
    expect(extractJwtSub(bearer(fetches.api()[0])!.slice("Bearer ".length))).toBe(OTHER);
    expect(stored()?.activeProfileId).toBe(OTHER);
  });

  it.each([400, 429])(
    "F5: a re-switch answered %i falls back to the default profile and sends nothing",
    async (status) => {
      const fetches = stubFetch({ switch: () => json(status, { error: "invalid_request" }) });
      const { runtime, changes, stored } = harness(
        account(OTHER, { [OTHER]: token(OTHER, -1_000) }),
      );

      const err = await rejection(runtime.authFetch(API));

      expect(tagOf(err)).toBe("ActiveProfileResetError");
      expect(isAuthExpiredError(err)).toBe(false);
      expect(fetches.api()).toHaveLength(0);
      expect(changes).toEqual([{ kind: "profile-reset", profileId: DEFAULT }]);
      expect(stored()?.activeProfileId).toBe(DEFAULT);
    },
  );

  it("F6: a re-switch answered 401 ends the session and sends nothing", async () => {
    const fetches = stubFetch({ switch: () => json(401, { error: "unauthorized" }) });
    const { runtime, changes, stored } = harness(account(OTHER, { [OTHER]: token(OTHER, -1_000) }));

    const err = await rejection(runtime.authFetch(API));

    expect(isAuthExpiredError(err)).toBe(true);
    expect(fetches.api()).toHaveLength(0);
    expect(changes).toEqual([{ kind: "ended" }]);
    expect(stored()).toBeNull();
  });

  it("F7: concurrent calls with an expired token share one grant", async () => {
    const fetches = stubFetch({
      token: () => new Promise((resolve) => setTimeout(() => resolve(grant()), 10)),
    });
    const { runtime } = harness(account(DEFAULT, { [DEFAULT]: token(DEFAULT, -1_000) }));

    const results = await Promise.all([
      runtime.authFetch(API),
      runtime.authFetch(API),
      runtime.authFetch(API),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(fetches.to("/token")).toHaveLength(1);
    expect(new Set(fetches.api().map(bearer)).size).toBe(1);
  });

  it.each([
    {
      name: "the body names the rotation race",
      body: { error: "invalid_grant", message: "AuthError: Session rotated by a concurrent grant" },
      marker: false,
    },
    {
      name: "the browser's session marker survived the response",
      body: { error: "invalid_grant", message: "AuthError: something else" },
      marker: true,
    },
  ])(
    "F8: a refusal that leaves the session's status unknown ($name) is retried once",
    async (c) => {
      if (c.marker) vi.stubGlobal("document", { cookie: "osn_has_session=1" });
      let tokenCalls = 0;
      const fetches = stubFetch({
        token: () => (++tokenCalls === 1 ? json(400, c.body) : grant()),
      });
      const { runtime, changes, stored } = harness(
        account(DEFAULT, { [DEFAULT]: token(DEFAULT, -1_000) }),
      );

      const res = await runtime.authFetch(API);

      expect(res.status).toBe(200);
      expect(fetches.to("/token")).toHaveLength(2);
      expect(changes).toEqual([]);
      expect(stored()?.activeProfileId).toBe(DEFAULT);
    },
  );

  it("F9: a refusal that clears the session marker ends the session without a retry", async () => {
    const jar = { cookie: "osn_has_session=1" };
    vi.stubGlobal("document", jar);
    const fetches = stubFetch({
      token: () => {
        jar.cookie = "";
        return json(400, {
          error: "invalid_grant",
          message: "AuthError: Invalid or expired session",
        });
      },
    });
    const { runtime, changes, stored } = harness(
      account(DEFAULT, { [DEFAULT]: token(DEFAULT, -1_000) }),
    );

    const err = await rejection(runtime.authFetch(API));

    expect(isAuthExpiredError(err)).toBe(true);
    expect(fetches.to("/token")).toHaveLength(1);
    expect(fetches.api()).toHaveLength(0);
    expect(changes).toEqual([{ kind: "ended" }]);
    expect(stored()).toBeNull();
  });

  it("F10: a grant that keeps answering 503 fails the call and keeps the session", async () => {
    const fetches = stubFetch({ token: () => json(503, { error: "upstream" }) });
    const { runtime, changes, stored } = harness(
      account(DEFAULT, { [DEFAULT]: token(DEFAULT, -1_000) }),
    );

    const err = await rejection(runtime.authFetch(API));

    expect(tagOf(err)).toBe("TokenRefreshError");
    expect(isAuthExpiredError(err)).toBe(false);
    expect(fetches.to("/token")).toHaveLength(3);
    expect(fetches.api()).toHaveLength(0);
    expect(changes).toEqual([]);
    expect(stored()?.activeProfileId).toBe(DEFAULT);
  });

  it("F11: a grant that cannot reach the issuer fails the call and keeps the session", async () => {
    stubFetch({
      token: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const { runtime, changes, stored } = harness(
      account(DEFAULT, { [DEFAULT]: token(DEFAULT, -1_000) }),
    );

    const err = await rejection(runtime.authFetch(API));

    expect(tagOf(err)).toBe("TokenRefreshError");
    expect(changes).toEqual([]);
    expect(stored()?.activeProfileId).toBe(DEFAULT);
  });

  it("F12: a re-switch answered 503 fails the call and keeps the session and the profile", async () => {
    const fetches = stubFetch({ switch: () => json(503, { error: "temporarily_unavailable" }) });
    const { runtime, changes, stored } = harness(account(OTHER, { [OTHER]: token(OTHER, -1_000) }));

    const err = await rejection(runtime.authFetch(API));

    expect(tagOf(err)).toBe("TokenRefreshError");
    expect(fetches.api()).toHaveLength(0);
    expect(changes).toEqual([]);
    expect(stored()?.activeProfileId).toBe(OTHER);
  });

  it("F13: a transport failure of the request reaches the caller unchanged", async () => {
    const failure = new TypeError("Failed to fetch");
    stubFetch({
      api: () => {
        throw failure;
      },
    });
    const { runtime, changes, stored } = harness(
      account(DEFAULT, { [DEFAULT]: token(DEFAULT, 120_000) }),
    );

    const err = await rejection(runtime.authFetch(API));

    expect(err).toBe(failure);
    expect(changes).toEqual([]);
    expect(stored()?.activeProfileId).toBe(DEFAULT);
  });

  it("F14: an aborted request rejects with its AbortError", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    stubFetch({
      api: () => {
        throw abort;
      },
    });
    const { runtime } = harness(account(DEFAULT, { [DEFAULT]: token(DEFAULT, 120_000) }));

    const err = await rejection(runtime.authFetch(API, { signal: AbortSignal.abort() }));

    expect(err).toBe(abort);
  });

  it("F15: a second runtime on the same storage adopts the token the first renewed", async () => {
    const fetches = stubFetch({});
    const storage = createEphemeralStorage();
    const first = harness(account(DEFAULT, { [DEFAULT]: token(DEFAULT, 10_000) }), storage);
    const second = harness(undefined, storage);
    // Both tabs have read the account before either renews.
    await second.runtime.run(Effect.flatMap(OsnAuth, (auth) => auth.getSession()));

    await first.runtime.authFetch(API);
    await second.runtime.authFetch(API);

    expect(fetches.to("/token")).toHaveLength(1);
    expect(bearer(fetches.api()[1])).toBe(bearer(fetches.api()[0]));
  });

  it("F16: the stored account removed by another runtime ends this one's session with no request", async () => {
    const fetches = stubFetch({});
    const storage = createEphemeralStorage();
    const { runtime, changes } = harness(
      account(DEFAULT, { [DEFAULT]: token(DEFAULT, 120_000) }),
      storage,
    );
    await runtime.run(Effect.flatMap(OsnAuth, (auth) => auth.getSession()));

    Effect.runSync(Effect.flatMap(Storage, (s) => s.remove(KEY)).pipe(Effect.provide(storage)));
    const err = await rejection(runtime.authFetch(API));

    expect(isAuthExpiredError(err)).toBe(true);
    expect(fetches.calls).toHaveLength(0);
    expect(changes).toEqual([{ kind: "ended" }]);
  });

  it("F17: a short-lived token is renewed at half its lifetime, not 30 s before expiry", async () => {
    const fetches = stubFetch({});
    const exp = nowSec() + 12;
    const short = {
      accessToken: jwt({ sub: DEFAULT, iat: exp - 20, exp }),
      expiresAt: Date.now() + 12_000,
    };
    const { runtime } = harness(account(DEFAULT, { [DEFAULT]: short }));

    await runtime.authFetch(API);

    expect(fetches.to("/token")).toHaveLength(0);
    expect(bearer(fetches.api()[0])).toBe(`Bearer ${short.accessToken}`);
  });

  it("F18: no token for the active profile renews and makes the grant's profile active", async () => {
    const fetches = stubFetch({});
    const { runtime, stored } = harness(account("", {}));

    const res = await runtime.authFetch(API);

    expect(res.status).toBe(200);
    expect(fetches.to("/token")).toHaveLength(1);
    expect(fetches.to("/profiles/switch")).toHaveLength(0);
    expect(stored()?.activeProfileId).toBe(DEFAULT);
  });

  it("F19: a listener that unsubscribed is not called", async () => {
    stubFetch({ api: () => json(401) });
    const { runtime, changes } = harness(account(DEFAULT, { [DEFAULT]: token(DEFAULT, 120_000) }));
    const gone: SessionChange[] = [];
    const unsubscribe = runtime.onSessionChange((change) => gone.push(change));
    unsubscribe();

    await rejection(runtime.authFetch(API));

    expect(changes).toEqual([{ kind: "ended" }]);
    expect(gone).toEqual([]);
  });
});

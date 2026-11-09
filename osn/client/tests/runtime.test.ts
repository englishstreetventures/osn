import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isAuthExpiredError } from "../src/errors";
import { createOsnAuthRuntime, type OsnAuthRuntime, type SessionChange } from "../src/runtime";
import { OsnAuth } from "../src/service";
import { Storage, createEphemeralStorage } from "../src/storage";
import { extractJwtSub, type ProfileToken } from "../src/tokens";

/**
 * The page's one auth runtime: every authenticated client sends through its
 * `authFetch`. One test per way the renewal can fail that the E2E flow cannot
 * reach (NEW-FEAT.md F1–F43; F19's provider half is in `solid/context.test.tsx`,
 * and what the stored account holds is in `token-storage.test.ts`).
 */

const ISSUER = "https://osn.example.com";
const API = `${ISSUER}/thing`;
const KEY = "@osn/client:account_session";
const DEFAULT = "usr_default00001";
const OTHER = "usr_other0000001";
const THIRD = "usr_third0000001";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Moves `Date.now()` forward; timers stay real, so Effect's sleeps still run. */
function advanceClock(ms: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** An unsigned JWT: the client reads `sub`, `iat` and `exp` without verifying. */
function jwt(claims: { sub: string; iat?: number; exp?: number; n?: number }): string {
  const enc = (o: object) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

/** A held token for `sub` that expires in `ms`, with a 300 s lifetime in its claims. */
function token(sub: string, ms: number, n = 0): ProfileToken {
  const exp = nowSec() + Math.round(ms / 1000);
  return { accessToken: jwt({ sub, iat: exp - 300, exp, n }), expiresAt: Date.now() + ms };
}

/**
 * The page before the test: the profile it is on, from the stored account, and
 * the token it holds in memory for that profile, if any. With no token, the
 * first call renews, as after a reload or once the token has expired.
 */
interface Seed {
  readonly active: string;
  readonly token?: ProfileToken;
}

/** What storage holds for a signed-in page: never a token. */
interface StoredAccount {
  readonly hasSession: boolean;
  readonly activeProfileId: string;
}

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

/** The `profile_id` a `/token` call named, if any. */
const namedProfile = (call: Call | undefined) =>
  call ? new URLSearchParams(String(call.init.body)).get("profile_id") : null;

let grants = 0;
/**
 * What `/token` answers: a fresh token for the profile the grant named, as
 * osn-api does for a profile the account owns, or for the default profile.
 * `sub` overrides it, standing for a profile the account no longer owns.
 */
function grant(call?: Call, claims?: { sub?: string }): Response {
  grants += 1;
  const sub = claims ? claims.sub : (namedProfile(call) ?? DEFAULT);
  return json(200, {
    access_token: jwt({
      ...(sub === undefined ? {} : { sub }),
      iat: nowSec(),
      exp: nowSec() + 300,
      n: grants,
    } as { sub: string }),
    token_type: "Bearer",
    expires_in: 300,
    scope: "openid profile",
  });
}

type Route = (call: Call) => Response | Promise<Response>;

/** Stubs `fetch` with one handler per path; records every call. */
function stubFetch(routes: { token?: Route; api?: Route }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      if (call.url === `${ISSUER}/token`) return (routes.token ?? grant)(call);
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

const bearerSub = (call: Call | undefined) =>
  extractJwtSub(bearer(call)?.slice("Bearer ".length) ?? "");

interface Harness {
  runtime: OsnAuthRuntime;
  changes: SessionChange[];
  stored: () => StoredAccount | null;
}

/** A page on `storage`. A seed token reaches the runtime the way a sign-in hands it one. */
async function harness(
  seed?: Seed,
  storage = createEphemeralStorage(),
  before?: (runtime: OsnAuthRuntime) => void,
): Promise<Harness> {
  if (seed) write(storage, { hasSession: true, activeProfileId: seed.active });
  const runtime = createOsnAuthRuntime({ issuerUrl: ISSUER }, { storage });
  const held = seed?.token;
  if (held) {
    await runtime.run(
      Effect.flatMap(OsnAuth, (auth) =>
        auth.setSession({
          accessToken: held.accessToken,
          idToken: null,
          expiresAt: held.expiresAt,
          scopes: [],
        }),
      ),
    );
  }
  before?.(runtime);
  const changes: SessionChange[] = [];
  runtime.onSessionChange((change) => changes.push(change));
  return { runtime, changes, stored: () => read(storage) };
}

function write(storage: Layer.Layer<Storage>, value: StoredAccount) {
  Effect.runSync(
    Effect.flatMap(Storage, (s) => s.set(KEY, JSON.stringify(value))).pipe(Effect.provide(storage)),
  );
}

function read(storage: Layer.Layer<Storage>): StoredAccount | null {
  const raw = Effect.runSync(
    Effect.flatMap(Storage, (s) => s.get(KEY)).pipe(Effect.provide(storage)),
  );
  return raw ? (JSON.parse(raw) as StoredAccount) : null;
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
    const { runtime, changes, stored } = await harness({
      active: DEFAULT,
      token: token(DEFAULT, 120_000),
    });

    const err = await rejection(runtime.authFetch(API));

    expect(isAuthExpiredError(err)).toBe(true);
    expect(fetches.api()).toHaveLength(2);
    expect(fetches.to("/token")).toHaveLength(1);
    expect(changes).toEqual([{ kind: "ended" }]);
    expect(stored()).toBeNull();
  });

  it("F2: a 403 step-up refusal is returned as-is, with no refresh and the session kept", async () => {
    const fetches = stubFetch({ api: () => json(403, { error: "step_up_required" }) });
    const { runtime, changes, stored } = await harness({
      active: DEFAULT,
      token: token(DEFAULT, 120_000),
    });

    const res = await runtime.authFetch(API, { method: "POST" });

    expect(res.status).toBe(403);
    expect(fetches.to("/token")).toHaveLength(0);
    expect(changes).toEqual([]);
    expect(stored()?.activeProfileId).toBe(DEFAULT);
  });

  it("F3: a caller-supplied Authorization header is replaced by the account's token", async () => {
    const fetches = stubFetch({});
    const live = token(DEFAULT, 120_000);
    const { runtime } = await harness({ active: DEFAULT, token: live });

    await runtime.authFetch(API, {
      headers: { Authorization: "Bearer someone-elses", "X-Step-Up-Token": "su" },
    });

    const sent = new Headers(fetches.api()[0]!.init.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${live.accessToken}`);
    expect(sent.get("x-step-up-token")).toBe("su");
  });

  it("F4: renewing a non-default profile names it in the grant and sends one request", async () => {
    const fetches = stubFetch({});
    const { runtime, changes, stored } = await harness({ active: OTHER });

    const res = await runtime.authFetch(API);

    expect(res.status).toBe(200);
    expect(fetches.to("/token")).toHaveLength(1);
    expect(namedProfile(fetches.to("/token")[0])).toBe(OTHER);
    expect(fetches.to("/profiles/switch")).toHaveLength(0);
    expect(fetches.api()).toHaveLength(1);
    expect(bearerSub(fetches.api()[0])).toBe(OTHER);
    expect(changes).toEqual([]);
    expect(stored()?.activeProfileId).toBe(OTHER);
  });

  it("F5: a grant for the default profile when another was named resets to it and sends nothing", async () => {
    // osn-api mints for the default profile when the account no longer owns
    // the one named.
    const fetches = stubFetch({ token: (call) => grant(call, { sub: DEFAULT }) });
    const { runtime, changes, stored } = await harness({ active: OTHER });

    const err = await rejection(runtime.authFetch(API));

    expect(tagOf(err)).toBe("ActiveProfileResetError");
    expect(isAuthExpiredError(err)).toBe(false);
    expect(fetches.to("/token")).toHaveLength(1);
    expect(fetches.api()).toHaveLength(0);
    expect(changes).toEqual([{ kind: "profile-reset", profileId: DEFAULT }]);
    expect(stored()?.activeProfileId).toBe(DEFAULT);
  });

  /**
   * A renewal that leaves on a 401, while the held token is still valid, and
   * a switch to `THIRD` that sends with that token and lands before the grant
   * answers. `answer` is what `/token` sends once the switch has landed.
   */
  async function renewalAcrossASwitch(answer: (call: Call) => Response) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let apiCalls = 0;
    const fetches = stubFetch({
      token: async (call) => {
        await released;
        return answer(call);
      },
      api: (call) => {
        if (call.url === `${ISSUER}/profiles/switch`) {
          return json(200, {
            access_token: jwt({ sub: THIRD, iat: nowSec(), exp: nowSec() + 300 }),
            expires_in: 300,
            profile: {
              id: THIRD,
              handle: "third",
              email: "third@example.com",
              displayName: null,
              avatarUrl: null,
            },
          });
        }
        apiCalls += 1;
        return apiCalls === 1 ? json(401) : json(200, { ok: true });
      },
    });
    const h = await harness({ active: OTHER, token: token(OTHER, 120_000) });

    const pending = h.runtime.authFetch(API).then(
      (res) => ({ res }),
      (err: unknown) => ({ err }),
    );
    await vi.waitFor(() => expect(fetches.to("/token")).toHaveLength(1));
    await h.runtime.run(Effect.flatMap(OsnAuth, (auth) => auth.switchProfile(THIRD)));
    release();
    return { ...h, fetches, outcome: await pending };
  }

  it("F37: a renewal that resolves after a profile switch keeps the switch", async () => {
    const { fetches, outcome, changes, stored } = await renewalAcrossASwitch(grant);

    expect(namedProfile(fetches.to("/token")[0])).toBe(OTHER);
    expect("res" in outcome && outcome.res.status).toBe(200);
    // The retry goes out as the profile the request was made as.
    expect(bearerSub(fetches.api()[1])).toBe(OTHER);
    expect(changes).toEqual([]);
    expect(stored()?.activeProfileId).toBe(THIRD);
  });

  it("F37b: a renewal for a gone profile, resolving after a switch, resets nothing", async () => {
    const { fetches, outcome, changes, stored } = await renewalAcrossASwitch((call) =>
      grant(call, { sub: DEFAULT }),
    );

    expect("err" in outcome && tagOf(outcome.err)).toBe("ActiveProfileResetError");
    expect(fetches.api()).toHaveLength(1);
    expect(changes).toEqual([]);
    expect(stored()?.activeProfileId).toBe(THIRD);
  });

  it("F7: concurrent calls with an expired token share one grant", async () => {
    const fetches = stubFetch({
      token: () => new Promise((resolve) => setTimeout(() => resolve(grant()), 10)),
    });
    const { runtime } = await harness({ active: DEFAULT });

    const results = await Promise.all([
      runtime.authFetch(API),
      runtime.authFetch(API),
      runtime.authFetch(API),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(fetches.to("/token")).toHaveLength(1);
    expect(new Set(fetches.api().map(bearer)).size).toBe(1);
  });

  it("F7b: a grant for another profile is not joined; it waits for the one in flight", async () => {
    // A held session's grant names no profile while a renewal wants OTHER.
    // Joining that grant would hand the renewal the default profile's token;
    // sending both at once would race the cookie's rotation.
    const fetches = stubFetch({
      token: (call) => new Promise((resolve) => setTimeout(() => resolve(grant(call)), 10)),
    });
    const { runtime, changes } = await harness({ active: OTHER });

    const held = runtime.run(Effect.flatMap(OsnAuth, (auth) => auth.refreshHeldSession()));
    const res = await runtime.authFetch(API);
    await held;

    expect(res.status).toBe(200);
    expect(fetches.to("/token").map(namedProfile)).toEqual([null, OTHER]);
    expect(bearerSub(fetches.api()[0])).toBe(OTHER);
    expect(changes).toEqual([]);
  });

  it.each([
    {
      name: "the rotation race",
      message: "AuthError: Session rotated by a concurrent grant",
    },
    { name: "a DatabaseError", message: "DatabaseError: An error has occurred" },
  ])(
    "F8: a refusal that leaves the session's status unknown ($name) is retried once",
    async (c) => {
      let tokenCalls = 0;
      const fetches = stubFetch({
        token: (call) =>
          ++tokenCalls === 1
            ? json(400, { error: "invalid_grant", message: c.message })
            : grant(call),
      });
      const { runtime, changes, stored } = await harness({ active: DEFAULT });

      const res = await runtime.authFetch(API);

      expect(res.status).toBe(200);
      expect(fetches.to("/token")).toHaveLength(2);
      expect(changes).toEqual([]);
      expect(stored()?.activeProfileId).toBe(DEFAULT);
    },
  );

  it("F8b: a second 'status unknown' refusal fails the call, keeps the session and stops", async () => {
    const fetches = stubFetch({
      token: () =>
        json(400, {
          error: "invalid_grant",
          message: "AuthError: Session rotated by a concurrent grant",
        }),
    });
    const { runtime, changes, stored } = await harness({ active: DEFAULT });

    const err = await rejection(runtime.authFetch(API));

    expect(tagOf(err)).toBe("TokenRefreshError");
    expect(isAuthExpiredError(err)).toBe(false);
    expect(fetches.to("/token")).toHaveLength(2);
    expect(fetches.api()).toHaveLength(0);
    expect(changes).toEqual([]);
    expect(stored()?.activeProfileId).toBe(DEFAULT);
  });

  it("F9b: a refusal whose body says nothing ends the session, whatever the marker cookie says", async () => {
    // The marker is a cookie other origins can write; it must not keep a
    // refused session alive.
    vi.stubGlobal("document", { cookie: "osn_has_session=1" });
    const fetches = stubFetch({
      token: () => json(400, { error: "invalid_grant", message: "AuthError: something else" }),
    });
    const { runtime, changes, stored } = await harness({ active: DEFAULT });

    const err = await rejection(runtime.authFetch(API));

    expect(isAuthExpiredError(err)).toBe(true);
    expect(fetches.to("/token")).toHaveLength(1);
    expect(changes).toEqual([{ kind: "ended" }]);
    expect(stored()).toBeNull();
  });

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
    const { runtime, changes, stored } = await harness({ active: DEFAULT });

    const err = await rejection(runtime.authFetch(API));

    expect(isAuthExpiredError(err)).toBe(true);
    expect(fetches.to("/token")).toHaveLength(1);
    expect(fetches.api()).toHaveLength(0);
    expect(changes).toEqual([{ kind: "ended" }]);
    expect(stored()).toBeNull();
  });

  it("F10: a grant that keeps answering 503 fails the call and keeps the session", async () => {
    const fetches = stubFetch({ token: () => json(503, { error: "upstream" }) });
    const { runtime, changes, stored } = await harness({ active: DEFAULT });

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
    const { runtime, changes, stored } = await harness({ active: DEFAULT });

    const err = await rejection(runtime.authFetch(API));

    expect(tagOf(err)).toBe("TokenRefreshError");
    expect(changes).toEqual([]);
    expect(stored()?.activeProfileId).toBe(DEFAULT);
  });

  it("F13: a transport failure of the request reaches the caller unchanged", async () => {
    const failure = new TypeError("Failed to fetch");
    stubFetch({
      api: () => {
        throw failure;
      },
    });
    const { runtime, changes, stored } = await harness({
      active: DEFAULT,
      token: token(DEFAULT, 120_000),
    });

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
    const { runtime } = await harness({ active: DEFAULT, token: token(DEFAULT, 120_000) });

    const err = await rejection(runtime.authFetch(API, { signal: AbortSignal.abort() }));

    expect(err).toBe(abort);
  });

  it("F43: a second runtime on the same storage never sends the first one's token", async () => {
    // Tokens stay in each page's memory, so another tab renews for itself.
    const fetches = stubFetch({});
    const storage = createEphemeralStorage();
    const first = await harness({ active: DEFAULT, token: token(DEFAULT, 10_000) }, storage);
    const second = await harness(undefined, storage);

    await first.runtime.authFetch(API);
    await second.runtime.authFetch(API);

    expect(fetches.to("/token")).toHaveLength(2);
    expect(bearerSub(fetches.api()[1])).toBe(DEFAULT);
    expect(bearer(fetches.api()[1])).not.toBe(bearer(fetches.api()[0]));
    expect(second.stored()).toEqual({ hasSession: true, activeProfileId: DEFAULT });
  });

  it("F16: the stored account removed by another runtime ends this one's session with no request", async () => {
    const fetches = stubFetch({});
    const storage = createEphemeralStorage();
    const { runtime, changes } = await harness(
      { active: DEFAULT, token: token(DEFAULT, 120_000) },
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
    const { runtime } = await harness({ active: DEFAULT, token: short });

    await runtime.authFetch(API);

    expect(fetches.to("/token")).toHaveLength(0);
    expect(bearer(fetches.api()[0])).toBe(`Bearer ${short.accessToken}`);
  });

  it("F18: no token for the active profile renews and makes the grant's profile active", async () => {
    const fetches = stubFetch({});
    const { runtime, stored } = await harness({ active: "" });

    const res = await runtime.authFetch(API);

    expect(res.status).toBe(200);
    expect(fetches.to("/token")).toHaveLength(1);
    expect(namedProfile(fetches.to("/token")[0])).toBeNull();
    expect(stored()?.activeProfileId).toBe(DEFAULT);
  });

  it("F19: a listener that unsubscribed is not called", async () => {
    stubFetch({ api: () => json(401) });
    const { runtime, changes } = await harness({ active: DEFAULT, token: token(DEFAULT, 120_000) });
    const gone: SessionChange[] = [];
    const unsubscribe = runtime.onSessionChange((change) => gone.push(change));
    unsubscribe();

    await rejection(runtime.authFetch(API));

    expect(changes).toEqual([{ kind: "ended" }]);
    expect(gone).toEqual([]);
  });

  it("F24: a granted token that names no profile fails the call and is not stored", async () => {
    const fetches = stubFetch({ token: (call) => grant(call, {}) });
    const { runtime, changes, stored } = await harness({ active: DEFAULT });

    const err = await rejection(runtime.authFetch(API));

    expect(tagOf(err)).toBe("TokenRefreshError");
    expect(isAuthExpiredError(err)).toBe(false);
    expect(fetches.api()).toHaveLength(0);
    expect(changes).toEqual([]);
    expect(stored()).toEqual({ hasSession: true, activeProfileId: DEFAULT });
  });

  it.each([
    ["another origin", "https://elsewhere.example.com/thing"],
    ["a look-alike host", "https://osn.example.com.evil.example/thing"],
    ["a relative URL", "/thing"],
  ])("F25: a URL on %s is refused with a TypeError and nothing is sent", async (_n, url) => {
    const fetches = stubFetch({});
    const { runtime, changes } = await harness({ active: DEFAULT });

    const err = await rejection(runtime.authFetch(url));

    expect(err).toBeInstanceOf(TypeError);
    expect(fetches.calls).toHaveLength(0);
    expect(changes).toEqual([]);
  });

  it("F26: after a renewal fails, calls inside the pause send no grant, and the pause doubles", async () => {
    let answer: "limited" | "ok" = "limited";
    const fetches = stubFetch({
      token: (call) => (answer === "limited" ? json(429, { error: "rate_limited" }) : grant(call)),
    });
    const { runtime, changes } = await harness({ active: DEFAULT });

    expect(tagOf(await rejection(runtime.authFetch(API)))).toBe("TokenRefreshError");
    expect(fetches.to("/token")).toHaveLength(1);
    // Inside the first pause (2 s): no grant.
    expect(tagOf(await rejection(runtime.authFetch(API)))).toBe("TokenRefreshError");
    expect(fetches.to("/token")).toHaveLength(1);

    advanceClock(2_001);
    expect(tagOf(await rejection(runtime.authFetch(API)))).toBe("TokenRefreshError");
    expect(fetches.to("/token")).toHaveLength(2);
    // The second pause is 4 s.
    advanceClock(3_000);
    await rejection(runtime.authFetch(API));
    expect(fetches.to("/token")).toHaveLength(2);

    answer = "ok";
    advanceClock(1_001);
    expect((await runtime.authFetch(API)).status).toBe(200);
    expect(fetches.to("/token")).toHaveLength(3);
    expect(fetches.api()).toHaveLength(1);
    expect(changes).toEqual([]);
  });

  it("F27: a 429 is not retried, and its Retry-After sets the pause", async () => {
    const fetches = stubFetch({
      token: () =>
        new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "7" },
        }),
    });
    const { runtime } = await harness({ active: DEFAULT });

    const err = await rejection(runtime.authFetch(API));

    expect(tagOf(err)).toBe("TokenRefreshError");
    expect(fetches.to("/token")).toHaveLength(1);
    advanceClock(6_000);
    await rejection(runtime.authFetch(API));
    expect(fetches.to("/token")).toHaveLength(1);
    advanceClock(1_001);
    await rejection(runtime.authFetch(API));
    expect(fetches.to("/token")).toHaveLength(2);
  });

  it("F28: a renewal that fails without a refusal sends the token in hand while it is valid", async () => {
    const fetches = stubFetch({ token: () => json(429, { error: "rate_limited" }) });
    // Inside its 30 s lead, 10 s from expiry.
    const live = token(DEFAULT, 10_000);
    const { runtime, changes } = await harness({ active: DEFAULT, token: live });

    const res = await runtime.authFetch(API);

    expect(res.status).toBe(200);
    expect(fetches.to("/token")).toHaveLength(1);
    expect(bearer(fetches.api()[0])).toBe(`Bearer ${live.accessToken}`);
    expect(changes).toEqual([]);
  });

  it.each([
    {
      name: "a 300 s token with 20 s left",
      stored: () => token(DEFAULT, 20_000),
    },
    {
      name: "a 20 s token with 9 s left (lead 10 s)",
      stored: () => {
        const exp = nowSec() + 9;
        return {
          accessToken: jwt({ sub: DEFAULT, iat: exp - 20, exp }),
          expiresAt: Date.now() + 9_000,
        };
      },
    },
    {
      name: "a token with no iat or exp and 20 s left (lead 30 s)",
      stored: () => ({ accessToken: jwt({ sub: DEFAULT }), expiresAt: Date.now() + 20_000 }),
    },
  ])("F29: $name is renewed before it is sent", async (c) => {
    const fetches = stubFetch({});
    const held = c.stored();
    const { runtime } = await harness({ active: DEFAULT, token: held });

    await runtime.authFetch(API);

    expect(fetches.to("/token")).toHaveLength(1);
    expect(bearer(fetches.api()[0])).not.toBe(`Bearer ${held.accessToken}`);
    expect(bearerSub(fetches.api()[0])).toBe(DEFAULT);
  });

  it("F30: a sync never takes another tab's active profile", async () => {
    const fetches = stubFetch({});
    const storage = createEphemeralStorage();
    const ours = token(DEFAULT, 120_000);
    const { runtime } = await harness({ active: DEFAULT, token: ours }, storage);
    await runtime.run(Effect.flatMap(OsnAuth, (auth) => auth.getSession()));

    // Another tab switched to OTHER.
    write(storage, { hasSession: true, activeProfileId: OTHER });
    await runtime.authFetch(API);

    expect(bearerSub(fetches.api()[0])).toBe(DEFAULT);
    expect(bearer(fetches.api()[0])).toBe(`Bearer ${ours.accessToken}`);
    expect(fetches.to("/token")).toHaveLength(0);
    expect(fetches.to("/profiles/switch")).toHaveLength(0);
  });

  it("F31: concurrent refusals end the session once, and a throwing listener stops no other", async () => {
    const thrown: unknown[] = [];
    const realQueue = globalThis.queueMicrotask;
    vi.stubGlobal("queueMicrotask", (task: () => void) =>
      realQueue(() => {
        try {
          task();
        } catch (err) {
          thrown.push(err);
        }
      }),
    );
    stubFetch({
      api: () => json(401),
      token: () => json(400, { error: "invalid_grant", message: "AuthError: Invalid session" }),
    });
    const fault = new Error("listener fault");
    const { runtime, changes } = await harness(
      { active: DEFAULT, token: token(DEFAULT, 120_000) },
      undefined,
      (rt) =>
        rt.onSessionChange(() => {
          throw fault;
        }),
    );

    const errs = await Promise.all([
      rejection(runtime.authFetch(API)),
      rejection(runtime.authFetch(API)),
      rejection(runtime.authFetch(API)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errs.every(isAuthExpiredError)).toBe(true);
    expect(changes).toEqual([{ kind: "ended" }]);
    expect(thrown).toEqual([fault]);
  });
});

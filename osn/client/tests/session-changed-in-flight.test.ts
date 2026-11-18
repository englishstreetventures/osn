import { it, expect } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { afterEach, vi } from "vitest";

import type { SessionChange } from "../src/runtime";
import { ACCOUNT_SESSION_KEY, OsnAuth, createOsnAuthLive } from "../src/service";
import { Storage, createEphemeralStorage } from "../src/storage";
import { extractJwtSub } from "../src/tokens";

/**
 * A session set or ended while a request made for the one before it was out
 * is the newest thing the person did. The late answer to that request must not
 * replace it, end it, bring back the one it replaced, or reach the caller.
 * One test per way that can fail (NEW-FEAT.md F1–F11, T1–T23).
 */

const ISSUER = "https://osn.example.com";
const A = "usr_accounta0001";
const A2 = "usr_accounta0002";
const B = "usr_accountb0001";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An unsigned JWT: the client reads `sub` without verifying. */
function jwt(sub: string): string {
  const enc = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${enc({ alg: "none" })}.${enc({ sub, iat: Math.floor(Date.now() / 1000) })}.sig`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const minted = (sub: string) =>
  json(200, {
    access_token: jwt(sub),
    token_type: "Bearer",
    expires_in: 300,
    scope: "openid profile",
  });
const refused = () => json(401, { error: "invalid_grant" });

/** A request the test holds open: `reached` once it is sent, answered once `open` is called. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return {
    open,
    reached: Effect.promise(() => arrived),
    pass: async () => {
      arrive();
      await opened;
    },
  };
}

interface Sent {
  readonly path: string;
  /** The `sub` of the bearer token sent, or of the profile a grant named. */
  readonly as: string | null;
}

type Answer = (named: string | undefined) => Response | Promise<Response>;

/**
 * Stubs `fetch`. Each path answers its queue in order, the last entry for every
 * request after; a path with no queue answers `{}`. `/token` answers get the
 * profile the grant named.
 */
function serve(queues: Record<string, Answer[]>) {
  const sent: Sent[] = [];
  const counts: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url).pathname;
      const named = new URLSearchParams(String(init?.body ?? "")).get("profile_id") ?? undefined;
      const bearer = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "");
      sent.push({ path, as: bearer ? extractJwtSub(bearer) : (named ?? null) });
      const queue = queues[path];
      if (!queue) return json(200, {});
      const n = counts[path] ?? 0;
      counts[path] = n + 1;
      return queue[Math.min(n, queue.length - 1)]!(named);
    }),
  );
  return { sent, count: (path: string) => sent.filter((s) => s.path === path).length };
}

/** An answer that waits for `g` to open. */
const after =
  (g: ReturnType<typeof gate>, answer: Answer): Answer =>
  async (named) => {
    await g.pass();
    return answer(named);
  };

const changes: SessionChange[] = [];

function layer(storage: Layer.Layer<Storage> = createEphemeralStorage()) {
  changes.length = 0;
  return createOsnAuthLive(
    { issuerUrl: ISSUER },
    { onSessionChange: (change) => changes.push(change) },
  ).pipe(Layer.provideMerge(storage));
}

/** A second service on the same storage: another tab. */
const otherTab = (storage: Layer.Layer<Storage>) =>
  Effect.gen(function* () {
    return yield* OsnAuth;
  }).pipe(Effect.provide(createOsnAuthLive({ issuerUrl: ISSUER }).pipe(Layer.provide(storage))));

/**
 * Storage that runs a hook once, at the next read or the next write: a
 * sign-in landing while the service reads or writes the stored account, as a
 * platform storage layer that awaits would let one.
 */
function hookedStorage() {
  const store = new Map<string, string>();
  let onGet: (() => void) | null = null;
  let onSet: (() => void) | null = null;
  const storageLayer = Layer.succeed(Storage, {
    get: (key) =>
      Effect.sync(() => {
        const hook = onGet;
        onGet = null;
        hook?.();
        return store.get(key) ?? null;
      }),
    set: (key, value) =>
      Effect.sync(() => {
        store.set(key, value);
        const hook = onSet;
        onSet = null;
        hook?.();
      }),
    remove: (key) =>
      Effect.sync(() => {
        store.delete(key);
      }),
  });
  return {
    layer: storageLayer,
    onNextGet: (hook: () => void) => {
      onGet = hook;
    },
    onNextSet: (hook: () => void) => {
      onSet = hook;
    },
  };
}

const session = (sub: string, ms: number) => ({
  accessToken: jwt(sub),
  idToken: null,
  expiresAt: Date.now() + ms,
  scopes: ["openid", "profile"],
});

/** The session the person adopted: a sign-in as B. */
const sessionB = () => session(B, 120_000);
/** A session for A whose token has run out, as on a reload or a long-open page. */
const expiredA = () => session(A, -1_000);
const liveA = () => session(A, 120_000);

const stored = () =>
  Effect.gen(function* () {
    const raw = yield* (yield* Storage).get(ACCOUNT_SESSION_KEY);
    return raw === null ? null : (JSON.parse(raw) as { activeProfileId: string; signInId: string });
  });

/** The tag a call failed with, or "Success". */
const outcome = <A, E extends { readonly _tag: string }>(
  result:
    | { readonly _tag: "Success"; readonly success: A }
    | { readonly _tag: "Failure"; readonly failure: E },
) => (result._tag === "Success" ? "Success" : result.failure._tag);

/**
 * Lets every fiber run up to its next real wait. A real timer: `it.effect`
 * runs on the test clock, which never moves by itself.
 */
const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

/** The issuer's answer to a switch to A's second profile. */
const switched = () =>
  json(200, {
    access_token: jwt(A2),
    expires_in: 300,
    profile: {
      id: A2,
      handle: "a_two",
      email: "a@example.com",
      displayName: null,
      avatarUrl: null,
    },
  });

// ---------------------------------------------------------------------------
// The bootstrap (`loadSession`)
// ---------------------------------------------------------------------------

it.effect("F1: a cold-start bootstrap does not replace a session set while its grant was out", () =>
  Effect.gen(function* () {
    const g = gate();
    serve({ "/token": [after(g, () => minted(A))] });
    vi.stubGlobal("document", { cookie: "osn_has_session=1" });
    const auth = yield* OsnAuth;

    const loading = yield* Effect.forkChild(auth.loadSession());
    yield* g.reached;
    const adopted = sessionB();
    yield* auth.setSession(adopted);
    g.open();
    const loaded = yield* Fiber.join(loading);

    expect((yield* auth.getSession())?.accessToken).toBe(adopted.accessToken);
    expect(yield* auth.getActiveProfile()).toBe(B);
    expect((yield* stored())?.activeProfileId).toBe(B);
    expect(loaded?.accessToken).toBe(adopted.accessToken);
  }).pipe(Effect.provide(layer())),
);

it.effect("F2: a reload's bootstrap does not replace a session set while its grant was out", () =>
  Effect.gen(function* () {
    const g = gate();
    serve({ "/token": [after(g, () => minted(A))] });
    const auth = yield* OsnAuth;
    yield* auth.setSession(expiredA());

    const loading = yield* Effect.forkChild(auth.loadSession());
    yield* g.reached;
    const adopted = sessionB();
    yield* auth.setSession(adopted);
    g.open();
    const loaded = yield* Fiber.join(loading);

    expect((yield* auth.getSession())?.accessToken).toBe(adopted.accessToken);
    expect(yield* auth.getActiveProfile()).toBe(B);
    expect(loaded?.accessToken).toBe(adopted.accessToken);
  }).pipe(Effect.provide(layer())),
);

it.effect("F3: a bootstrap does not bring back a session logged out while its grant was out", () =>
  Effect.gen(function* () {
    const g = gate();
    serve({ "/token": [after(g, () => minted(A))] });
    vi.stubGlobal("document", { cookie: "osn_has_session=1" });
    const auth = yield* OsnAuth;

    const loading = yield* Effect.forkChild(auth.loadSession());
    yield* g.reached;
    yield* auth.logout();
    g.open();
    const loaded = yield* Fiber.join(loading);

    expect(yield* auth.getSession()).toBeNull();
    expect(yield* stored()).toBeNull();
    expect(loaded).toBeNull();
  }).pipe(Effect.provide(layer())),
);

it.effect("F4: a refused bootstrap does not forget a session set while its grant was out", () =>
  Effect.gen(function* () {
    const g = gate();
    serve({ "/token": [after(g, refused)] });
    const auth = yield* OsnAuth;
    yield* auth.setSession(expiredA());

    const loading = yield* Effect.forkChild(auth.loadSession());
    yield* g.reached;
    const adopted = sessionB();
    yield* auth.setSession(adopted);
    g.open();
    yield* Fiber.join(loading);

    expect((yield* auth.getSession())?.accessToken).toBe(adopted.accessToken);
    expect((yield* stored())?.activeProfileId).toBe(B);
  }).pipe(Effect.provide(layer())),
);

// ---------------------------------------------------------------------------
// Renewal (`refreshSession`, and `authFetch` through it)
// ---------------------------------------------------------------------------

it.effect("F5: a renewal does not replace a session set while its grant was out", () =>
  Effect.gen(function* () {
    const g = gate();
    serve({ "/token": [after(g, () => minted(A))] });
    const auth = yield* OsnAuth;
    yield* auth.setSession(expiredA());

    const renewing = yield* Effect.forkChild(Effect.result(auth.refreshSession()));
    yield* g.reached;
    const adopted = sessionB();
    yield* auth.setSession(adopted);
    g.open();

    expect(outcome(yield* Fiber.join(renewing))).toBe("AuthExpiredError");
    expect((yield* auth.getSession())?.accessToken).toBe(adopted.accessToken);
    expect(yield* auth.getActiveProfile()).toBe(B);
    expect(changes).toEqual([]);
  }).pipe(Effect.provide(layer())),
);

it.effect("F6: a renewal does not bring back a session logged out while its grant was out", () =>
  Effect.gen(function* () {
    const g = gate();
    serve({ "/token": [after(g, () => minted(A))] });
    const auth = yield* OsnAuth;
    yield* auth.setSession(expiredA());

    const renewing = yield* Effect.forkChild(Effect.result(auth.refreshSession()));
    yield* g.reached;
    yield* auth.logout();
    g.open();

    expect(outcome(yield* Fiber.join(renewing))).toBe("AuthExpiredError");
    expect(yield* auth.getSession()).toBeNull();
    expect(yield* stored()).toBeNull();
    expect(changes).toEqual([]);
  }).pipe(Effect.provide(layer())),
);

it.effect(
  "F11: a renewal does not bring back a session another tab ended while its grant was out",
  () =>
    Effect.gen(function* () {
      const g = gate();
      serve({ "/token": [after(g, () => minted(A))] });
      const auth = yield* OsnAuth;
      const storage = yield* Storage;
      yield* auth.setSession(expiredA());

      const renewing = yield* Effect.forkChild(Effect.result(auth.refreshSession()));
      yield* g.reached;
      // Another tab signs out: the stored account goes. No storage event
      // reaches this one before the answer does.
      yield* storage.remove(ACCOUNT_SESSION_KEY);
      g.open();

      expect(outcome(yield* Fiber.join(renewing))).toBe("AuthExpiredError");
      expect(yield* auth.getSession()).toBeNull();
      expect(yield* stored()).toBeNull();
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "T9: an answer does not reach its caller once another tab's sign-out ended the session",
  () =>
    Effect.gen(function* () {
      const g = gate();
      serve({ "/thing": [after(g, () => json(200, { owner: A }))] });
      const auth = yield* OsnAuth;
      const storage = yield* Storage;
      yield* auth.setSession(liveA());

      const sending = yield* Effect.forkChild(Effect.result(auth.authFetch(`${ISSUER}/thing`)));
      yield* g.reached;
      // Another tab signs out, and this one hears of it.
      yield* storage.remove(ACCOUNT_SESSION_KEY);
      yield* auth.checkStoredAccount();
      g.open();

      expect(outcome(yield* Fiber.join(sending))).toBe("AuthExpiredError");
    }).pipe(Effect.provide(layer())),
);

it.effect("F7: a refused renewal does not end a session set while its grant was out", () =>
  Effect.gen(function* () {
    const g = gate();
    serve({ "/token": [after(g, refused)] });
    const auth = yield* OsnAuth;
    yield* auth.setSession(expiredA());

    const sending = yield* Effect.forkChild(Effect.result(auth.authFetch(`${ISSUER}/thing`)));
    yield* g.reached;
    const adopted = sessionB();
    yield* auth.setSession(adopted);
    g.open();

    expect(outcome(yield* Fiber.join(sending))).toBe("AuthExpiredError");
    expect((yield* auth.getSession())?.accessToken).toBe(adopted.accessToken);
    expect((yield* stored())?.activeProfileId).toBe(B);
    expect(changes).toEqual([]);
  }).pipe(Effect.provide(layer())),
);

it.effect("T1: a request sent while /logout was out does not reach its caller after it", () =>
  Effect.gen(function* () {
    const out = gate();
    const g = gate();
    serve({
      "/logout": [after(out, () => json(200, {}))],
      "/thing": [after(g, () => json(200, { owner: A }))],
    });
    const auth = yield* OsnAuth;
    yield* auth.setSession(liveA());

    const leaving = yield* Effect.forkChild(auth.logout());
    yield* out.reached;
    const sending = yield* Effect.forkChild(Effect.result(auth.authFetch(`${ISSUER}/thing`)));
    yield* g.reached;
    out.open();
    yield* Fiber.join(leaving);
    g.open();

    expect(outcome(yield* Fiber.join(sending))).toBe("AuthExpiredError");
    expect(yield* auth.getSession()).toBeNull();
  }).pipe(Effect.provide(layer())),
);

it.effect("T2: a renewal minted for another profile sends no reset once a session was set", () =>
  Effect.gen(function* () {
    const g = gate();
    // The issuer mints for the account's default profile, not the one named.
    serve({ "/token": [after(g, () => minted(A2))] });
    const auth = yield* OsnAuth;
    yield* auth.setSession(expiredA());

    const renewing = yield* Effect.forkChild(Effect.result(auth.refreshSession()));
    yield* g.reached;
    const adopted = sessionB();
    yield* auth.setSession(adopted);
    g.open();

    expect(outcome(yield* Fiber.join(renewing))).toBe("AuthExpiredError");
    expect(yield* auth.getActiveProfile()).toBe(B);
    expect(changes).toEqual([]);
  }).pipe(Effect.provide(layer())),
);

it.effect("T3: a renewal for the new session does not take the answer of one for the old", () =>
  Effect.gen(function* () {
    const g = gate();
    const b401 = gate();
    const net = serve({
      "/token": [after(g, refused), (named) => minted(named ?? B)],
      "/thing": [after(b401, () => json(401, {})), () => json(200, {})],
    });
    const auth = yield* OsnAuth;
    yield* auth.setSession(expiredA());

    const renewingA = yield* Effect.forkChild(Effect.result(auth.refreshSession()));
    yield* g.reached;
    yield* auth.setSession(sessionB());
    // B's request is refused once, so it renews while A's grant is still out.
    const sendingB = yield* Effect.forkChild(Effect.result(auth.authFetch(`${ISSUER}/thing`)));
    yield* b401.reached;
    b401.open();
    yield* settle;
    // B has had its 401 and is renewing, and has sent no grant of its own.
    expect(net.count("/thing")).toBe(1);
    expect(net.count("/token")).toBe(1);
    g.open();

    expect(outcome(yield* Fiber.join(renewingA))).toBe("AuthExpiredError");
    const resultB = yield* Fiber.join(sendingB);
    expect(outcome(resultB)).toBe("Success");
    expect(resultB._tag === "Success" && resultB.success.status).toBe(200);
    expect(yield* auth.getActiveProfile()).toBe(B);
    expect(changes).toEqual([]);
    // A's grant and B's never overlapped: B's left after A's was answered.
    expect(net.count("/token")).toBe(2);
  }).pipe(Effect.provide(layer())),
);

it.effect("T6: a grant for a session that has gone stops retrying", () =>
  Effect.gen(function* () {
    const g = gate();
    const net = serve({ "/token": [after(g, () => json(503, {})), () => json(503, {})] });
    const auth = yield* OsnAuth;
    yield* auth.setSession(expiredA());

    const renewing = yield* Effect.forkChild(Effect.result(auth.refreshSession()));
    yield* g.reached;
    yield* auth.setSession(sessionB());
    g.open();
    yield* Fiber.join(renewing);

    expect(net.count("/token")).toBe(1);
  }).pipe(Effect.provide(layer())),
);

it.effect("T6b: a grant for a session that has gone does not retry a lost rotation race", () =>
  Effect.gen(function* () {
    const g = gate();
    const raced = () =>
      json(400, {
        error: "invalid_grant",
        message: "AuthError: Session rotated by a concurrent grant",
      });
    const net = serve({ "/token": [after(g, raced), (named) => minted(named ?? A)] });
    const auth = yield* OsnAuth;
    yield* auth.setSession(expiredA());

    const renewing = yield* Effect.forkChild(Effect.result(auth.refreshSession()));
    yield* g.reached;
    yield* auth.setSession(sessionB());
    g.open();
    yield* Fiber.join(renewing);

    expect(net.count("/token")).toBe(1);
  }).pipe(Effect.provide(layer())),
);

it.effect(
  "T12: a grant waiting behind an older one is not sent once its own session has gone",
  () =>
    Effect.gen(function* () {
      const g = gate();
      const b401 = gate();
      const net = serve({
        "/token": [after(g, refused), (named) => minted(named ?? B)],
        "/thing": [after(b401, () => json(401, {}))],
      });
      const auth = yield* OsnAuth;
      yield* auth.setSession(expiredA());

      const renewingA = yield* Effect.forkChild(Effect.result(auth.refreshSession()));
      yield* g.reached;
      yield* auth.setSession(sessionB());
      // B's request is refused, so B's renewal waits for A's grant to settle.
      const sendingB = yield* Effect.forkChild(Effect.result(auth.authFetch(`${ISSUER}/thing`)));
      yield* b401.reached;
      b401.open();
      yield* settle;
      expect(net.count("/thing")).toBe(1);
      expect(net.count("/token")).toBe(1);
      // B's session goes too before A's grant answers.
      yield* auth.logout();
      g.open();
      yield* Fiber.join(renewingA);

      expect(outcome(yield* Fiber.join(sendingB))).toBe("AuthExpiredError");
      expect(net.count("/token")).toBe(1);
    }).pipe(Effect.provide(layer())),
);

it.effect("T7: the old session's renewal pause does not hold up the new one", () =>
  Effect.gen(function* () {
    serve({
      "/token": [() => json(429, { error: "rate_limited" }), (named) => minted(named ?? B)],
      "/thing": [() => json(401, {}), () => json(200, {})],
    });
    const auth = yield* OsnAuth;
    yield* auth.setSession(expiredA());
    // A's renewal is rate limited: renewal pauses.
    expect(outcome(yield* Effect.result(auth.authFetch(`${ISSUER}/thing`)))).toBe(
      "TokenRefreshError",
    );

    yield* auth.setSession(sessionB());
    const resultB = yield* Effect.result(auth.authFetch(`${ISSUER}/thing`));

    expect(resultB._tag === "Success" && resultB.success.status).toBe(200);
  }).pipe(Effect.provide(layer())),
);

// ---------------------------------------------------------------------------
// Other requests (`switchProfile`, `authFetch`)
// ---------------------------------------------------------------------------

it.effect("F8: a profile switch does not write into a session set while it was out", () =>
  Effect.gen(function* () {
    const g = gate();
    serve({ "/profiles/switch": [after(g, switched)] });
    const auth = yield* OsnAuth;
    yield* auth.setSession(liveA());

    const switching = yield* Effect.forkChild(Effect.result(auth.switchProfile(A2)));
    yield* g.reached;
    const adopted = sessionB();
    yield* auth.setSession(adopted);
    g.open();

    expect(outcome(yield* Fiber.join(switching))).toBe("AuthExpiredError");
    expect((yield* auth.getSession())?.accessToken).toBe(adopted.accessToken);
    expect(yield* auth.getActiveProfile()).toBe(B);
    expect(changes).toEqual([]);
  }).pipe(Effect.provide(layer())),
);

it.effect("T8: an answer to a request made as A does not reach the caller once B was set", () =>
  Effect.gen(function* () {
    const g = gate();
    serve({ "/thing": [after(g, () => json(200, { owner: A }))] });
    const auth = yield* OsnAuth;
    yield* auth.setSession(liveA());

    const sending = yield* Effect.forkChild(Effect.result(auth.authFetch(`${ISSUER}/thing`)));
    yield* g.reached;
    yield* auth.setSession(sessionB());
    g.open();

    expect(outcome(yield* Fiber.join(sending))).toBe("AuthExpiredError");
    expect(changes).toEqual([]);
  }).pipe(Effect.provide(layer())),
);

it.effect(
  "F9: a request made as A is not sent again as B after a 401 that came back once B was set",
  () =>
    Effect.gen(function* () {
      const g = gate();
      const net = serve({
        "/thing": [after(g, () => json(401, {})), () => json(200, {})],
        "/token": [(named) => minted(named ?? B)],
      });
      const auth = yield* OsnAuth;
      yield* auth.setSession(liveA());

      const sending = yield* Effect.forkChild(Effect.result(auth.authFetch(`${ISSUER}/thing`)));
      yield* g.reached;
      yield* auth.setSession(sessionB());
      g.open();

      expect(outcome(yield* Fiber.join(sending))).toBe("AuthExpiredError");
      expect(net.sent.filter((s) => s.path === "/thing").map((s) => s.as)).toEqual([A]);
      expect(changes).toEqual([]);
    }).pipe(Effect.provide(layer())),
);

it.effect("F10: a second 401 that came back once B was set does not end B", () =>
  Effect.gen(function* () {
    const g = gate();
    serve({
      "/thing": [() => json(401, {}), after(g, () => json(401, {}))],
      "/token": [(named) => minted(named ?? A)],
    });
    const auth = yield* OsnAuth;
    yield* auth.setSession(liveA());

    const sending = yield* Effect.forkChild(Effect.result(auth.authFetch(`${ISSUER}/thing`)));
    yield* g.reached;
    const adopted = sessionB();
    yield* auth.setSession(adopted);
    g.open();

    expect(outcome(yield* Fiber.join(sending))).toBe("AuthExpiredError");
    expect((yield* auth.getSession())?.accessToken).toBe(adopted.accessToken);
    expect(changes).toEqual([]);
  }).pipe(Effect.provide(layer())),
);

// ---------------------------------------------------------------------------
// Another tab: a second service on the same storage, with no storage event
// delivered, so only what this one reads before saving can tell.
// ---------------------------------------------------------------------------

it.effect(
  "T4: a renewal does not overwrite a sign-in another tab stored while its grant was out",
  () => {
    const shared = createEphemeralStorage();
    return Effect.gen(function* () {
      const g = gate();
      serve({ "/token": [after(g, () => minted(A))] });
      const auth = yield* OsnAuth;
      const tab2 = yield* otherTab(shared);
      yield* auth.setSession(expiredA());

      const renewing = yield* Effect.forkChild(Effect.result(auth.refreshSession()));
      yield* g.reached;
      yield* tab2.setSession(sessionB());
      const theirs = (yield* stored())?.signInId;
      g.open();

      expect(outcome(yield* Fiber.join(renewing))).toBe("AuthExpiredError");
      expect(yield* stored()).toMatchObject({ activeProfileId: B, signInId: theirs });
      expect(yield* auth.getSession()).toBeNull();
      expect(yield* tab2.getActiveProfile()).toBe(B);
    }).pipe(Effect.provide(layer(shared)));
  },
);

it.effect(
  "T10: a profile switch does not overwrite a sign-in another tab stored while it was out",
  () => {
    const shared = createEphemeralStorage();
    return Effect.gen(function* () {
      const g = gate();
      serve({ "/profiles/switch": [after(g, switched)] });
      const auth = yield* OsnAuth;
      const tab2 = yield* otherTab(shared);
      yield* auth.setSession(liveA());

      const switching = yield* Effect.forkChild(Effect.result(auth.switchProfile(A2)));
      yield* g.reached;
      yield* tab2.setSession(sessionB());
      const theirs = (yield* stored())?.signInId;
      g.open();

      expect(outcome(yield* Fiber.join(switching))).toBe("AuthExpiredError");
      expect(yield* stored()).toMatchObject({ activeProfileId: B, signInId: theirs });
    }).pipe(Effect.provide(layer(shared)));
  },
);

it.effect(
  "T11: a profile delete does not overwrite a sign-in another tab stored while it was out",
  () => {
    const shared = createEphemeralStorage();
    return Effect.gen(function* () {
      const g = gate();
      serve({ "/profiles/delete": [after(g, () => json(200, {}))] });
      const auth = yield* OsnAuth;
      const tab2 = yield* otherTab(shared);
      yield* auth.setSession(liveA());

      const deleting = yield* Effect.forkChild(Effect.result(auth.deleteProfile(A2)));
      yield* g.reached;
      yield* tab2.setSession(sessionB());
      const theirs = (yield* stored())?.signInId;
      g.open();

      expect(outcome(yield* Fiber.join(deleting))).toBe("AuthExpiredError");
      expect(yield* stored()).toMatchObject({ activeProfileId: B, signInId: theirs });
    }).pipe(Effect.provide(layer(shared)));
  },
);

it.effect(
  "T5: a cold-start bootstrap does not overwrite a sign-in another tab stored meanwhile",
  () => {
    const shared = createEphemeralStorage();
    return Effect.gen(function* () {
      const g = gate();
      serve({ "/token": [after(g, () => minted(A))] });
      const auth = yield* OsnAuth;
      const tab2 = yield* otherTab(shared);

      const loading = yield* Effect.forkChild(auth.loadSession());
      yield* g.reached;
      yield* tab2.setSession(sessionB());
      const theirs = (yield* stored())?.signInId;
      g.open();

      expect(yield* Fiber.join(loading)).toBeNull();
      expect(yield* stored()).toMatchObject({ activeProfileId: B, signInId: theirs });
    }).pipe(Effect.provide(layer(shared)));
  },
);

// ---------------------------------------------------------------------------
// Points no gate on the network can reach: a sign-in landing while the
// service reads or writes the stored account.
// ---------------------------------------------------------------------------

it.effect(
  "T13: a request made as A is not sent again once B was set while its renewal saved",
  () => {
    const hooked = hookedStorage();
    return Effect.gen(function* () {
      const net = serve({
        "/thing": [() => json(401, {}), () => json(200, {})],
        "/token": [(named) => minted(named ?? A)],
      });
      const auth = yield* OsnAuth;
      yield* auth.setSession(liveA());
      // The renewal's own save is the next write: B is adopted right after it.
      hooked.onNextSet(() => Effect.runSync(auth.setSession(sessionB())));

      expect(outcome(yield* Effect.result(auth.authFetch(`${ISSUER}/thing`)))).toBe(
        "AuthExpiredError",
      );
      expect(net.count("/thing")).toBe(1);
      expect(yield* auth.getActiveProfile()).toBe(B);
    }).pipe(Effect.provide(layer(hooked.layer)));
  },
);

it.effect(
  "T14: a request made as A is not sent once B was set while its first renewal saved",
  () => {
    const hooked = hookedStorage();
    return Effect.gen(function* () {
      const net = serve({ "/token": [(named) => minted(named ?? A)] });
      const auth = yield* OsnAuth;
      yield* auth.setSession(expiredA());
      hooked.onNextSet(() => Effect.runSync(auth.setSession(sessionB())));

      expect(outcome(yield* Effect.result(auth.authFetch(`${ISSUER}/thing`)))).toBe(
        "AuthExpiredError",
      );
      expect(net.count("/thing")).toBe(0);
    }).pipe(Effect.provide(layer(hooked.layer)));
  },
);

it.effect("T15: a sign-in landing while a renewal reads the stored account is not ended", () => {
  const hooked = hookedStorage();
  return Effect.gen(function* () {
    serve({ "/token": [(named) => minted(named ?? A)] });
    const auth = yield* OsnAuth;
    yield* auth.setSession(expiredA());
    const adopted = sessionB();
    // The next read is the renewal's look at the stored account, just before
    // it would save.
    hooked.onNextGet(() => Effect.runSync(auth.setSession(adopted)));

    expect(outcome(yield* Effect.result(auth.refreshSession()))).toBe("AuthExpiredError");
    expect((yield* auth.getSession())?.accessToken).toBe(adopted.accessToken);
    expect(changes).toEqual([]);
  }).pipe(Effect.provide(layer(hooked.layer)));
});

// ---------------------------------------------------------------------------
// The edges of the check
// ---------------------------------------------------------------------------

it.effect("T16: an unreadable stored account does not stop a renewal's answer", () =>
  Effect.gen(function* () {
    const g = gate();
    serve({ "/token": [after(g, () => minted(A))] });
    const auth = yield* OsnAuth;
    const storage = yield* Storage;
    yield* auth.setSession(expiredA());

    const renewing = yield* Effect.forkChild(Effect.result(auth.refreshSession()));
    yield* g.reached;
    yield* storage.set(ACCOUNT_SESSION_KEY, "not json");
    g.open();

    expect(outcome(yield* Fiber.join(renewing))).toBe("Success");
    expect(yield* auth.getActiveProfile()).toBe(A);
    expect((yield* auth.getSession())?.expiresAt).toBeGreaterThan(Date.now());
  }).pipe(Effect.provide(layer())),
);

it.effect(
  "T17: a stored account with no sign-in id, from an older client, is not written over",
  () =>
    Effect.gen(function* () {
      const g = gate();
      serve({ "/token": [after(g, () => minted(A))] });
      const auth = yield* OsnAuth;
      const storage = yield* Storage;
      yield* auth.setSession(expiredA());

      const renewing = yield* Effect.forkChild(Effect.result(auth.refreshSession()));
      yield* g.reached;
      const theirs = JSON.stringify({ hasSession: true, activeProfileId: B });
      yield* storage.set(ACCOUNT_SESSION_KEY, theirs);
      g.open();

      expect(outcome(yield* Fiber.join(renewing))).toBe("AuthExpiredError");
      expect(yield* storage.get(ACCOUNT_SESSION_KEY)).toBe(theirs);
      expect(yield* auth.getSession()).toBeNull();
    }).pipe(Effect.provide(layer())),
);

it.effect("T18: a reload's bootstrap for the new session does not take the old one's answer", () =>
  Effect.gen(function* () {
    const g = gate();
    const net = serve({ "/token": [after(g, () => minted(A)), (named) => minted(named ?? B)] });
    const auth = yield* OsnAuth;
    yield* auth.setSession(expiredA());

    const loadingA = yield* Effect.forkChild(auth.loadSession());
    yield* g.reached;
    // B is adopted with no live token, so B's own load has to go to the cookie.
    yield* auth.setSession(session(B, -1_000));
    const loadingB = yield* Effect.forkChild(auth.loadSession());
    yield* settle;
    g.open();
    yield* Fiber.join(loadingA);

    const loadedB = yield* Fiber.join(loadingB);
    expect(loadedB ? extractJwtSub(loadedB.accessToken) : null).toBe(B);
    expect(net.count("/token")).toBe(2);
  }).pipe(Effect.provide(layer())),
);

it.effect(
  "T19: a load sends no grant while another tab's sign-in is stored and this page holds none",
  () => {
    const shared = createEphemeralStorage();
    return Effect.gen(function* () {
      const net = serve({ "/token": [(named) => minted(named ?? A)] });
      const auth = yield* OsnAuth;
      const tab2 = yield* otherTab(shared);
      yield* auth.setSession(liveA());
      yield* tab2.setSession(sessionB());
      // This page hears of the other tab's sign-in and ends its own session.
      yield* auth.checkStoredAccount();

      expect(yield* auth.loadSession()).toBeNull();
      expect(net.count("/token")).toBe(0);
    }).pipe(Effect.provide(layer(shared)));
  },
);

it.effect(
  "T20: a second 401 does not remove a sign-in another tab stored while the retry was out",
  () => {
    const shared = createEphemeralStorage();
    return Effect.gen(function* () {
      const g = gate();
      serve({
        "/thing": [() => json(401, {}), after(g, () => json(401, {}))],
        "/token": [(named) => minted(named ?? A)],
      });
      const auth = yield* OsnAuth;
      const tab2 = yield* otherTab(shared);
      yield* auth.setSession(liveA());

      const sending = yield* Effect.forkChild(Effect.result(auth.authFetch(`${ISSUER}/thing`)));
      yield* g.reached;
      yield* tab2.setSession(sessionB());
      const theirs = (yield* stored())?.signInId;
      g.open();

      expect(outcome(yield* Fiber.join(sending))).toBe("AuthExpiredError");
      expect(yield* stored()).toMatchObject({ activeProfileId: B, signInId: theirs });
      expect(yield* auth.getSession()).toBeNull();
    }).pipe(Effect.provide(layer(shared)));
  },
);

it.effect("T21: a held session's renewal is not stopped by the page's session changing", () =>
  Effect.gen(function* () {
    const RECOVERY = "usr_recovery0001";
    const g = gate();
    const net = serve({
      "/token": [after(g, () => json(503, {})), () => minted(RECOVERY)],
    });
    const auth = yield* OsnAuth;

    const refreshing = yield* Effect.forkChild(Effect.result(auth.refreshHeldSession()));
    yield* g.reached;
    yield* auth.setSession(liveA());
    yield* auth.logout();
    g.open();

    const held = yield* Fiber.join(refreshing);
    expect(held._tag === "Success" && extractJwtSub(held.success.session.accessToken)).toBe(
      RECOVERY,
    );
    expect(net.count("/token")).toBe(2);
  }).pipe(Effect.provide(layer())),
);

it.effect(
  "T22: a sign-in landing while a request reads the stored account is not ended or used",
  () => {
    const hooked = hookedStorage();
    return Effect.gen(function* () {
      const net = serve({ "/thing": [() => json(200, {})] });
      const auth = yield* OsnAuth;
      yield* auth.setSession(liveA());
      const adopted = sessionB();
      // The request's first read is its check of the stored account.
      hooked.onNextGet(() => Effect.runSync(auth.setSession(adopted)));

      expect(outcome(yield* Effect.result(auth.authFetch(`${ISSUER}/thing`)))).toBe(
        "AuthExpiredError",
      );
      expect(net.count("/thing")).toBe(0);
      expect((yield* auth.getSession())?.accessToken).toBe(adopted.accessToken);
    }).pipe(Effect.provide(layer(hooked.layer)));
  },
);

it.effect("T23: the retry's answer does not reach the caller once B was set while it was out", () =>
  Effect.gen(function* () {
    const g = gate();
    serve({
      "/thing": [() => json(401, {}), after(g, () => json(200, { owner: A }))],
      "/token": [(named) => minted(named ?? A)],
    });
    const auth = yield* OsnAuth;
    yield* auth.setSession(liveA());

    const sending = yield* Effect.forkChild(Effect.result(auth.authFetch(`${ISSUER}/thing`)));
    yield* g.reached;
    yield* auth.setSession(sessionB());
    g.open();

    expect(outcome(yield* Fiber.join(sending))).toBe("AuthExpiredError");
  }).pipe(Effect.provide(layer())),
);

import { deletionJobs, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { EmailService } from "@shared/email";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";

import * as metrics from "../../src/metrics";
import {
  createAccountErasureRoutes,
  type AccountErasureRateLimiters,
} from "../../src/routes/account-erasure";
import { runHardDeleteSweep } from "../../src/services/account-erasure";
import { createAuthService } from "../../src/services/auth";
import { NO_DELETION_APPS, type DeletionAppsConfig } from "../../src/services/deletion-apps";
import { createOrganisationService } from "../../src/services/organisation";
import { createProfileService } from "../../src/services/profile";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer, createTestLayerWithSqlite } from "../helpers/db";
import { appStandIns, everyAppDone, type AppAnswer, type AppCall } from "../helpers/deletion-apps";
import { holdQueries } from "../helpers/held-query";
import { mintStepUpToken } from "../helpers/step-up-session";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

/**
 * The erasure endpoints must key their per-IP limiters via the
 * shared `clientIpConfig` trust policy — spoofable left-most XFF hops must
 * not choose the bucket, and an unresolvable client must be denied rather
 * than pooled into a shared "unknown" bucket, matching the
 * auth / profile routes.
 */
describe("account-erasure routes — client-IP keying (S-M5)", () => {
  function recordingLimiters(): {
    limiters: AccountErasureRateLimiters;
    keys: string[];
  } {
    const keys: string[] = [];
    const backend: RateLimiterBackend = {
      check: async (key: string) => {
        keys.push(key);
        return true;
      },
    } as RateLimiterBackend;
    return {
      limiters: {
        accountDelete: backend,
        accountRestore: backend,
        accountDeletionStatus: backend,
      },
      keys,
    };
  }

  it("denies with 429 when the client IP is unresolvable (direct mode, no socket peer)", async () => {
    const { limiters, keys } = recordingLimiters();
    // Default clientIpConfig = {} (direct mode). Under app.handle there is
    // no Bun server, so the socket peer is null and XFF is untrusted →
    // UNRESOLVED → deny before the limiter or handler runs.
    const app = createAccountErasureRoutes(config, createTestLayer(), undefined, limiters);
    const res = await app.handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { "x-forwarded-for": "6.6.6.6" },
      }),
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
    expect(keys).toEqual([]);
  });

  it("keys the limiter on the trusted XFF hop, ignoring spoofable left-most entries", async () => {
    const { limiters, keys } = recordingLimiters();
    const app = createAccountErasureRoutes(
      config,
      createTestLayer(),
      undefined,
      limiters,
      { secure: false },
      { trustedProxyCount: 1 },
    );
    const res = await app.handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { "x-forwarded-for": "9.9.9.9, 1.2.3.4" },
      }),
    );
    // Rate limit passed (limiter said yes) → the handler then 401s the
    // missing bearer token; the assertion that matters is the bucket key.
    expect(res.status).toBe(401);
    expect(keys).toEqual(["1.2.3.4"]);
  });

  it("DELETE /account is gated by the same unresolved-IP deny (its own rateLimit call site)", async () => {
    const { limiters, keys } = recordingLimiters();
    const app = createAccountErasureRoutes(config, createTestLayer(), undefined, limiters);
    const res = await app.handle(
      new Request("http://localhost/account", {
        method: "DELETE",
        headers: { "content-type": "application/json", "x-forwarded-for": "6.6.6.6" },
        body: JSON.stringify({ confirm_handle: "whoever" }),
      }),
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
    expect(keys).toEqual([]);
  });

  it("GET /account/deletion-preview spends the deletion-status limiter and counts under its own name", async () => {
    const rateLimited = vi.spyOn(metrics, "metricAuthRateLimited");
    const allow = { check: async () => true } as RateLimiterBackend;
    const denyAll = { check: async () => false } as RateLimiterBackend;
    const app = createAccountErasureRoutes(
      config,
      createTestLayer(),
      undefined,
      { accountDelete: allow, accountRestore: allow, accountDeletionStatus: denyAll },
      { secure: false },
      { trustedProxyCount: 1 },
    );
    const res = await app.handle(
      new Request("http://localhost/account/deletion-preview", {
        headers: { "x-forwarded-for": "1.2.3.4" },
      }),
    );
    expect(res.status).toBe(429);
    expect(rateLimited).toHaveBeenCalledWith("account_deletion_preview");
    rateLimited.mockRestore();
  });

  it("returns 429 when the per-IP limiter is exhausted", async () => {
    const denyAll: RateLimiterBackend = {
      check: async () => false,
    } as RateLimiterBackend;
    const app = createAccountErasureRoutes(
      config,
      createTestLayer(),
      undefined,
      { accountDelete: denyAll, accountRestore: denyAll, accountDeletionStatus: denyAll },
      { secure: false },
      { trustedProxyCount: 1 },
    );
    const res = await app.handle(
      new Request("http://localhost/account/restore", {
        method: "POST",
        headers: { "x-forwarded-for": "1.2.3.4" },
      }),
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
  });
});

const allowAll = (): AccountErasureRateLimiters => {
  const backend = { check: async () => true } as RateLimiterBackend;
  return {
    accountDelete: backend,
    accountRestore: backend,
    accountDeletionStatus: backend,
  };
};

/** Direct-mode client-IP resolution needs a trusted XFF hop under app.handle. */
const IP_HEADERS = { "x-forwarded-for": "1.2.3.4" };

/** A live account, "eraser", signed in, and the erasure routes on `layer`. */
async function seed(
  layer: Layer.Layer<Db | EmailService>,
  deletionApps: DeletionAppsConfig = NO_DELETION_APPS,
) {
  const auth = createAuthService(config);
  const profile = await Effect.runPromise(
    auth.registerProfile("eraser@example.com", "eraser", "Erase Me").pipe(Effect.provide(layer)),
  );
  const tokens = await Effect.runPromise(
    auth
      .issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      )
      .pipe(Effect.provide(layer)),
  );
  const app = createAccountErasureRoutes(
    config,
    layer,
    undefined,
    allowAll(),
    { secure: false },
    { trustedProxyCount: 1 },
    undefined,
    deletionApps,
  );
  const authed = { ...IP_HEADERS, Authorization: `Bearer ${tokens.accessToken}` };
  return { auth, profile, app, authed };
}

const requestDeletion = (
  app: Awaited<ReturnType<typeof seed>>["app"],
  authed: Record<string, string>,
  body: Record<string, unknown>,
) =>
  app.handle(
    new Request("http://localhost/account", {
      method: "DELETE",
      headers: { ...authed, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/**
 * The wire shapes of the success paths.
 *
 * Elysia validates AND CLEANS every body against the route's `response`
 * schema before it goes out: a key the schema omits is deleted, and a value
 * that fails its type 500s the route. So these are not documentation tests —
 * each one asserts that a real handler's body survives the schema intact.
 */
describe("account-erasure routes — response bodies", () => {
  it("DELETE /account returns 202 with both scheduling fields, and is idempotent", async () => {
    const layer = createTestLayer();
    const { auth, profile, app, authed } = await seed(layer);

    const first = await requestDeletion(app, authed, {
      confirm_handle: profile.handle,
      step_up_token: await Effect.runPromise(
        mintStepUpToken(auth, profile.accountId, "otp", "account_delete").pipe(
          Effect.provide(layer),
        ),
      ),
    });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { scheduled_for: number; already_pending: boolean };
    expect(typeof firstBody.scheduled_for).toBe("number");
    // Unix SECONDS, not milliseconds — a schema of `t.Number()` would pass
    // either, so pin the magnitude here instead.
    expect(firstBody.scheduled_for).toBeLessThan(1e12);
    expect(firstBody.already_pending).toBe(false);

    // A repeat inside the window: same schedule, flag flipped, and the date
    // does not move — that is what makes the endpoint safe to retry. A
    // pending deletion is answered before the handle check and the step-up,
    // so the handle the user typed and the redacted one both get it, with
    // no step-up token.
    for (const confirm_handle of [profile.handle, `deleted_${profile.id.replace("usr_", "")}`]) {
      const again = await requestDeletion(app, authed, { confirm_handle });
      expect(again.status).toBe(202);
      expect(await again.json()).toEqual({
        scheduled_for: firstBody.scheduled_for,
        already_pending: true,
      });
    }
  });

  it("two deletions at once: one is scheduled, the other answers that it already is", async () => {
    // The second request reads no job and goes on to the soft delete, whose
    // job insert then meets the first one's row. It answers what is stored.
    const { db, email } = createTestLayerWithSqlite();
    const queries = holdQueries(db);
    const layer = Layer.merge(Layer.succeed(Db, { db: queries.db }), email.layer);
    const { auth, profile, app, authed } = await seed(layer);
    const stepUp = () =>
      Effect.runPromise(
        mintStepUpToken(auth, profile.accountId, "otp", "account_delete").pipe(
          Effect.provide(layer),
        ),
      );
    const [heldToken, otherToken] = [await stepUp(), await stepUp()];

    const insert = queries.hold(/^insert into "deletion_jobs"/);
    const heldRequest = requestDeletion(app, authed, {
      confirm_handle: profile.handle,
      step_up_token: heldToken,
    });
    await insert.reached;
    const other = await requestDeletion(app, authed, {
      confirm_handle: profile.handle,
      step_up_token: otherToken,
    });
    insert.release();
    const held = await heldRequest;

    expect(other.status).toBe(202);
    const otherBody = (await other.json()) as { scheduled_for: number; already_pending: boolean };
    expect(otherBody.already_pending).toBe(false);
    expect(held.status).toBe(202);
    expect(await held.json()).toEqual({
      scheduled_for: otherBody.scheduled_for,
      already_pending: true,
    });
  });

  it("a database fault while the step-up token's session is checked is a 500, not a step-up refusal", async () => {
    // Red on the route answering every verifier failure as 403
    // `step_up_required`: a fault would read as "step up again".
    const base = createTestLayerWithSqlite();
    const held = holdQueries(base.db);
    const layer = Layer.merge(Layer.succeed(Db, { db: held.db }), base.email.layer);
    const { auth, profile, app, authed } = await seed(layer);
    const stepUpToken = await Effect.runPromise(
      mintStepUpToken(auth, profile.accountId, "otp", "account_delete").pipe(Effect.provide(layer)),
    );
    // The verifier's lookup of the token's session family, and no other read.
    const lookup = held.hold(/"family_id" = \?/);
    const answered = requestDeletion(app, authed, {
      confirm_handle: profile.handle,
      step_up_token: stepUpToken,
    });
    await Promise.race([lookup.reached, answered]);
    base.sqlite.run("DROP TABLE sessions");
    lookup.release();

    const res = await answered;
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 500,
      body: { error: "internal_error" },
    });
  });

  it("a rejected step-up 403s with its `detail` envelope intact", async () => {
    const layer = createTestLayer();
    const { auth, profile, app, authed } = await seed(layer);
    // An export-purpose token must not authorise a deletion.
    const wrongPurpose = await Effect.runPromise(
      mintStepUpToken(auth, profile.accountId, "otp", "account_export").pipe(Effect.provide(layer)),
    );
    const res = await requestDeletion(app, authed, {
      confirm_handle: profile.handle,
      step_up_token: wrongPurpose,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; detail?: { error: string } };
    expect(body.error).toBe("step_up_required");
    // `detail` only exists on the rejected-token branch, and only survives
    // because the route declares `stepUpRequiredResponse` rather than the
    // shared `errorResponse` — see the schema's own note.
    expect(typeof body.detail?.error).toBe("string");
  });

  it("GET /account/deletion-status answers both arms of the union", async () => {
    const layer = createTestLayer();
    const { auth, profile, app, authed } = await seed(layer);

    const before = await app.handle(
      new Request("http://localhost/account/deletion-status", { headers: authed }),
    );
    expect(before.status).toBe(200);
    // A live account is `{ scheduled: false }` and nothing else — the union's
    // false arm declares no timestamps, so any that leaked would be cleaned.
    expect(await before.json()).toEqual({ scheduled: false });

    await requestDeletion(app, authed, {
      confirm_handle: profile.handle,
      step_up_token: await Effect.runPromise(
        mintStepUpToken(auth, profile.accountId, "otp", "account_delete").pipe(
          Effect.provide(layer),
        ),
      ),
    });

    const after = await app.handle(
      new Request("http://localhost/account/deletion-status", { headers: authed }),
    );
    expect(after.status).toBe(200);
    const status = (await after.json()) as {
      scheduled: boolean;
      scheduledFor?: number;
      softDeletedAt?: number;
    };
    // The true arm carries both timestamps or the client cannot render a
    // countdown. Note the camelCase, against `scheduled_for` above.
    expect(status.scheduled).toBe(true);
    expect(typeof status.scheduledFor).toBe("number");
    expect(typeof status.softDeletedAt).toBe("number");
    expect(status.softDeletedAt!).toBeLessThanOrEqual(status.scheduledFor!);
  });

  // per-user deletion status — never cached or stored.
  it("GET /account/deletion-status sets cache-control: private, no-store", async () => {
    const layer = createTestLayer();
    const { app, authed } = await seed(layer);
    const res = await app.handle(
      new Request("http://localhost/account/deletion-status", { headers: authed }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("POST /account/restore returns the `cancelled` flag, and cancels for real", async () => {
    const layer = createTestLayer();
    const { auth, profile, app, authed } = await seed(layer);
    await requestDeletion(app, authed, {
      confirm_handle: profile.handle,
      step_up_token: await Effect.runPromise(
        mintStepUpToken(auth, profile.accountId, "otp", "account_delete").pipe(
          Effect.provide(layer),
        ),
      ),
    });

    const restored = await app.handle(
      new Request("http://localhost/account/restore", {
        method: "POST",
        headers: {
          ...authed,
          "x-step-up-token": await Effect.runPromise(
            mintStepUpToken(auth, profile.accountId, "otp", "account_restore").pipe(
              Effect.provide(layer),
            ),
          ),
        },
      }),
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ cancelled: true });

    // The status endpoint agrees — restore isn't just a 200.
    const status = await app.handle(
      new Request("http://localhost/account/deletion-status", { headers: authed }),
    );
    expect(await status.json()).toEqual({ scheduled: false });

    // Nothing pending → `cancelled: false` at 200, not an error status. A
    // client must read the flag; the same body reports a grace window that
    // has already closed, which is past resurrecting.
    const again = await app.handle(
      new Request("http://localhost/account/restore", { method: "POST", headers: authed }),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ cancelled: false });
  });
});

/**
 * The routes an account reaches to delete itself, cancel, or see what a
 * deletion would leave open, against a caller with no ordinary bearer: none
 * at all, one this issuer never signed, and a restricted recovery session's.
 * Each refusal is sent beside the account's own token on the same request,
 * which the route admits, because a 401 is also what a broken harness
 * returns.
 */
describe("account-erasure routes refuse a missing, forged or recovery bearer", () => {
  let otherKey: Awaited<ReturnType<typeof makeTestAuthConfig>>;

  beforeAll(async () => {
    otherKey = await makeTestAuthConfig();
  });

  const ROUTES = [
    {
      route: "DELETE /account",
      method: "DELETE",
      path: "/account",
      body: { confirm_handle: "not-eraser" } as Record<string, unknown> | undefined,
      admitted: { status: 400, body: { error: "handle_mismatch" } as unknown },
    },
    {
      route: "POST /account/restore",
      method: "POST",
      path: "/account/restore",
      body: {},
      admitted: { status: 200, body: { cancelled: false } },
    },
    {
      route: "GET /account/deletion-preview",
      method: "GET",
      path: "/account/deletion-preview",
      body: undefined,
      admitted: { status: 200, body: { open_actions: [], could_not_check: [] } },
    },
  ];

  type Seeded = Awaited<ReturnType<typeof seed>>;
  const run = <A, E>(layer: ReturnType<typeof createTestLayer>, effect: Effect.Effect<A, E, Db>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);

  /** The `Authorization` header each refused caller sends, or none. */
  const CALLERS: Record<
    string,
    (s: Seeded, layer: ReturnType<typeof createTestLayer>) => Promise<string | null>
  > = {
    "no Authorization header": async () => null,
    "a token signed with another key": async ({ profile }, layer) =>
      `Bearer ${
        (
          await run(
            layer,
            createAuthService(otherKey).issueTokens(
              profile.id,
              profile.accountId,
              profile.email,
              profile.handle,
              profile.displayName,
            ),
          )
        ).accessToken
      }`,
    "a restricted recovery session's token": async ({ auth, profile }, layer) =>
      `Bearer ${
        (
          await run(
            layer,
            auth.issueRecoverySession(
              profile.id,
              profile.accountId,
              profile.email,
              profile.handle,
              profile.displayName,
              "otp",
            ),
          )
        ).accessToken
      }`,
  };

  it.each(
    ROUTES.flatMap((route) =>
      Object.keys(CALLERS).map((caller) => [route.route, caller, route] as const),
    ),
  )("%s refuses %s with 401", async (_name, caller, route) => {
    const layer = createTestLayer();
    const seeded = await seed(layer);
    const authorization = await CALLERS[caller]!(seeded, layer);
    const send = (headers: Record<string, string>) =>
      seeded.app.handle(
        new Request(`http://localhost${route.path}`, {
          method: route.method,
          headers:
            route.body === undefined ? headers : { ...headers, "content-type": "application/json" },
          body: route.body === undefined ? undefined : JSON.stringify(route.body),
        }),
      );

    const refused = await send(
      authorization === null ? IP_HEADERS : { ...IP_HEADERS, Authorization: authorization },
    );
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "unauthorized" });

    const admitted = await send(seeded.authed);
    expect(admitted.status).toBe(route.admitted.status);
    expect(await admitted.json()).toEqual(route.admitted.body);
  });
});

/** Runs a service effect on `layer`. */
const runOn = <A, E, R>(layer: Layer.Layer<Db | EmailService>, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);

const stepUpFor = (
  auth: ReturnType<typeof createAuthService>,
  accountId: string,
  purpose: "account_delete" | "account_restore",
  layer: Layer.Layer<Db | EmailService>,
) => runOn(layer, mintStepUpToken(auth, accountId, "otp", purpose));

describe("POST /account/restore asks for an account_restore step-up", () => {
  const restore = (
    app: Awaited<ReturnType<typeof seed>>["app"],
    authed: Record<string, string>,
    body?: Record<string, unknown>,
  ) =>
    app.handle(
      new Request("http://localhost/account/restore", {
        method: "POST",
        headers: body ? { ...authed, "content-type": "application/json" } : authed,
        body: body ? JSON.stringify(body) : undefined,
      }),
    );

  it("a database fault while the step-up token's session is checked is a 500, not a step-up refusal", async () => {
    // Red on the route answering every verifier failure as 403
    // `step_up_required`: a fault would read as "step up again".
    const base = createTestLayerWithSqlite();
    const held = holdQueries(base.db);
    const layer = Layer.merge(Layer.succeed(Db, { db: held.db }), base.email.layer);
    const { auth, profile, app, authed } = await seed(layer);
    await requestDeletion(app, authed, {
      confirm_handle: profile.handle,
      step_up_token: await stepUpFor(auth, profile.accountId, "account_delete", layer),
    });
    const stepUpToken = await stepUpFor(auth, profile.accountId, "account_restore", layer);
    // The verifier's lookup of the token's session family, and no other read.
    const lookup = held.hold(/"family_id" = \?/);
    const answered = restore(app, authed, { step_up_token: stepUpToken });
    await Promise.race([lookup.reached, answered]);
    base.sqlite.run("DROP TABLE sessions");
    lookup.release();

    const res = await answered;
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 500,
      body: { error: "internal_error" },
    });
  });

  it("refuses without one, and with one for another purpose, and cancels with one", async () => {
    const layer = createTestLayer();
    const { auth, profile, app, authed } = await seed(layer);
    await requestDeletion(app, authed, {
      confirm_handle: profile.handle,
      step_up_token: await stepUpFor(auth, profile.accountId, "account_delete", layer),
    });

    const missing = await restore(app, authed);
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: "step_up_required" });

    const wrongPurpose = await restore(app, authed, {
      step_up_token: await stepUpFor(auth, profile.accountId, "account_delete", layer),
    });
    expect(wrongPurpose.status).toBe(403);
    const refused = (await wrongPurpose.json()) as { error: string; detail?: { error: string } };
    expect(refused.error).toBe("step_up_required");
    expect(typeof refused.detail?.error).toBe("string");

    // Still pending after both refusals.
    const status = await app.handle(
      new Request("http://localhost/account/deletion-status", { headers: authed }),
    );
    expect(((await status.json()) as { scheduled: boolean }).scheduled).toBe(true);

    const cancelled = await restore(app, authed, {
      step_up_token: await stepUpFor(auth, profile.accountId, "account_restore", layer),
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ cancelled: true });
  });
});

describe("a handle held through the erasure routes", () => {
  it("is refused by registration, the handle check, profile and organisation creation, pending and erased", async () => {
    const layer = createTestLayer();
    const { auth, profile, app, authed } = await seed(layer);
    const other = await runOn(layer, auth.registerProfile("other@example.com", "other"));
    const deleted = await requestDeletion(app, authed, {
      confirm_handle: profile.handle,
      step_up_token: await stepUpFor(auth, profile.accountId, "account_delete", layer),
    });
    expect(deleted.status).toBe(202);

    // Each site built as its own route factory builds it, with its own auth service.
    const attempts = async (handle: string) => ({
      register: (
        await runOn(
          layer,
          Effect.result(createAuthService(config).registerProfile("new@example.com", handle)),
        )
      )._tag,
      available: (await runOn(layer, createAuthService(config).checkHandle(handle))).available,
      profile: (
        await runOn(
          layer,
          Effect.result(
            createProfileService(createAuthService(config)).createProfile(other.accountId, handle),
          ),
        )
      )._tag,
      organisation: (
        await runOn(
          layer,
          Effect.result(
            createOrganisationService({
              heldHandleDigest: createAuthService(config).heldHandleDigest,
            }).createOrganisation(other.id, handle, "Someone"),
          ),
        )
      )._tag,
    });
    const refusedEverywhere = {
      register: "Failure",
      available: false,
      profile: "Failure",
      organisation: "Failure",
    };

    expect(await attempts("eraser")).toEqual(refusedEverywhere);

    await runOn(layer, everyAppDone(profile.accountId));
    const [job] = await runOn(
      layer,
      Effect.gen(function* () {
        const { db } = yield* Db;
        return yield* Effect.promise(() =>
          db.select().from(deletionJobs).where(eq(deletionJobs.accountId, profile.accountId)),
        );
      }),
    );
    expect(
      await runOn(layer, runHardDeleteSweep({ nowMs: (job!.hardDeleteAt + 1) * 1_000 })),
    ).toEqual({ purged: 1 });
    // No profile has the handle any more; the hold alone refuses it.
    const left = await runOn(
      layer,
      Effect.gen(function* () {
        const { db } = yield* Db;
        return yield* Effect.promise(() => db.select().from(users).where(eq(users.id, profile.id)));
      }),
    );
    expect(left).toEqual([]);

    expect(await attempts("eraser")).toEqual(refusedEverywhere);
  });
});

/**
 * An account that owns organisations: the preview lists one open action per
 * organisation, and the deletion waits for a choice where no other admin
 * could take it over. A choice is checked before the step-up token is spent.
 */
describe("the organisations an account owns", () => {
  async function owner() {
    const layer = createTestLayer();
    const seeded = await seed(layer);
    const orgs = createOrganisationService({ heldHandleDigest: seeded.auth.heldHandleDigest });
    const bob = await runOn(layer, seeded.auth.registerProfile("bob@example.com", "bob"));
    const acme = await runOn(layer, orgs.createOrganisation(seeded.profile.id, "acme", "Acme"));
    await runOn(layer, orgs.addMember(acme.id, seeded.profile.id, bob.id, "member"));
    return { ...seeded, layer, orgs, bob, acme };
  }

  const preview = (app: Awaited<ReturnType<typeof seed>>["app"], authed: Record<string, string>) =>
    app.handle(new Request("http://localhost/account/deletion-preview", { headers: authed }));

  type OpenAction = {
    id: string;
    default_choice: string | null;
    organisation: { id: string };
    choices: { choice: string; description: string }[];
    successor: { profile_id: string; role: string } | null;
  };

  it("GET /account/deletion-preview lists each with its successor and the choices it allows", async () => {
    const h = await owner();
    const carol = await runOn(h.layer, h.auth.registerProfile("carol@example.com", "carol"));
    const dave = await runOn(h.layer, h.auth.registerProfile("dave@example.com", "dave"));
    const withAdmin = await runOn(
      h.layer,
      h.orgs.createOrganisation(h.profile.id, "withadmin", "With Admin"),
    );
    await runOn(h.layer, h.orgs.addMember(withAdmin.id, h.profile.id, dave.id, "member"));
    await runOn(h.layer, h.orgs.addMember(withAdmin.id, h.profile.id, carol.id, "admin"));
    const alone = await runOn(h.layer, h.orgs.createOrganisation(h.profile.id, "alone", "Alone"));

    const res = await preview(h.app, h.authed);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const { open_actions } = (await res.json()) as { open_actions: OpenAction[] };
    const of = (orgId: string) => open_actions.find((a) => a.organisation.id === orgId);
    expect(open_actions).toHaveLength(3);
    expect(of(withAdmin.id)).toEqual({
      id: `osn:organisation:${withAdmin.id}`,
      app: "osn",
      kind: "organisation_owned",
      label: "You own With Admin (@withadmin).",
      choices: [
        { choice: "transfer", description: "@carol becomes the owner.", erased_on: null },
        {
          choice: "successor",
          description: "The member you name becomes the owner.",
          erased_on: null,
        },
        {
          choice: "delete",
          description: "The organisation and its memberships are deleted.",
          erased_on: null,
        },
      ],
      default_choice: "transfer",
      link: null,
      organisation: { id: withAdmin.id, handle: "withadmin", name: "With Admin" },
      successor: { profile_id: carol.id, handle: "carol", display_name: null, role: "admin" },
    });
    // No other admin: the same choices, and none taken for the person.
    expect(of(h.acme.id)).toMatchObject({
      default_choice: null,
      choices: [
        { choice: "transfer", description: "@bob becomes the owner." },
        { choice: "successor" },
        { choice: "delete" },
      ],
      successor: { profile_id: h.bob.id, role: "member" },
    });
    // No other member: it can only be deleted.
    expect(of(alone.id)).toMatchObject({
      default_choice: null,
      choices: [{ choice: "delete" }],
      successor: null,
    });
  });

  it("GET /account/deletion-preview refuses the token of an account whose deletion is pending", async () => {
    const h = await owner();
    expect((await preview(h.app, h.authed)).status).toBe(200);
    await requestDeletion(h.app, h.authed, {
      confirm_handle: h.profile.handle,
      step_up_token: await stepUpFor(h.auth, h.profile.accountId, "account_delete", h.layer),
      choices: [{ action: `osn:organisation:${h.acme.id}`, choice: "delete" }],
    });

    expect((await preview(h.app, h.authed)).status).toBe(401);
  });

  it("DELETE /account waits for a choice, refuses a bad one, and spends the step-up only on success", async () => {
    const h = await owner();
    const action = `osn:organisation:${h.acme.id}`;
    const carol = await runOn(h.layer, h.auth.registerProfile("carol@example.com", "carol"));
    const ownOther = await runOn(
      h.layer,
      createProfileService(h.auth).createProfile(h.profile.accountId, "erasertwo"),
    );
    await runOn(h.layer, h.orgs.addMember(h.acme.id, h.profile.id, ownOther.id, "admin"));
    const token = await stepUpFor(h.auth, h.profile.accountId, "account_delete", h.layer);
    const attempt = (choices?: unknown[]) =>
      requestDeletion(h.app, h.authed, {
        confirm_handle: h.profile.handle,
        step_up_token: token,
        ...(choices ? { choices } : {}),
      });

    const waiting = await attempt();
    expect(waiting.status).toBe(409);
    const open = (await waiting.json()) as { error: string; open_actions: OpenAction[] };
    expect(open.error).toBe("open_actions");
    expect(open.open_actions.map((a) => a.id)).toEqual([action]);

    for (const choices of [
      // Not one of its choices.
      [{ action, choice: "archive" }],
      // A successor who is not a member.
      [{ action, choice: "successor", successor_profile_id: carol.id }],
      // A member, but a profile of the same account.
      [{ action, choice: "successor", successor_profile_id: ownOther.id }],
      // No successor named.
      [{ action, choice: "successor" }],
      // Two answers to one action.
      [
        { action, choice: "transfer" },
        { action, choice: "delete" },
      ],
    ]) {
      const refused = await attempt(choices);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "invalid_choice", action });
    }

    // The same step-up token, so every refusal above left it unspent. An
    // action id the account does not have is ignored.
    const scheduled = await attempt([
      { action: "osn:organisation:org_000000000000", choice: "delete" },
      { action, choice: "successor", successor_profile_id: h.bob.id },
    ]);
    expect(scheduled.status).toBe(202);
    const [job] = await runOn(
      h.layer,
      Effect.gen(function* () {
        const { db } = yield* Db;
        return yield* Effect.promise(() =>
          db.select().from(deletionJobs).where(eq(deletionJobs.accountId, h.profile.accountId)),
        );
      }),
    );
    expect(JSON.parse(job!.choices!)).toEqual({
      [action]: { choice: "successor", successorProfileId: h.bob.id },
    });
  });

  it("DELETE /account allows only delete for an organisation with no other member", async () => {
    const h = await owner();
    const solo = await runOn(h.layer, h.orgs.createOrganisation(h.profile.id, "solo", "Solo"));
    const soloAction = `osn:organisation:${solo.id}`;
    const acmeAnswer = { action: `osn:organisation:${h.acme.id}`, choice: "delete" };
    const token = await stepUpFor(h.auth, h.profile.accountId, "account_delete", h.layer);
    const attempt = (choices: unknown[]) =>
      requestDeletion(h.app, h.authed, {
        confirm_handle: h.profile.handle,
        step_up_token: token,
        choices,
      });

    // Not answered: it waits for one, though no one could take it over.
    const waiting = await attempt([acmeAnswer]);
    expect(waiting.status).toBe(409);
    const open = (await waiting.json()) as { error: string; open_actions: OpenAction[] };
    expect(open.error).toBe("open_actions");
    expect(open.open_actions.map((a) => a.id)).toEqual([soloAction]);

    for (const answer of [
      { action: soloAction, choice: "transfer" },
      { action: soloAction, choice: "successor", successor_profile_id: h.bob.id },
    ]) {
      const refused = await attempt([acmeAnswer, answer]);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "invalid_choice", action: soloAction });
    }

    const scheduled = await attempt([acmeAnswer, { action: soloAction, choice: "delete" }]);
    expect(scheduled.status).toBe(202);
  });

  it("DELETE /account refuses a successor who is a member of another of the organisations only", async () => {
    // bob is a member of acme, carol of beta. Named for beta, bob is refused,
    // though a read of both organisations' members finds him.
    const h = await owner();
    const carol = await runOn(h.layer, h.auth.registerProfile("carol@example.com", "carol"));
    const beta = await runOn(h.layer, h.orgs.createOrganisation(h.profile.id, "beta", "Beta"));
    await runOn(h.layer, h.orgs.addMember(beta.id, h.profile.id, carol.id, "member"));
    const acmeAction = `osn:organisation:${h.acme.id}`;
    const betaAction = `osn:organisation:${beta.id}`;
    const token = await stepUpFor(h.auth, h.profile.accountId, "account_delete", h.layer);
    const attempt = (betaSuccessor: string) =>
      requestDeletion(h.app, h.authed, {
        confirm_handle: h.profile.handle,
        step_up_token: token,
        choices: [
          { action: acmeAction, choice: "successor", successor_profile_id: h.bob.id },
          { action: betaAction, choice: "successor", successor_profile_id: betaSuccessor },
        ],
      });

    const refused = await attempt(h.bob.id);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_choice", action: betaAction });

    // Control: beta's own member is admitted, with the same unspent token.
    expect((await attempt(carol.id)).status).toBe(202);
  });

  it("DELETE /account takes 200 choices and refuses 201 at the body schema", async () => {
    const h = await owner();
    const action = `osn:organisation:${h.acme.id}`;
    const token = await stepUpFor(h.auth, h.profile.accountId, "account_delete", h.layer);
    // Answers to actions the account does not have, which the route ignores.
    const ignored = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        action: `osn:organisation:org_${String(i).padStart(12, "0")}`,
        choice: "delete",
      }));
    const attempt = (choices: unknown[]) =>
      requestDeletion(h.app, h.authed, {
        confirm_handle: h.profile.handle,
        step_up_token: token,
        choices,
      });

    const over = await attempt([...ignored(200), { action, choice: "delete" }]);
    expect(over.status).toBe(422);

    // The refusal above spent nothing: the same token schedules the deletion.
    const atCap = await attempt([...ignored(199), { action, choice: "delete" }]);
    expect(atCap.status).toBe(202);
  });

  it("DELETE /account needs no choice for an organisation another admin can take over", async () => {
    const h = await owner();
    await runOn(h.layer, h.orgs.updateMemberRole(h.acme.id, h.profile.id, h.bob.id, "admin"));

    const res = await requestDeletion(h.app, h.authed, {
      confirm_handle: h.profile.handle,
      step_up_token: await stepUpFor(h.auth, h.profile.accountId, "account_delete", h.layer),
    });

    expect(res.status).toBe(202);
  });
});

/**
 * What the apps hold: the preview lists each app's open actions beside the
 * organisations, an app that cannot be asked holds the deletion, and the
 * answers, or "delete everything", are checked before the step-up is spent and
 * stored on the job.
 */
describe("the apps' open actions", () => {
  let answer: (call: AppCall) => AppAnswer | undefined = () => undefined;
  const apps = appStandIns((call) => answer(call));
  afterAll(() => apps.stop());

  const hosted = (id: string, defaultChoice: string | null = "cancel") => ({
    id: `pulse:event:${id}`,
    kind: "events_hosted",
    label: `You host ${id}.`,
    choices: [
      { choice: "cancel", description: "Shown as cancelled.", erasedOn: 1_900_000_000 },
      { choice: "delete", description: "Deleted.", erasedOn: null },
    ],
    defaultChoice,
    link: null,
  });

  /** Pulse previews `actions`; Zap answers none. */
  const pulseHolds = (...actions: unknown[]) => {
    answer = (call) =>
      call.app === "pulse" && call.path === "/internal/account-deletion-preview"
        ? { body: { openActions: actions } }
        : undefined;
  };

  async function person() {
    const layer = createTestLayer();
    const seeded = await seed(layer, apps.config());
    const token = await stepUpFor(seeded.auth, seeded.profile.accountId, "account_delete", layer);
    const attempt = (body: Record<string, unknown> = {}) =>
      requestDeletion(seeded.app, seeded.authed, {
        confirm_handle: seeded.profile.handle,
        step_up_token: token,
        ...body,
      });
    const job = async () =>
      (
        await runOn(
          layer,
          Effect.gen(function* () {
            const { db } = yield* Db;
            return yield* Effect.promise(() =>
              db
                .select()
                .from(deletionJobs)
                .where(eq(deletionJobs.accountId, seeded.profile.accountId)),
            );
          }),
        )
      )[0];
    return { ...seeded, layer, attempt, job };
  }

  const callsTo = (path: string, accountId: string) =>
    apps.calls.filter((call) => call.path === path && call.body.accountId === accountId);

  it("GET /account/deletion-preview lists each app's actions in the route's field names", async () => {
    pulseHolds(hosted("evt_1"));
    const p = await person();
    const res = await p.app.handle(
      new Request("http://localhost/account/deletion-preview", { headers: p.authed }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      open_actions: [
        {
          id: "pulse:event:evt_1",
          app: "pulse",
          kind: "events_hosted",
          label: "You host evt_1.",
          choices: [
            { choice: "cancel", description: "Shown as cancelled.", erased_on: 1_900_000_000 },
            { choice: "delete", description: "Deleted.", erased_on: null },
          ],
          default_choice: "cancel",
          link: null,
        },
      ],
      could_not_check: [],
    });
    const [call] = callsTo("/internal/account-deletion-preview", p.profile.accountId).filter(
      (c) => c.app === "pulse",
    );
    expect(call!.body.profileIds).toEqual([p.profile.id]);
    expect(call!.body.deletesAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 6 * 86_400);
  });

  it("GET /account/deletion-preview names an app that could not be asked", async () => {
    answer = (call) => (call.app === "zap" ? { status: 503, body: {} } : undefined);
    const p = await person();
    const res = await p.app.handle(
      new Request("http://localhost/account/deletion-preview", { headers: p.authed }),
    );
    expect(await res.json()).toEqual({ open_actions: [], could_not_check: ["zap"] });
  });

  it("DELETE /account refuses answers with delete everything before asking any app", async () => {
    pulseHolds(hosted("evt_1"));
    const p = await person();
    const res = await p.attempt({
      delete_everything: true,
      choices: [{ action: "pulse:event:evt_1", choice: "delete" }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "choices_with_delete_everything" });
    expect(callsTo("/internal/account-deletion-preview", p.profile.accountId)).toEqual([]);
  });

  it("DELETE /account is held while an app cannot be asked, before the answers and the step-up", async () => {
    answer = (call) => (call.app === "pulse" ? { status: 500, body: {} } : undefined);
    const p = await person();
    const held = await p.attempt({ choices: [{ action: "pulse:event:evt_1", choice: "keep" }] });
    expect(held.status).toBe(409);
    expect(await held.json()).toEqual({
      error: "could_not_check",
      open_actions: [],
      could_not_check: ["pulse"],
    });
    expect(await p.job()).toBeUndefined();

    // The step-up token was not spent: once Pulse answers, it schedules.
    pulseHolds();
    expect((await p.attempt()).status).toBe(202);
  });

  it("DELETE /account waits for an app action with no default, and refuses an answer it does not offer", async () => {
    pulseHolds(hosted("evt_1", null), hosted("evt_2"));
    const p = await person();

    const waiting = await p.attempt();
    expect(waiting.status).toBe(409);
    const open = (await waiting.json()) as { error: string; open_actions: { id: string }[] };
    expect(open.error).toBe("open_actions");
    expect(open.open_actions.map((a) => a.id)).toEqual(["pulse:event:evt_1"]);

    for (const choices of [
      [{ action: "pulse:event:evt_1", choice: "keep" }],
      [
        { action: "pulse:event:evt_1", choice: "cancel" },
        { action: "pulse:event:evt_1", choice: "delete" },
      ],
    ]) {
      const refused = await p.attempt({ choices });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: "invalid_choice",
        action: "pulse:event:evt_1",
      });
    }

    const scheduled = await p.attempt({
      choices: [
        { action: "pulse:event:evt_1", choice: "delete" },
        { action: "elsewhere:thing", choice: "x" },
      ],
    });
    expect(scheduled.status).toBe(202);
    expect(JSON.parse((await p.job())!.choices!)).toEqual({
      "pulse:event:evt_1": { choice: "delete" },
    });
  });

  it("DELETE /account refuses an invalid answer even while another action waits", async () => {
    pulseHolds(hosted("evt_1", null), hosted("evt_2"));
    const p = await person();
    const refused = await p.attempt({ choices: [{ action: "pulse:event:evt_2", choice: "keep" }] });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_choice", action: "pulse:event:evt_2" });
  });

  it("DELETE /account answers stale_choices for an app action the fresh preview no longer lists", async () => {
    pulseHolds(hosted("evt_2"));
    const p = await person();
    const res = await p.attempt({ choices: [{ action: "pulse:event:evt_1", choice: "delete" }] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; open_actions: { id: string }[] };
    expect(body.error).toBe("stale_choices");
    expect(body.open_actions.map((a) => a.id)).toEqual(["pulse:event:evt_2"]);
    expect(await p.job()).toBeUndefined();
  });

  it("DELETE /account with delete everything stores the flag and no answers, whatever waits", async () => {
    pulseHolds(hosted("evt_1", null));
    const p = await person();
    const solo = await runOn(
      p.layer,
      createOrganisationService({ heldHandleDigest: p.auth.heldHandleDigest }).createOrganisation(
        p.profile.id,
        "solo",
        "Solo",
      ),
    );
    expect(solo.id).toBeTruthy();
    const res = await p.attempt({ delete_everything: true });
    expect(res.status).toBe(202);
    const job = await p.job();
    expect(job!.deleteEverything).toBe(true);
    expect(job!.choices).toBeNull();
  });

  it("a soft delete ends the person's Pulse sessions, with their profiles, and only Pulse's", async () => {
    pulseHolds();
    const p = await person();
    expect((await p.attempt()).status).toBe(202);
    await vi.waitFor(() =>
      expect(callsTo("/internal/account-sessions/revoke", p.profile.accountId)).toHaveLength(1),
    );
    const [call] = callsTo("/internal/account-sessions/revoke", p.profile.accountId);
    expect(call).toMatchObject({ app: "pulse", body: { profileIds: [p.profile.id] } });
    expect(call!.authorization).toMatch(/^ARC /);
  });

  it("a soft delete stands when Pulse refuses to end the sessions", async () => {
    answer = (call) =>
      call.path === "/internal/account-sessions/revoke" ? { status: 503, body: {} } : undefined;
    const p = await person();
    expect((await p.attempt()).status).toBe(202);
    expect((await p.job())!.accountId).toBe(p.profile.accountId);
  });
});

import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { describe, it, expect, beforeAll } from "vitest";

import {
  createAccountErasureRoutes,
  type AccountErasureRateLimiters,
} from "../../src/routes/account-erasure";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

/**
 * S-M5 (osn): the erasure endpoints must key their per-IP limiters via the
 * shared `clientIpConfig` trust policy — spoofable left-most XFF hops must
 * not choose the bucket, and an unresolvable client must be denied rather
 * than pooled into a shared "unknown" bucket (S-M34 posture, mirroring the
 * auth / profile routes).
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

/**
 * The wire shapes of the success paths.
 *
 * Elysia validates AND CLEANS every body against the route's `response`
 * schema before it goes out: a key the schema omits is deleted, and a value
 * that fails its type 500s the route. So these are not documentation tests —
 * each one asserts that a real handler's body survives the schema intact.
 */
describe("account-erasure routes — response bodies", () => {
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

  async function seed(layer: ReturnType<typeof createTestLayer>) {
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

  it("DELETE /account returns 202 with both scheduling fields, and is idempotent", async () => {
    const layer = createTestLayer();
    const { auth, profile, app, authed } = await seed(layer);

    const first = await requestDeletion(app, authed, {
      confirm_handle: profile.handle,
      step_up_token: await Effect.runPromise(
        auth.issueStepUpToken(profile.accountId, "otp", "account_delete"),
      ),
    });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { scheduled_for: number; already_pending: boolean };
    expect(typeof firstBody.scheduled_for).toBe("number");
    // Unix SECONDS, not milliseconds — a schema of `t.Number()` would pass
    // either, so pin the magnitude here instead.
    expect(firstBody.scheduled_for).toBeLessThan(1e12);
    expect(firstBody.already_pending).toBe(false);

    // Second call inside the window: same schedule, flag flipped. The date
    // must not move — that is what makes the endpoint safe to retry.
    //
    // Note the handle: soft-delete redacts every profile handle to
    // `deleted_<usr-suffix>`, and the route checks the confirmation BEFORE it
    // reaches the idempotent service path. So a client retrying with the
    // handle the user actually typed gets 400 `handle_mismatch`, not the
    // `already_pending` body below. Worth settling, but it is a behaviour
    // change, not a schema one — recorded here rather than fixed in this PR.
    const second = await requestDeletion(app, authed, {
      confirm_handle: `deleted_${profile.id.replace("usr_", "")}`,
      step_up_token: await Effect.runPromise(
        auth.issueStepUpToken(profile.accountId, "otp", "account_delete"),
      ),
    });
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({
      scheduled_for: firstBody.scheduled_for,
      already_pending: true,
    });
  });

  it("a rejected step-up 403s with its `detail` envelope intact", async () => {
    const layer = createTestLayer();
    const { auth, profile, app, authed } = await seed(layer);
    // An export-purpose token must not authorise a deletion.
    const wrongPurpose = await Effect.runPromise(
      auth.issueStepUpToken(profile.accountId, "otp", "account_export"),
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
        auth.issueStepUpToken(profile.accountId, "otp", "account_delete"),
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

  // tracker#468: per-user deletion status — never cached or stored.
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
        auth.issueStepUpToken(profile.accountId, "otp", "account_delete"),
      ),
    });

    const restored = await app.handle(
      new Request("http://localhost/account/restore", { method: "POST", headers: authed }),
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

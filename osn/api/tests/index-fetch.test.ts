import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { handler, type Env } from "../src/index";
import { _resetOutboundKeyForTests } from "../src/lib/outbound-arc";

/**
 * T-R1 — Workers `fetch` handler fail-closed paths.
 *
 * Drives the real exported `handler.fetch(req, env)` with a fake `env` and
 * asserts the fail-closed 503 posture. These paths need NO DB binding: they
 * short-circuit in the required-binding/var check BEFORE `buildAll` runs, so
 * they don't depend on a real (or miniflare) D1 binding.
 *
 * The happy-path `fetch` through a live D1 binding is exercised by the
 * Miniflare-backed `src/d1-integration.test.ts` (run under `bun test`); wiring
 * a full D1 round-trip into this synchronous vitest suite is impractical, so
 * the request-id echo/mint contract is covered directly in `request-id.test.ts`
 * via the `resolveRequestId` unit (T-S2).
 */

const req = (url = "https://api.osn.test/"): Request => new Request(url);

async function read503(res: Response): Promise<{ status: number; error: string }> {
  expect(res.status).toBe(503);
  expect(res.headers.get("Content-Type")).toBe("application/json");
  const json = (await res.json()) as { error: string };
  return { status: res.status, error: json.error };
}

describe("handler.fetch — fail-closed (T-R1)", () => {
  it("returns 503 with the misconfigured JSON body when env.DB is missing (local)", async () => {
    // No OSN_ENV ⇒ local. DB is still mandatory in every tier.
    const env = {} as Env;
    const { error } = await read503(await handler.fetch(req(), env));
    expect(error).toContain("Worker misconfigured");
    expect(error).toContain("DB");
  });

  it("returns 503 in a non-local tier when the required vars are missing", async () => {
    // production tier + a present DB, but the deploy-time required vars
    // (issuer / CORS / RP) are all absent ⇒ fail closed at the edge.
    const env = {
      OSN_ENV: "production",
      DB: {} as Env["DB"],
    } as Env;
    const { error } = await read503(await handler.fetch(req(), env));
    expect(error).toContain("Worker misconfigured");
    // All three deploy-time required vars are reported as missing.
    expect(error).toContain("OSN_ISSUER_URL");
    expect(error).toContain("OSN_CORS_ORIGIN");
    expect(error).toContain("OSN_RP_ID");
  });

  it("reports DB first when both DB and the non-local vars are missing", async () => {
    // DB absence wins regardless of tier (the `|| !env.DB` short-circuit).
    const env = { OSN_ENV: "production" } as Env;
    const { error } = await read503(await handler.fetch(req(), env));
    expect(error).toContain("Worker misconfigured");
    expect(error).toContain("DB");
  });

  it("does NOT require the issuer/CORS/RP vars in a local tier", async () => {
    // OSN_ENV unset ⇒ local: only DB is required. With DB absent the 503 body
    // must NOT mention the non-local-only vars.
    const env = {} as Env;
    const { error } = await read503(await handler.fetch(req(), env));
    expect(error).not.toContain("OSN_ISSUER_URL");
    expect(error).not.toContain("OSN_CORS_ORIGIN");
    expect(error).not.toContain("OSN_RP_ID");
  });
});

/**
 * T-R2 — the cron `scheduled` handler registers osn's outbound ARC public key
 * with each downstream BEFORE the fan-out sweeps. Pulse/Zap verify osn's ARC
 * tokens against a pre-registered key, so without this the very first
 * `/internal/account-deleted` POST is 401'd and GDPR Art. 17 erasure stalls.
 *
 * Drives the real exported `handler.scheduled(event, env, ctx)` with a fake
 * env + a `waitUntil` collector. The DB-backed sweeps run against a stub D1
 * binding and fail internally — they're wrapped in `Effect.catchAll`/`logError`
 * so they never throw out of `scheduled`; this test only asserts the
 * registration POSTs fired and are once-per-isolate.
 */
describe("handler.scheduled — outbound ARC key registration (T-R2)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const collectWaitUntil = (): { ctx: ExecutionContext; settled: () => Promise<void> } => {
    const promises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => promises.push(p.catch(() => undefined)),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    return { ctx, settled: async () => void (await Promise.all(promises)) };
  };

  const registerCalls = (): number =>
    fetchSpy.mock.calls.filter((c: Parameters<typeof fetch>) => {
      const input = c[0];
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url.includes("/internal/register-service");
    }).length;

  const env: Env = {
    DB: {} as Env["DB"],
    OSN_ENV: "production",
    PULSE_API_URL: "https://pulse.test",
    ZAP_API_URL: "https://zap.test",
    INTERNAL_SERVICE_SECRET: "s3cr3t",
  };

  const scheduledEvent = {
    scheduledTime: Date.now(),
    cron: "0 */6 * * *",
    noRetry: () => {},
  } as unknown as ScheduledController;

  beforeEach(() => {
    _resetOutboundKeyForTests();
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    _resetOutboundKeyForTests();
  });

  it("POSTs register-service to each downstream on the first cron tick", async () => {
    const { ctx, settled } = collectWaitUntil();
    await handler.scheduled(scheduledEvent, env, ctx);
    await settled();
    // One register-service POST per downstream (pulse + zap).
    expect(registerCalls()).toBe(2);
  });

  it("does NOT re-register on a second tick within the same isolate", async () => {
    const first = collectWaitUntil();
    await handler.scheduled(scheduledEvent, env, first.ctx);
    await first.settled();
    expect(registerCalls()).toBe(2);

    const second = collectWaitUntil();
    await handler.scheduled(scheduledEvent, env, second.ctx);
    await second.settled();
    // Still 2 — the once-per-isolate latch suppressed the second pass.
    expect(registerCalls()).toBe(2);
  });

  it("does not throw when env.DB is absent (early return)", async () => {
    const { ctx } = collectWaitUntil();
    await expect(handler.scheduled(scheduledEvent, {} as Env, ctx)).resolves.toBeUndefined();
    expect(registerCalls()).toBe(0);
  });
});

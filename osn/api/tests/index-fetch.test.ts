import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { describe, it, expect, vi } from "vitest";

import { handler, type Env } from "../src/index";
import { _resetOutboundKeyForTests } from "../src/lib/outbound-arc";
import { createFakeNamespace } from "./helpers/coordination-namespace";
import { userTierBindings } from "./helpers/rate-limit-bindings";

/**
 * Workers `fetch` handler fail-closed paths.
 *
 * Drives the real exported `handler.fetch(req, env)` with a fake `env` and
 * asserts the fail-closed 503 posture. These paths need NO DB binding: they
 * short-circuit in the required-binding/var check BEFORE `buildAll` runs, so
 * they don't depend on a real (or miniflare) D1 binding.
 *
 * The happy-path `fetch` through a live D1 binding is exercised by the
 * Miniflare-backed `tests/d1/d1-integration.test.ts` (run under `bun test`); wiring
 * a full D1 round-trip into this synchronous vitest suite is impractical, so
 * the request-id echo/mint contract is covered directly in `request-id.test.ts`
 * via the `resolveRequestId` unit.
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

  it("returns 503 naming RESEND_API_URL when a deployed tier carries the emulator override", async () => {
    // Every edge check passes, so the build reaches email
    // selection, which refuses the override in any non-local tier.
    const env = {
      OSN_ENV: "production",
      DB: {} as Env["DB"],
      OSN_ISSUER_URL: "https://id.osn.test",
      OSN_CORS_ORIGIN: "https://osn.test",
      OSN_RP_ID: "osn.test",
      COORDINATION: createFakeNamespace().ns,
      ...userTierBindings(),
      RESEND_API_KEY: "re_live",
      RESEND_API_URL: "http://localhost:4008",
    } as Env;
    const { error } = await read503(await handler.fetch(req(), env));
    expect(error).toContain("Worker misconfigured");
    expect(error).toContain("RESEND_API_URL");
    expect(error).not.toContain("localhost:4008");
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

  it.each(["dev", "staging", "production"])(
    "returns 503 naming the per-user rate-limit bindings when %s lacks them",
    async (tier) => {
      // The graph, organisation and recommendation limiters run only on these
      // in a deployed tier; without them every write would cost a store call.
      const env = {
        OSN_ENV: tier,
        DB: {} as Env["DB"],
        COORDINATION: createFakeNamespace().ns,
        OSN_ISSUER_URL: "https://id.osn.test",
        OSN_CORS_ORIGIN: "https://osn.test",
        OSN_RP_ID: "osn.test",
      } as Env;
      const { error } = await read503(await handler.fetch(req(), env));
      expect(error).toBe("Worker misconfigured: missing RL_USER_20_60, RL_USER_60_60");
    },
  );

  it("does NOT require the per-user rate-limit bindings in a local tier", async () => {
    // Local `wrangler dev` without them keeps those limiters on the store.
    const env = { DB: {} as Env["DB"] } as Env;
    const { error } = await read503(await handler.fetch(req(), env));
    expect(error).toBe("Worker misconfigured: missing COORDINATION");
  });
});

/**
 * The cron `scheduled` handler registers osn's outbound ARC public key
 * with each downstream BEFORE the fan-out sweeps. Pulse/Zap verify osn's ARC
 * tokens against a pre-registered key, so without this the very first
 * `/internal/account-deleted` POST is 401'd and GDPR Art. 17 erasure stalls.
 *
 * Drives the real exported `handler.scheduled(event, env, ctx)` with a fake
 * env + a `waitUntil` collector. The DB-backed sweeps run against a stub D1
 * binding and fail internally — they're wrapped in `Effect.catch`/`logError`
 * so they never throw out of `scheduled`; this test only asserts the
 * registration POSTs fired and are once-per-isolate.
 */
describe("handler.scheduled", () => {
  const collectWaitUntil = (): { ctx: ExecutionContext; settled: () => Promise<void> } => {
    const promises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => promises.push(p.catch(() => undefined)),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    return { ctx, settled: async () => void (await Promise.all(promises)) };
  };

  const scheduledEvent = {
    scheduledTime: Date.now(),
    cron: "0 */6 * * *",
    noRetry: () => {},
  } as unknown as ScheduledController;

  it("does not throw when env.DB is absent (early return)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { ctx, settled } = collectWaitUntil();
    await expect(handler.scheduled(scheduledEvent, {} as Env, ctx)).resolves.toBeUndefined();
    await settled();
    // No app is called: osn-api publishes its outbound key, it never pushes it.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

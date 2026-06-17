import { describe, it, expect } from "vitest";

import { handler, type Env } from "../src/index";

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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verifyInternalBearer } from "../../src/lib/internal-auth";

/**
 * Coverage for the shared-secret bearer guard used by `/account-export/internal`
 * (and by future osn/api → pulse/api S2S endpoints, e.g. C-H2 deletion fan-out).
 *
 * Pure function — no DB / network. We toggle `INTERNAL_SERVICE_SECRET` via
 * `process.env` per case so the test set is exhaustive without a fixture.
 */

const ENV_KEY = "INTERNAL_SERVICE_SECRET";

let restore: string | undefined;

beforeEach(() => {
  restore = process.env[ENV_KEY];
});
afterEach(() => {
  if (restore === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = restore;
});

describe("verifyInternalBearer (pulse-api)", () => {
  it("returns 501 when INTERNAL_SERVICE_SECRET is unset (fail-loud, not fail-open)", () => {
    delete process.env[ENV_KEY];
    const result = verifyInternalBearer("Bearer anything");
    expect(result).toEqual({
      ok: false,
      status: 501,
      error: expect.stringMatching(/INTERNAL_SERVICE_SECRET/),
    });
  });

  it("returns 401 when the Authorization header is missing", () => {
    process.env[ENV_KEY] = "test-secret-xyz";
    expect(verifyInternalBearer(undefined)).toMatchObject({ ok: false, status: 401 });
  });

  it("returns 401 on a length mismatch (timing-safe early exit)", () => {
    process.env[ENV_KEY] = "test-secret-xyz";
    expect(verifyInternalBearer("Bearer wrong")).toMatchObject({ ok: false, status: 401 });
  });

  it("returns 401 on equal-length wrong secret (constant-time comparison reaches the inner check)", () => {
    process.env[ENV_KEY] = "test-secret-1234";
    expect(verifyInternalBearer("Bearer test-secret-XXXX")).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("returns 401 when the prefix is missing (raw secret without `Bearer `)", () => {
    process.env[ENV_KEY] = "test-secret-xyz";
    expect(verifyInternalBearer("test-secret-xyz")).toMatchObject({ ok: false });
  });

  it("returns ok:true on the correct `Bearer <secret>` header", () => {
    process.env[ENV_KEY] = "real-secret-abcdef";
    expect(verifyInternalBearer("Bearer real-secret-abcdef")).toEqual({ ok: true });
  });
});

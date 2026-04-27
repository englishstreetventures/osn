import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verifyInternalBearer } from "../../src/lib/internal-auth";

/**
 * Coverage for the Zap copy of the shared-secret bearer guard. Mirrors
 * `pulse/api/tests/lib/internal-auth.test.ts` — both files implement the
 * same contract; if they ever diverge, both tests catch it.
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

describe("verifyInternalBearer (zap-api)", () => {
  it("returns 501 when INTERNAL_SERVICE_SECRET is unset", () => {
    delete process.env[ENV_KEY];
    expect(verifyInternalBearer("Bearer anything")).toMatchObject({ ok: false, status: 501 });
  });

  it("returns 401 with no header", () => {
    process.env[ENV_KEY] = "z-secret";
    expect(verifyInternalBearer(undefined)).toMatchObject({ ok: false, status: 401 });
  });

  it("returns 401 on a length-mismatch wrong secret", () => {
    process.env[ENV_KEY] = "z-secret";
    expect(verifyInternalBearer("Bearer XYZ")).toMatchObject({ ok: false, status: 401 });
  });

  it("returns 401 on equal-length wrong secret", () => {
    process.env[ENV_KEY] = "z-secret-1234";
    expect(verifyInternalBearer("Bearer z-secret-XXXX")).toMatchObject({ ok: false });
  });

  it("returns ok:true on the correct `Bearer <secret>` header", () => {
    process.env[ENV_KEY] = "z-secret-abc";
    expect(verifyInternalBearer("Bearer z-secret-abc")).toEqual({ ok: true });
  });
});

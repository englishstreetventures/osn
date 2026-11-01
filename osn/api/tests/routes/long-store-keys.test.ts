import { makeLogEmailLive } from "@shared/email";
import { Layer } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import * as metrics from "../../src/metrics";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createFakeNamespace } from "../helpers/coordination-namespace";
import { createTestLayer } from "../helpers/db";
import { createAuthRoutes } from "../helpers/routes";

/**
 * A few routes key a store entry by what the caller typed: passkey sign-in by
 * the identifier, registration by the address, the disown link by the
 * token's lookup id. The store refuses a key over 256 characters, and that
 * refusal is not an outage, so an over-long input must be answered as the bad
 * input it is — 400, or the disown route's uniform 202 — never as 503, and
 * must reach no store object.
 */

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

function harness() {
  const fake = createFakeNamespace();
  const stores = createDurableCoordination(fake.ns, () => {});
  const app = createAuthRoutes(
    { ...config, ceremonyStores: stores.ceremonyStores },
    Layer.merge(createTestLayer(), makeLogEmailLive().layer),
  );
  const post = (path: string, body: unknown) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return { fake, post };
}

const LONG_EMAIL = `${"a".repeat(300)}@example.com`;
const assertion = { id: "x", rawId: "x", response: {}, type: "public-key" };

describe("an input too long to be a store key", () => {
  it("POST /login/passkey/begin answers 400 and touches no store", async () => {
    const h = harness();
    const res = await h.post("/login/passkey/begin", { identifier: LONG_EMAIL });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(h.fake.calls).toEqual([]);
  });

  it("POST /login/passkey/complete answers 400 and touches no store", async () => {
    const h = harness();
    const res = await h.post("/login/passkey/complete", { identifier: LONG_EMAIL, assertion });
    expect(res.status).toBe(400);
    expect(h.fake.calls).toEqual([]);
  });

  it("POST /register/complete answers 400 and touches no store", async () => {
    const h = harness();
    const res = await h.post("/register/complete", { email: LONG_EMAIL, code: "000000" });
    expect(res.status).toBe(400);
    expect(h.fake.calls).toEqual([]);
  });

  it("POST /recovery/disown answers its uniform 202 and counts a wrong token, not an outage", async () => {
    const h = harness();
    const counted = vi.spyOn(metrics, "metricRecoveryDisown");
    try {
      const res = await h.post("/recovery/disown", {
        token: `rdt_${"a".repeat(300)}.${"s".repeat(43)}`,
      });
      expect(res.status).toBe(202);
      expect(counted.mock.calls).toEqual([["invalid"]]);
      const real = "recovery_disown:rdt_0123456789ab".length;
      expect(h.fake.names.length).toBeGreaterThan(0);
      expect(h.fake.names.every((name) => name.length === real)).toBe(true);
    } finally {
      counted.mockRestore();
    }
  });
});

import { generateArcKeyPair } from "@shared/crypto";
import type { WorkersRateLimitBinding } from "@shared/rate-limit";
import { exportJWK } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app";
import { buildAppDeps, type BuildParts, type EnvVars } from "../../src/build-deps";
import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { osnLoggerLayer } from "../../src/observability";
import { createFakeNamespace, type FakeNamespace } from "../helpers/coordination-namespace";
import { createTestLayer } from "../helpers/db";

/**
 * `GET /health/coordination` through the composed app: a round trip on the
 * Durable Object store answers 200, a failing store answers 503, and the
 * per-IP limiter in front refuses before any store call.
 */

let env: EnvVars;
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");

beforeAll(async () => {
  const { privateKey, publicKey } = await generateArcKeyPair();
  env = {
    OSN_ENV: "local",
    OSN_JWT_PRIVATE_KEY: b64(await exportJWK(privateKey)),
    OSN_JWT_PUBLIC_KEY: b64(await exportJWK(publicKey)),
    TRUSTED_PROXY_COUNT: "1",
  };
});

interface Harness {
  readonly app: ReturnType<typeof createApp>;
  readonly fake: FakeNamespace;
  readonly onError: ReturnType<typeof vi.fn>;
}

async function harness(over: Partial<BuildParts> = {}): Promise<Harness> {
  const fake = createFakeNamespace();
  const onError = vi.fn();
  const built = await buildAppDeps(env, {
    coordination: () => createDurableCoordination(fake.ns, onError),
    dbAndEmailLayer: createTestLayer(),
    observabilityLayer: osnLoggerLayer,
    includeObservabilityPlugin: false,
    ...over,
  });
  return { app: createApp(built.deps), fake, onError };
}

const probe = (h: Harness, ip: string | null = "203.0.113.7") =>
  h.app.handle(
    new Request("http://localhost/health/coordination", {
      headers: ip === null ? {} : { "x-forwarded-for": ip },
    }),
  );

const probeCalls = (fake: FakeNamespace) =>
  fake.calls.filter((call) => call.store === "health_probe").map((call) => call.op);

describe("GET /health/coordination", () => {
  it("writes, reads back and removes a fresh key, and answers 200", async () => {
    const h = await harness();
    const res = await probe(h);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(probeCalls(h.fake)).toEqual(["write", "read", "remove"]);

    await probe(h);
    // A key of the server's own making each time: two probes, two objects.
    const objects = h.fake.names.filter((name) => name.startsWith("health_probe:"));
    expect(new Set(objects).size).toBe(2);
  });

  it("answers 503 when the store fails, and reports the store by name only", async () => {
    const h = await harness();
    h.fake.failWhen((call) => call.store === "health_probe");
    const res = await probe(h);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
    expect(h.onError).toHaveBeenCalledWith("health_probe", "write", expect.any(Object));
    for (const [store, op, detail] of h.onError.mock.calls) {
      expect([store, op]).not.toContain("203.0.113.7");
      expect(Object.keys(detail as object).toSorted()).toEqual(["durationMs", "retried"]);
    }
  });

  it("refuses the eleventh call in a minute from one IP without touching the store", async () => {
    const h = await harness();
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      expect((await probe(h)).status).toBe(200);
    }
    const before = probeCalls(h.fake).length;
    const res = await probe(h);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(probeCalls(h.fake).length).toBe(before);
    // Another IP has its own budget.
    expect((await probe(h, "203.0.113.8")).status).toBe(200);
  });

  it("refuses a caller whose IP cannot be resolved, without touching the store", async () => {
    const h = await harness();
    const res = await probe(h, null);
    expect(res.status).toBe(429);
    expect(probeCalls(h.fake)).toEqual([]);
  });

  it("runs the limiter on the native ten-a-minute tier, keyed by its own prefix", async () => {
    const keys: string[] = [];
    const refusing: WorkersRateLimitBinding = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: false };
      },
    };
    const h = await harness({ rateLimitBindings: { RL_AUTH_IP_10_60: refusing } });
    const res = await probe(h);
    expect(res.status).toBe(429);
    expect(keys).toEqual(["health.coordination:203.0.113.7"]);
    expect(probeCalls(h.fake)).toEqual([]);
  });
});

import { describe, expect, it } from "bun:test";

import { registryOutboundLimiters } from "../../src/lib/registry-limiters";
import type { RegistryLimiterBindings } from "../../src/lib/registry-limiters";
import { RateLimiterUnbound } from "../../src/middleware/rate-limit";
import { captureLogs } from "../test-helpers/capture-logs";

const BINDINGS = [
  ["REGISTRY_PREVIEW_RATE_LIMITER", "registryPreviewLimiter"],
  ["REGISTRY_IMAGE_RATE_LIMITER", "registryImageLimiter"],
  ["REGISTRY_THUMB_RATE_LIMITER", "registryThumbLimiter"],
] as const;

/** A native binding stand-in that records the keys it was asked about. */
function binding(success: boolean) {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success };
    },
  };
}

function allBound(): Required<RegistryLimiterBindings> {
  return {
    REGISTRY_PREVIEW_RATE_LIMITER: binding(true),
    REGISTRY_IMAGE_RATE_LIMITER: binding(true),
    REGISTRY_THUMB_RATE_LIMITER: binding(true),
  };
}

describe("registryOutboundLimiters", () => {
  for (const [name, option] of BINDINGS) {
    describe(name, () => {
      it("uses the native binding when it is present", async () => {
        const native = binding(false);
        const limiters = registryOutboundLimiters({ ...allBound(), [name]: native }, true);
        expect(await limiters[option]!.check("usr_a")).toBe(false);
        expect(native.keys).toEqual(["usr_a"]);
      });

      it("refuses and logs an error in a deployed tier when it is missing", async () => {
        const env: RegistryLimiterBindings = { ...allBound() };
        delete env[name];
        const limiters = registryOutboundLimiters(env, true);
        let thrown: unknown;
        const logs = await captureLogs(async () => {
          thrown = await Promise.resolve(limiters[option]!.check("usr_a")).catch((e) => e);
        });
        expect(thrown).toBeInstanceOf(RateLimiterUnbound);
        expect((thrown as RateLimiterUnbound).binding).toBe(name);
        expect(logs).toContain(`${name} binding missing in a deployed tier`);
      });

      it("leaves the in-memory default to createApp in the local tier", () => {
        const env: RegistryLimiterBindings = { ...allBound() };
        delete env[name];
        const limiters = registryOutboundLimiters(env, false);
        expect(limiters[option]).toBeUndefined();
      });
    });
  }

  it("refuses only the route whose binding is missing", async () => {
    const env: RegistryLimiterBindings = { ...allBound() };
    delete env.REGISTRY_THUMB_RATE_LIMITER;
    const limiters = registryOutboundLimiters(env, true);
    expect(await limiters.registryPreviewLimiter!.check("usr_a")).toBe(true);
    expect(await limiters.registryImageLimiter!.check("usr_a")).toBe(true);
  });
});

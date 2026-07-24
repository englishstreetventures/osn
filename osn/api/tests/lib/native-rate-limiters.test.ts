import {
  createRateLimiter,
  type RateLimiterBackend,
  type WorkersRateLimitBinding,
} from "@shared/rate-limit";
import { describe, it, expect } from "vitest";

import {
  HOUR_WINDOW_IP_AUTH_LIMITERS,
  NATIVE_BINDING_FOR_AUTH_LIMITER,
  readOsnRateLimitBindings,
  selectAuthRateLimiters,
} from "../../src/lib/native-rate-limiters";
import type { AuthRateLimiters } from "../../src/routes/auth";

/**
 * Build a fresh in-memory Redis-fallback bundle (same shape the real Redis
 * factory returns) so the selection logic can be exercised without a Redis
 * client. Every slot is a distinct backend instance so we can assert which one
 * the selector chose by identity / behaviour.
 */
function fallbackBundle(): AuthRateLimiters {
  const rl = () => createRateLimiter({ maxRequests: 999, windowMs: 60_000 });
  return Object.fromEntries(
    (
      [
        "registerBegin",
        "registerComplete",
        "handleCheck",
        "passkeyLoginBegin",
        "passkeyLoginComplete",
        "passkeyRegisterBegin",
        "passkeyRegisterComplete",
        "profileSwitch",
        "profileList",
        "recoveryGenerate",
        "recoveryComplete",
        "stepUpPasskeyBegin",
        "stepUpPasskeyComplete",
        "stepUpOtpBegin",
        "stepUpOtpComplete",
        "sessionList",
        "sessionRevoke",
        "emailChangeBegin",
        "emailChangeComplete",
        "securityEventList",
        "securityEventAck",
        "passkeyList",
        "passkeyRename",
        "passkeyDelete",
        "crossDeviceBegin",
        "crossDevicePoll",
        "crossDeviceApprove",
        "crossDeviceReject",
        "oidcAuthorize",
        "oidcAuthorizeContext",
        "oidcAuthorizeDecision",
        "oidcToken",
        "oidcConnectionsList",
        "oidcConnectionsRevoke",
        "oidcClientCreate",
        "oidcClientList",
        "oidcClientDisable",
      ] as const
    ).map((k) => [k, rl()]),
  ) as unknown as AuthRateLimiters;
}

/** An always-allowing native binding stub. */
const mkBinding = (): WorkersRateLimitBinding => ({ limit: async () => ({ success: true }) });

/** A stub native binding that records every key it was asked to limit. */
function recordingBinding(success = true): {
  binding: WorkersRateLimitBinding;
  keys: string[];
} {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      limit: async ({ key }) => {
        keys.push(key);
        return { success };
      },
    },
  };
}

describe("readOsnRateLimitBindings", () => {
  it("returns undefined when no native binding is present (local / Bun path)", () => {
    expect(readOsnRateLimitBindings({})).toBeUndefined();
  });

  it("collects the present native bindings off the env record", () => {
    const b = recordingBinding().binding;
    const bindings = readOsnRateLimitBindings({ RL_AUTH_IP_10_60: b });
    expect(bindings).toBeDefined();
    expect(bindings?.RL_AUTH_IP_10_60).toBe(b);
  });
});

describe("selectAuthRateLimiters — limiter routing", () => {
  it("routes every 60s per-IP auth limiter onto a native binding", async () => {
    const tiers = {
      RL_AUTH_IP_5_60: recordingBinding(),
      RL_AUTH_IP_10_60: recordingBinding(),
      RL_AUTH_IP_20_60: recordingBinding(),
      RL_AUTH_IP_30_60: recordingBinding(),
      RL_AUTH_IP_60_60: recordingBinding(),
    };
    const bindings = {
      RL_AUTH_IP_5_60: tiers.RL_AUTH_IP_5_60.binding,
      RL_AUTH_IP_10_60: tiers.RL_AUTH_IP_10_60.binding,
      RL_AUTH_IP_20_60: tiers.RL_AUTH_IP_20_60.binding,
      RL_AUTH_IP_30_60: tiers.RL_AUTH_IP_30_60.binding,
      RL_AUTH_IP_60_60: tiers.RL_AUTH_IP_60_60.binding,
    };
    const fallback = fallbackBundle();
    const selected = selectAuthRateLimiters(bindings, fallback);

    // Drive every 60s endpoint; each must hit a native binding (not the fallback).
    const sixtySecondKeys = (Object.keys(selected) as (keyof AuthRateLimiters)[]).filter(
      (key) => !HOUR_WINDOW_IP_AUTH_LIMITERS.has(key),
    );
    await Promise.all(sixtySecondKeys.map((key) => selected[key].check("1.2.3.4")));

    const totalNativeCalls = Object.values(tiers).reduce((n, t) => n + t.keys.length, 0);
    const sixtySecondCount = Object.keys(selected).length - HOUR_WINDOW_IP_AUTH_LIMITERS.size;
    expect(totalNativeCalls).toBe(sixtySecondCount);
  });

  it("keeps the 1-hour per-IP limiters on the Redis fallback (NOT native)", async () => {
    const tiers = {
      RL_AUTH_IP_5_60: recordingBinding(),
      RL_AUTH_IP_10_60: recordingBinding(),
      RL_AUTH_IP_20_60: recordingBinding(),
      RL_AUTH_IP_30_60: recordingBinding(),
      RL_AUTH_IP_60_60: recordingBinding(),
    };
    const bindings = {
      RL_AUTH_IP_5_60: tiers.RL_AUTH_IP_5_60.binding,
      RL_AUTH_IP_10_60: tiers.RL_AUTH_IP_10_60.binding,
      RL_AUTH_IP_20_60: tiers.RL_AUTH_IP_20_60.binding,
      RL_AUTH_IP_30_60: tiers.RL_AUTH_IP_30_60.binding,
      RL_AUTH_IP_60_60: tiers.RL_AUTH_IP_60_60.binding,
    };
    const fallback = fallbackBundle();
    const selected = selectAuthRateLimiters(bindings, fallback);

    // The 1-hour slots are returned UNCHANGED (same object identity as fallback).
    for (const key of HOUR_WINDOW_IP_AUTH_LIMITERS) {
      expect(selected[key]).toBe(fallback[key]);
    }
    // Sanity: the set is exactly the four 1-hour windows.
    expect([...HOUR_WINDOW_IP_AUTH_LIMITERS].toSorted((a, b) => a.localeCompare(b))).toEqual([
      "emailChangeBegin",
      "oidcClientCreate",
      "recoveryComplete",
      "recoveryGenerate",
    ]);
  });

  it("namespaces native keys per endpoint so distinct endpoints never share a bucket", async () => {
    const rec = recordingBinding();
    // Two endpoints that share the 10-req tier must produce DISTINCT keys.
    const bindings = {
      RL_AUTH_IP_5_60: recordingBinding().binding,
      RL_AUTH_IP_10_60: rec.binding,
      RL_AUTH_IP_20_60: recordingBinding().binding,
      RL_AUTH_IP_30_60: recordingBinding().binding,
      RL_AUTH_IP_60_60: recordingBinding().binding,
    };
    const selected = selectAuthRateLimiters(bindings, fallbackBundle());
    await selected.registerComplete.check("9.9.9.9");
    await selected.passkeyRegisterBegin.check("9.9.9.9");
    expect(rec.keys).toContain(`${NATIVE_BINDING_FOR_AUTH_LIMITER.registerComplete.ns}:9.9.9.9`);
    expect(rec.keys).toContain(
      `${NATIVE_BINDING_FOR_AUTH_LIMITER.passkeyRegisterBegin.ns}:9.9.9.9`,
    );
    expect(rec.keys[0]).not.toBe(rec.keys[1]);
  });

  it("preserves fail-closed — a throwing native binding denies", async () => {
    const throwing: WorkersRateLimitBinding = {
      limit: async () => {
        throw new Error("platform error");
      },
    };
    const bindings = {
      RL_AUTH_IP_5_60: throwing,
      RL_AUTH_IP_10_60: throwing,
      RL_AUTH_IP_20_60: throwing,
      RL_AUTH_IP_30_60: throwing,
      RL_AUTH_IP_60_60: throwing,
    };
    const selected = selectAuthRateLimiters(bindings, fallbackBundle());
    expect(await selected.registerBegin.check("1.2.3.4")).toBe(false);
  });

  it("every selected slot still satisfies the RateLimiterBackend contract", () => {
    const bindings = {
      RL_AUTH_IP_5_60: mkBinding(),
      RL_AUTH_IP_10_60: mkBinding(),
      RL_AUTH_IP_20_60: mkBinding(),
      RL_AUTH_IP_30_60: mkBinding(),
      RL_AUTH_IP_60_60: mkBinding(),
    };
    const selected = selectAuthRateLimiters(bindings, fallbackBundle());
    for (const [, backend] of Object.entries(selected)) {
      expect(typeof (backend as RateLimiterBackend).check).toBe("function");
    }
  });
});

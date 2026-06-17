import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetOutboundKeyForTests, registerOutboundKeysOnce } from "../../src/lib/outbound-arc";

/**
 * T-R2 — Workers `scheduled`-path outbound ARC key registration.
 *
 * Pulse + Zap verify osn's inbound ARC tokens against a PRE-REGISTERED public
 * key (kid → registered key), so the Workers deletion fan-out MUST publish
 * osn's outbound key to each downstream's `/internal/register-service` before
 * it POSTs `/internal/account-deleted`. The Bun path does this at boot via
 * `startOutboundKeyRotation`; on workerd `registerOutboundKeysOnce` does it,
 * once per isolate, from the cron `scheduled` handler.
 *
 * These tests assert: a successful pass POSTs to every configured downstream
 * and is then a no-op on later ticks (once-per-isolate), the upsert is
 * idempotent downstream, a partial failure does NOT latch (so the next tick
 * retries), and a no-downstream config is a clean no-op.
 */

const OK = (): Response => new Response(JSON.stringify({ ok: true }), { status: 200 });

const registerUrls = (res: string[]): string[] =>
  res
    .map((u) => new URL(u))
    .filter((u) => u.pathname === "/internal/register-service")
    .map((u) => `${u.protocol}//${u.host}`);

describe("registerOutboundKeysOnce (Workers scheduled path) — T-R2", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const calledUrls = (): string[] =>
    registerUrls(
      fetchSpy.mock.calls.map((c: Parameters<typeof fetch>) => {
        const input = c[0];
        return typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      }),
    );

  const baseOpts = {
    pulseApiUrl: "https://pulse.test",
    zapApiUrl: "https://zap.test",
    internalServiceSecret: "s3cr3t",
    osnEnv: "production",
  };

  beforeEach(() => {
    _resetOutboundKeyForTests();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(OK());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    _resetOutboundKeyForTests();
  });

  it("registers osn's outbound key with every configured downstream on the first pass", async () => {
    const result = await registerOutboundKeysOnce(baseOpts);

    expect(result).toBe(true);
    const urls = calledUrls();
    expect(urls).toContain("https://pulse.test");
    expect(urls).toContain("https://zap.test");
    expect(urls).toHaveLength(2);

    // The registration POST carries the shared INTERNAL_SERVICE_SECRET as a
    // Bearer token (NOT an ARC token) — that is how the downstream gates the
    // register-service endpoint.
    const firstInit = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = new Headers(firstInit.headers);
    expect(headers.get("authorization")).toBe("Bearer s3cr3t");
    expect(firstInit.method).toBe("POST");
  });

  it("is a once-per-isolate no-op on subsequent ticks (idempotent + no re-POST)", async () => {
    await registerOutboundKeysOnce(baseOpts);
    expect(calledUrls()).toHaveLength(2);

    // Two more cron ticks within the same isolate — must NOT re-POST.
    const second = await registerOutboundKeysOnce(baseOpts);
    const third = await registerOutboundKeysOnce(baseOpts);

    expect(second).toBe(true);
    expect(third).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // still just the first pass
  });

  it("does NOT latch on a partial failure, so the next tick retries", async () => {
    // First downstream (pulse) rejects; `registerWithDownstream` throws on a
    // non-2xx, which propagates out of `registerOutboundKeysOnce`.
    fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 500 }));

    await expect(registerOutboundKeysOnce(baseOpts)).rejects.toThrow();

    // Latch stayed false → a later tick re-attempts and can succeed.
    fetchSpy.mockResolvedValue(OK());
    const retry = await registerOutboundKeysOnce(baseOpts);
    expect(retry).toBe(true);
    expect(calledUrls()).toContain("https://pulse.test");
    expect(calledUrls()).toContain("https://zap.test");
  });

  it("is a clean no-op (returns false, no fetch) when no downstream URLs are configured", async () => {
    const result = await registerOutboundKeysOnce({
      internalServiceSecret: "s3cr3t",
      osnEnv: "production",
    });

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

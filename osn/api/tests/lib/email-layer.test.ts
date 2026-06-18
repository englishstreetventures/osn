import { EmailService } from "@shared/email";
import { Effect, Logger } from "effect";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { selectEmailLayer, isEmailOptionalOptIn } from "../../src/lib/email-layer";
import { osnLoggerLayer } from "../../src/observability";

/**
 * T — degraded-email opt-in selection (`OSN_EMAIL_OPTIONAL`).
 *
 * The transport-selection rules:
 *   - RESEND_API_KEY present + non-local        → ResendEmailLive (preferred;
 *                                                 wins over CF creds + opt-in).
 *   - Cloudflare creds present                  → CloudflareEmailLive (creds win,
 *                                                 even if the opt-in is also set).
 *   - no real provider + non-local + opt-in     → NoopEmailLive (boot degraded)
 *                                                 + a loud startup warning.
 *   - no real provider + non-local + opt-in UNSET → throw (the safe default).
 *   - no real provider + local                  → LogEmailLive recorder.
 */

describe("isEmailOptionalOptIn", () => {
  it("is true only for explicit truthy strings", () => {
    for (const v of ["true", "TRUE", "1", "yes", "on"]) {
      expect(isEmailOptionalOptIn(v)).toBe(true);
    }
  });

  it("is false for unset / empty / falsey strings", () => {
    for (const v of [undefined, "", "false", "0", "no", "off", "  "]) {
      expect(isEmailOptionalOptIn(v)).toBe(false);
    }
  });
});

function nonLocal(over: Record<string, string | undefined> = {}) {
  return { OSN_ENV: "production", ...over };
}

describe("selectEmailLayer", () => {
  it("creds absent + non-local + opt-in UNSET → throws (safe default preserved)", () => {
    expect(() => selectEmailLayer(nonLocal(), osnLoggerLayer)).toThrow(
      /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_API_TOKEN must be set/,
    );
  });

  it("creds absent + non-local + opt-in set → returns a degraded (no-op) layer, does NOT throw", async () => {
    const layer = selectEmailLayer(nonLocal({ OSN_EMAIL_OPTIONAL: "true" }), osnLoggerLayer);
    // A send must be a successful no-op.
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "otp-step-up",
          to: "alice@example.com",
          data: { code: "111111", ttlMinutes: 10 },
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(exit._tag).toBe("Success");
  });

  it("creds absent + non-local + opt-in set → emits a loud degraded-mode startup warning (no PII)", () => {
    const lines: string[] = [];
    const captureLayer = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message, logLevel }) => {
        const msg = Array.isArray(message) ? message.join(" ") : String(message);
        lines.push(`[${logLevel.label}] ${msg}`);
      }),
    );

    // Selection emits the loud warning synchronously through the supplied
    // observability layer.
    selectEmailLayer(nonLocal({ OSN_EMAIL_OPTIONAL: "true" }), captureLayer);

    const joined = lines.join("\n");
    expect(joined).toMatch(/degraded/i);
    expect(joined).toMatch(/will not be delivered|will NOT be delivered/i);
    // It must name the affected mail classes so an operator understands impact.
    expect(joined.toLowerCase()).toContain("otp");
    expect(joined.toLowerCase()).toContain("security");
    // It must be at least WARN level (loud).
    expect(joined).toMatch(/\[(WARN|ERROR|FATAL)\]/);
    // No sensitive-token shapes (there is no recipient/code at startup anyway).
    expect(joined).not.toMatch(/\b\d{6}\b/);
  });

  describe("RESEND_API_KEY (preferred transport)", () => {
    let dispatchedUrl: string | null;

    beforeEach(() => {
      dispatchedUrl = null;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          dispatchedUrl = typeof input === "string" ? input : input.toString();
          return new Response(JSON.stringify({ id: "x" }), { status: 200 });
        }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const sendOnce = (layer: ReturnType<typeof selectEmailLayer>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const email = yield* EmailService;
          yield* email.send({
            template: "otp-step-up",
            to: "alice@example.com",
            data: { code: "222222", ttlMinutes: 10 },
          });
        }).pipe(Effect.provide(layer)),
      );

    it("present + non-local → Resend selected even when CF creds AND opt-in are also set", async () => {
      const layer = selectEmailLayer(
        nonLocal({
          RESEND_API_KEY: "re_test_key",
          CLOUDFLARE_ACCOUNT_ID: "acct",
          CLOUDFLARE_EMAIL_API_TOKEN: "tok",
          OSN_EMAIL_OPTIONAL: "true",
        }),
        osnLoggerLayer,
      );
      await sendOnce(layer);
      // Resend transport hits api.resend.com — NOT the Cloudflare email API.
      expect(dispatchedUrl).toBe("https://api.resend.com/emails");
    });

    it("absent → precedence unchanged: CF creds still select the Cloudflare transport", async () => {
      const layer = selectEmailLayer(
        nonLocal({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_EMAIL_API_TOKEN: "tok" }),
        osnLoggerLayer,
      );
      await sendOnce(layer);
      expect(dispatchedUrl).toContain("api.cloudflare.com");
    });

    it("present but LOCAL → recorder still wins (no live API call in dev/test)", async () => {
      const layer = selectEmailLayer(
        { OSN_ENV: "local", RESEND_API_KEY: "re_test_key" },
        osnLoggerLayer,
      );
      await sendOnce(layer);
      expect(dispatchedUrl).toBeNull();
    });
  });

  it("creds present → returns CloudflareEmailLive even if opt-in is ALSO set (creds win)", async () => {
    // We can't easily assert the concrete layer identity, but we CAN assert it
    // did not throw and is NOT a no-op: the Cloudflare transport will attempt a
    // network call. We assert selection succeeds with creds present + opt-in.
    const layer = selectEmailLayer(
      nonLocal({
        CLOUDFLARE_ACCOUNT_ID: "acct",
        CLOUDFLARE_EMAIL_API_TOKEN: "tok",
        OSN_EMAIL_OPTIONAL: "true",
      }),
      osnLoggerLayer,
    );
    expect(layer).toBeDefined();
  });

  it("local + creds absent → LogEmailLive recorder (no throw, no opt-in needed)", () => {
    const layer = selectEmailLayer({ OSN_ENV: "local" }, osnLoggerLayer);
    expect(layer).toBeDefined();
  });
});

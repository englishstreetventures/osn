import { Effect, Logger, LogLevel } from "effect";
import { describe, it, expect } from "vitest";

import { makeNoopEmailLive } from "../src/noop";
import { EmailError, EmailService } from "../src/service";

/**
 * `NoopEmailLive` — degraded-mode production transport.
 *
 * Unlike `LogEmailLive` it must NOT accumulate sent emails (that recorder grows
 * unbounded), and unlike `CloudflareEmailLive` it must not open any network
 * connection. A send is a successful no-op that drops the message and emits a
 * single redacted log line that leaks NEITHER the recipient address NOR the OTP
 * code.
 */
describe("NoopEmailLive", () => {
  /** Capture the structured log output so we can assert on what was emitted. */
  function captureLogs() {
    const lines: string[] = [];
    const layer = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message, annotations }) => {
        const msg = Array.isArray(message) ? message.join(" ") : String(message);
        const annoParts: string[] = [];
        for (const [k, v] of annotations) annoParts.push(`${k}=${String(v)}`);
        lines.push(`${msg} ${annoParts.join(" ")}`);
      }),
    );
    return { lines, layer };
  }

  it("send is a successful no-op (no error, nothing accumulated)", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "otp-step-up",
          to: "alice@example.com",
          data: { code: "424242", ttlMinutes: 10 },
        });
      }).pipe(Effect.provide(makeNoopEmailLive())),
    );
    expect(exit._tag).toBe("Success");
  });

  it("emits a redacted warning line that leaks NEITHER recipient NOR OTP code", async () => {
    const { lines, layer } = captureLogs();

    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "otp-email-change",
          to: "victim@secret-domain.example",
          data: { code: "987654", ttlMinutes: 15 },
        });
      }).pipe(
        Effect.provide(makeNoopEmailLive()),
        Effect.provide(layer),
        Logger.withMinimumLogLevel(LogLevel.All),
      ),
    );

    const joined = lines.join("\n");
    // The degraded-mode marker + the (non-sensitive) template literal ARE logged.
    expect(joined).toContain("email suppressed (degraded mode)");
    expect(joined).toContain("otp-email-change");
    // The recipient address and the OTP code MUST NOT appear anywhere.
    expect(joined).not.toContain("victim@secret-domain.example");
    expect(joined).not.toContain("987654");
    // Defence in depth: no raw "@" recipient and no 6-digit code pattern.
    expect(joined).not.toMatch(/@secret-domain/);
    expect(joined).not.toMatch(/\b\d{6}\b/);
  });

  it("still surfaces render_failed so template bugs are not masked in degraded mode", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "otp-registration",
          to: "alice@example.com",
          data: { code: null as unknown as string, ttlMinutes: 10 },
        });
      }).pipe(Effect.provide(makeNoopEmailLive())),
    );
    expect(exit._tag).toBe("Failure");
    const error = (exit as { cause: { _tag: string; error: EmailError } }).cause.error;
    expect(error).toBeInstanceOf(EmailError);
    expect(error.reason).toBe("render_failed");
  });
});

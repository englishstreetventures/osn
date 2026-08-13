import { Effect, Logger, LogLevel } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * T-U3 / S-L4. `logDevOtp` is the one place an OTP code is deliberately written
 * to a log, and until this file it had no test at all — so the security fix
 * that removed the recipient address from the line had no regression barrier.
 *
 * Two properties are pinned, and both matter for a different reason:
 *
 *  1. **No PII in the message.** The line is free text, and
 *     `@shared/observability`'s redaction deny-list is keyed on annotation
 *     KEYS — it cannot see inside a formatted message. So the assertion is not
 *     "the `to` parameter is gone" (a refactor could reintroduce the address by
 *     another route) but "no address-shaped text appears at all".
 *  2. **The env gate holds.** It is the only thing between an OTP code and a
 *     deployed log sink.
 *
 * `isLocalEnvCached` memoises the env read for the module's lifetime, so each
 * case re-imports the module under `vi.resetModules()` rather than trying to
 * flip the gate in place.
 */

const EMAIL = "guest@example.com";

/** Import a fresh copy of the module so the memoised env read is re-evaluated. */
async function freshLogDevOtp(osnEnv: string | undefined) {
  vi.resetModules();
  if (osnEnv === undefined) delete process.env.OSN_ENV;
  else process.env.OSN_ENV = osnEnv;
  const mod = await import("../../../src/services/auth/helpers");
  return mod.logDevOtp;
}

/** Run an effect capturing every log message it emits, at debug level. */
async function capture(effect: Effect.Effect<void>): Promise<string[]> {
  const lines: string[] = [];
  await Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Logger.replace(
          Logger.defaultLogger,
          Logger.make(({ message }) => {
            lines.push(String(message));
          }),
        ),
      ),
      Logger.withMinimumLogLevel(LogLevel.Debug),
    ),
  );
  return lines;
}

describe("logDevOtp", () => {
  const originalEnv = process.env.OSN_ENV;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OSN_ENV;
    else process.env.OSN_ENV = originalEnv;
    vi.resetModules();
  });

  it("logs the purpose and code locally", async () => {
    const logDevOtp = await freshLogDevOtp("local");
    const lines = await capture(logDevOtp("registration", "123456"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("registration");
    expect(lines[0]).toContain("code=123456");
  });

  // The actual S-L4 assertion. Deliberately shape-based, not parameter-based:
  // it fails on ANY reintroduced address, however it gets there.
  it("never emits the recipient address", async () => {
    const logDevOtp = await freshLogDevOtp("local");
    const lines = await capture(logDevOtp("email-change", "654321"));
    expect(lines[0]).not.toContain(EMAIL);
    expect(lines[0]).not.toContain("@");
    expect(lines[0]).not.toMatch(/to=/);
  });

  it("takes no recipient argument at all", async () => {
    // The parameter is gone from the signature, so a call site cannot pass one
    // back in by habit — the type error is the first line of defence.
    const { logDevOtp } = await import("../../../src/services/auth/helpers");
    expect(logDevOtp.length).toBe(2);
  });

  it.each(["staging", "production"])("emits nothing when OSN_ENV is %s", async (env) => {
    const logDevOtp = await freshLogDevOtp(env);
    const lines = await capture(logDevOtp("step-up", "999999"));
    expect(lines).toEqual([]);
  });

  // "Unset ⇒ local" is the codebase-wide convention (`isNonLocal` in index.ts);
  // pinned so a future change to that default is a deliberate one.
  it("treats an unset OSN_ENV as local", async () => {
    const logDevOtp = await freshLogDevOtp(undefined);
    const lines = await capture(logDevOtp("registration", "111111"));
    expect(lines).toHaveLength(1);
  });

  // The Workers entry stamps the tier from the request-scoped binding, because
  // `process.env` on workerd is a shim that can read empty — and "unset ⇒
  // local" then puts a live OTP code in the log sink. Once stamped, the
  // binding wins over `process.env` in both directions.
  it.each(["dev", "staging", "production"])(
    "emits nothing when the stamped tier is %s, whatever process.env says",
    async (tier) => {
      vi.resetModules();
      delete process.env.OSN_ENV;
      const mod = await import("../../../src/services/auth/helpers");
      mod.setRuntimeTier(tier);
      const lines = await capture(mod.logDevOtp("step-up", "999999"));
      expect(lines).toEqual([]);
    },
  );

  // A deployed Worker with no OSN_ENV var must NOT fall back to `process.env`
  // — that is the same fail-open by a longer route. Absent normalises to
  // "unknown", which is not local.
  it("emits nothing when the binding is absent", async () => {
    vi.resetModules();
    delete process.env.OSN_ENV;
    const mod = await import("../../../src/services/auth/helpers");
    mod.setRuntimeTier(undefined);
    const lines = await capture(mod.logDevOtp("registration", "222222"));
    expect(lines).toEqual([]);
  });

  it("still logs when the stamped tier is local", async () => {
    vi.resetModules();
    process.env.OSN_ENV = "production";
    const mod = await import("../../../src/services/auth/helpers");
    mod.setRuntimeTier("local");
    const lines = await capture(mod.logDevOtp("registration", "333333"));
    expect(lines).toHaveLength(1);
  });
});

import { Effect, Logger, References } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mailboxKey } from "../../../src/services/auth/helpers";

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
        Logger.layer([
          Logger.make(({ message }) => {
            lines.push(String(message));
          }),
        ]),
      ),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
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

describe("logDevLink", () => {
  const originalEnv = process.env.OSN_ENV;
  const URL_WITH_SECRET = "https://musubi.example/verify/signup_abc#secret-value";

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OSN_ENV;
    else process.env.OSN_ENV = originalEnv;
    vi.resetModules();
  });

  async function freshLogDevLink(osnEnv: string) {
    vi.resetModules();
    process.env.OSN_ENV = osnEnv;
    const mod = await import("../../../src/services/auth/helpers");
    return mod.logDevLink;
  }

  it("logs the purpose and the whole link locally", async () => {
    const logDevLink = await freshLogDevLink("local");
    const lines = await capture(logDevLink("registration", URL_WITH_SECRET));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("registration");
    expect(lines[0]).toContain(URL_WITH_SECRET);
  });

  it.each(["dev", "staging", "production"])("emits nothing when OSN_ENV is %s", async (env) => {
    const logDevLink = await freshLogDevLink(env);
    const lines = await capture(logDevLink("registration", URL_WITH_SECRET));
    expect(lines).toEqual([]);
  });

  it.each(["dev", "staging", "production"])(
    "emits nothing when the stamped tier is %s, whatever process.env says",
    async (tier) => {
      vi.resetModules();
      process.env.OSN_ENV = "local";
      const mod = await import("../../../src/services/auth/helpers");
      mod.setRuntimeTier(tier);
      const lines = await capture(mod.logDevLink("registration", URL_WITH_SECRET));
      expect(lines).toEqual([]);
    },
  );
});

// The sign-up strike counter and the Resend cap key on this, so every address
// that reaches one mailbox at a provider that delivers every variant to it
// shares one count, and every other address keeps its own.
describe("mailboxKey", () => {
  it.each([
    ["drops dots on gmail.com", "n.a.me@gmail.com", "name@gmail.com"],
    ["drops dots and the +tag on gmail.com", "n.ame+x@gmail.com", "name@gmail.com"],
    ["drops a +tag that holds a dot on gmail.com", "name+a.b@gmail.com", "name@gmail.com"],
    ["reads googlemail.com as gmail.com", "n.ame+x@googlemail.com", "name@gmail.com"],
    ["lowercases a Gmail address before folding it", "N.Ame+Tag@GMail.com", "name@gmail.com"],
    ["keeps the dots of an Outlook address", "first.last@outlook.com", "first.last@outlook.com"],
    ["keeps the address as typed on any other domain", "a+x@custom.example", "a+x@custom.example"],
    ["keeps the dots on any other domain", "first.last@example.com", "first.last@example.com"],
    ["lowercases any other address", "Name+Tag@Example.COM", "name+tag@example.com"],
    ["leaves an address with no + alone", "plain@outlook.com", "plain@outlook.com"],
    ["keeps a local part that starts with +", "+x@outlook.com", "+x@outlook.com"],
  ])("%s", (_, address, folded) => {
    expect(mailboxKey(address)).toBe(folded);
  });

  it.each([
    "outlook.com",
    "hotmail.com",
    "live.com",
    "fastmail.com",
    "icloud.com",
    "proton.me",
    "protonmail.com",
  ])("drops a +tag on %s and keeps the dots", (domain) => {
    expect(mailboxKey(`a.b+x@${domain}`)).toBe(`a.b@${domain}`);
    expect(mailboxKey(`a.b+x@${domain}`)).not.toBe(mailboxKey(`ab@${domain}`));
  });

  it("gives every address that reaches one Gmail mailbox one key", () => {
    const keys = new Set(
      ["x@gmail.com", "x+a@gmail.com", "x+b@gmail.com", "X@googlemail.com", "x.+c@GMAIL.com"].map(
        mailboxKey,
      ),
    );
    expect([...keys]).toEqual(["x@gmail.com"]);
  });

  it("gives a +tag address and its base one key at a listed provider", () => {
    expect(mailboxKey("a+x@gmail.com")).toBe(mailboxKey("a@gmail.com"));
    expect(mailboxKey("a+x@outlook.com")).toBe(mailboxKey("a@outlook.com"));
  });

  it("gives two +tag addresses on any other domain two keys", () => {
    expect(mailboxKey("a+x@custom.example")).not.toBe(mailboxKey("a+y@custom.example"));
    expect(mailboxKey("a+x@custom.example")).not.toBe(mailboxKey("a@custom.example"));
  });

  it("returns a value with no @, such as a probe key, as given", () => {
    expect(mailboxKey("prb_0123456789ab")).toBe("prb_0123456789ab");
  });
});

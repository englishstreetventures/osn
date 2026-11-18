import { Effect, Logger, References } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mailboxKey } from "../../../src/services/auth/helpers";

/**
 * `logDevLink` is the one place an emailed link's secret is deliberately
 * written to a log.
 *
 * Two properties are pinned, and both matter for a different reason:
 *
 *  1. **No PII in the message.** The line is free text, and
 *     `@shared/observability`'s redaction deny-list is keyed on annotation
 *     KEYS — it cannot see inside a formatted message. So the assertion is not
 *     "the `to` parameter is gone" (a refactor could reintroduce the address by
 *     another route) but "no address-shaped text appears at all".
 *  2. **The env gate holds.** It is the only thing between a link's secret and
 *     a deployed log sink.
 *
 * `isLocalEnvCached` memoises the env read for the module's lifetime, so each
 * case re-imports the module under `vi.resetModules()` rather than trying to
 * flip the gate in place.
 */

const EMAIL = "guest@example.com";
const LINK = "https://musubi.example/verify/stepup_0123456789ab#";

/** Import a fresh copy of the module so the memoised env read is re-evaluated. */
async function freshLogDevLink(osnEnv: string | undefined) {
  vi.resetModules();
  if (osnEnv === undefined) delete process.env.OSN_ENV;
  else process.env.OSN_ENV = osnEnv;
  const mod = await import("../../../src/services/auth/helpers");
  return mod.logDevLink;
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

describe("logDevLink", () => {
  const originalEnv = process.env.OSN_ENV;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OSN_ENV;
    else process.env.OSN_ENV = originalEnv;
    vi.resetModules();
  });

  it("logs the purpose and link locally", async () => {
    const logDevLink = await freshLogDevLink("local");
    const lines = await capture(logDevLink("registration", `${LINK}123456`));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("registration");
    expect(lines[0]).toContain(`${LINK}123456`);
  });

  // The actual S-L4 assertion. Deliberately shape-based, not parameter-based:
  // it fails on ANY reintroduced address, however it gets there.
  it("never emits the recipient address", async () => {
    const logDevLink = await freshLogDevLink("local");
    const lines = await capture(logDevLink("email-change", `${LINK}654321`));
    expect(lines[0]).not.toContain(EMAIL);
    expect(lines[0]).not.toContain("@");
    expect(lines[0]).not.toMatch(/to=/);
  });

  it.each(["staging", "production"])("emits nothing when OSN_ENV is %s", async (env) => {
    const logDevLink = await freshLogDevLink(env);
    const lines = await capture(logDevLink("step-up", `${LINK}999999`));
    expect(lines).toEqual([]);
  });

  // "Unset ⇒ local" is the codebase-wide convention (`isNonLocal` in index.ts);
  // pinned so a future change to that default is a deliberate one.
  it("treats an unset OSN_ENV as local", async () => {
    const logDevLink = await freshLogDevLink(undefined);
    const lines = await capture(logDevLink("registration", `${LINK}111111`));
    expect(lines).toHaveLength(1);
  });

  // The Workers entry stamps the tier from the request-scoped binding, because
  // `process.env` on workerd is a shim that can read empty — and "unset ⇒
  // local" then puts a live link secret in the log sink. Once stamped, the
  // binding wins over `process.env` in both directions.
  it.each(["dev", "staging", "production"])(
    "emits nothing when the stamped tier is %s, whatever process.env says",
    async (tier) => {
      vi.resetModules();
      delete process.env.OSN_ENV;
      const mod = await import("../../../src/services/auth/helpers");
      mod.setRuntimeTier(tier);
      const lines = await capture(mod.logDevLink("step-up", `${LINK}999999`));
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
    const lines = await capture(mod.logDevLink("registration", `${LINK}222222`));
    expect(lines).toEqual([]);
  });

  it("still logs when the stamped tier is local", async () => {
    vi.resetModules();
    process.env.OSN_ENV = "production";
    const mod = await import("../../../src/services/auth/helpers");
    mod.setRuntimeTier("local");
    const lines = await capture(mod.logDevLink("registration", `${LINK}333333`));
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

// The sign-up Resend cap keys on this: every +tag variant of a local part
// shares one count on any domain, Gmail's dotted forms share one too, and a
// different local part never does.
describe("mailboxKey", () => {
  it.each([
    ["drops a +tag on any domain", "a+x@custom.example", "a@custom.example"],
    ["drops a +tag that holds a dot", "name+a.b@example.com", "name@example.com"],
    ["drops dots on gmail.com", "n.a.me@gmail.com", "name@gmail.com"],
    ["drops dots and the +tag on gmail.com", "n.ame+x@gmail.com", "name@gmail.com"],
    ["reads googlemail.com as gmail.com", "n.ame+x@googlemail.com", "name@gmail.com"],
    ["lowercases a Gmail address before folding it", "N.Ame+Tag@GMail.com", "name@gmail.com"],
    ["keeps the dots of an Outlook address", "first.last@outlook.com", "first.last@outlook.com"],
    ["keeps the dots on any other domain", "first.last@example.com", "first.last@example.com"],
    ["lowercases", "Name+Tag@Example.COM", "name@example.com"],
    ["leaves an address with no + alone", "plain@example.com", "plain@example.com"],
    ["keeps a local part that starts with +", "+x@example.com", "+x@example.com"],
  ])("%s", (_, address, folded) => {
    expect(mailboxKey(address)).toBe(folded);
  });

  it("gives every address that reaches one Gmail mailbox one key", () => {
    const keys = new Set(
      ["x@gmail.com", "x+a@gmail.com", "x+b@gmail.com", "X@googlemail.com", "x.+c@GMAIL.com"].map(
        mailboxKey,
      ),
    );
    expect([...keys]).toEqual(["x@gmail.com"]);
    expect(mailboxKey("a.b@gmail.com")).toBe(mailboxKey("ab+z@googlemail.com"));
    expect(mailboxKey("a.b@gmail.com")).toBe(mailboxKey("ab@gmail.com"));
  });

  it("gives every +tag variant of a local part one key on any domain", () => {
    expect(mailboxKey("a+x@custom.example")).toBe(mailboxKey("a+y@custom.example"));
    expect(mailboxKey("a+x@custom.example")).toBe(mailboxKey("a@custom.example"));
    expect(mailboxKey("a+x@outlook.com")).toBe(mailboxKey("a@outlook.com"));
  });

  it("never gives a different local part the same key", () => {
    expect(mailboxKey("a@custom.example")).not.toBe(mailboxKey("b@custom.example"));
    expect(mailboxKey("a.b@outlook.com")).not.toBe(mailboxKey("ab@outlook.com"));
    expect(mailboxKey("a@custom.example")).not.toBe(mailboxKey("a@other.example"));
  });

  it("returns a value with no @, such as a probe key, as given", () => {
    expect(mailboxKey("prb_0123456789ab")).toBe("prb_0123456789ab");
  });
});

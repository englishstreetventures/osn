import { Redacted } from "effect";
import { describe, expect, test } from "vitest";

import { tierSecrets, type WorkerKey } from "../../src/secrets/inventory";
import {
  MissingSecretsError,
  requireSecrets,
  requireSeedValue,
  SeedValueError,
} from "../../src/secrets/require";
import type { Tier } from "../../src/stage";

/** Values that meet the dev tier's rules, for the names it sets one for. */
const RULE_ABIDING: Readonly<Record<string, string>> = {
  STRIPE_SECRET_KEY: "sk_test_value-of-STRIPE_SECRET_KEY",
  DEV_LOGIN_SECRET: "value-of-DEV_LOGIN_SECRET-32-characters-or-more",
};

const envFor = (worker: WorkerKey, tier: Tier): Record<string, string> =>
  Object.fromEntries(
    tierSecrets(worker, tier).secrets.map((name) => [
      name,
      RULE_ABIDING[name] ?? `value-of-${name}`,
    ]),
  );

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("requireSecrets", () => {
  test("returns every inventory secret for the tier, redacted", () => {
    const out = requireSecrets({ worker: "osn-api", stage: "dev", env: envFor("osn-api", "dev") });
    expect(Object.keys(out).toSorted()).toEqual([...tierSecrets("osn-api", "dev").secrets]);
    for (const value of Object.values(out)) expect(Redacted.isRedacted(value)).toBe(true);
    expect(Redacted.value(out.OSN_PAIRWISE_SALT)).toBe("value-of-OSN_PAIRWISE_SALT");
  });

  test("production never receives a secret its tier does not declare", () => {
    const env = { ...envFor("osn-api", "production"), DEV_LOGIN_SECRET: "present-in-env" };
    const out = requireSecrets({ worker: "osn-api", stage: "production", env });
    expect(out).not.toHaveProperty("DEV_LOGIN_SECRET");
  });

  test("names every missing or empty secret in one error", () => {
    const env: Record<string, string | undefined> = { ...envFor("cire-api", "dev") };
    delete env.CIRE_API_ARC_KEY_ID;
    delete env.CIRE_OIDC_CLIENT_SECRET;
    env.STRIPE_SECRET_KEY = "";
    env.STRIPE_WEBHOOK_SECRET = "   ";
    const error = thrown(() => requireSecrets({ worker: "cire-api", stage: "dev", env }));
    expect(error).toBeInstanceOf(MissingSecretsError);
    expect((error as MissingSecretsError).missing).toEqual([
      "CIRE_API_ARC_KEY_ID",
      "CIRE_OIDC_CLIENT_SECRET",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ]);
  });

  test("refuses a value with surrounding whitespace, naming it but never printing it", () => {
    const env = { ...envFor("osn-api", "production"), OSN_PAIRWISE_SALT: "s3cr3t-salt-value\n" };
    const error = thrown(() => requireSecrets({ worker: "osn-api", stage: "production", env }));
    expect((error as MissingSecretsError).malformed).toEqual(["OSN_PAIRWISE_SALT"]);
    expect((error as Error).message).toContain("OSN_PAIRWISE_SALT");
    expect((error as Error).message).not.toContain("s3cr3t-salt-value");
  });

  test("no value reaches the error message", () => {
    const env: Record<string, string | undefined> = { ...envFor("osn-api", "dev") };
    delete env.RESEND_API_KEY;
    const message = (
      thrown(() => requireSecrets({ worker: "osn-api", stage: "dev", env })) as Error
    ).message;
    const leaked = Object.values(env).filter(
      (value) => value !== undefined && message.includes(value),
    );
    expect(leaked).toEqual([]);
  });

  test("declares an optional secret only while its GitHub secret holds a value", () => {
    const env = envFor("osn-api", "production");
    expect(requireSecrets({ worker: "osn-api", stage: "production", env })).not.toHaveProperty(
      "OSN_TOTP_ENCRYPTION_KEY_PREVIOUS",
    );
    const draining = { ...env, OSN_TOTP_ENCRYPTION_KEY_PREVIOUS: "outgoing-key" };
    const out = requireSecrets({ worker: "osn-api", stage: "production", env: draining });
    expect(Redacted.value(out.OSN_TOTP_ENCRYPTION_KEY_PREVIOUS)).toBe("outgoing-key");
  });

  test("refuses an optional value of only whitespace rather than dropping the secret", () => {
    const env = { ...envFor("osn-api", "production"), OSN_TOTP_ENCRYPTION_KEY_PREVIOUS: "\n" };
    const error = thrown(() => requireSecrets({ worker: "osn-api", stage: "production", env }));
    expect(error).toBeInstanceOf(MissingSecretsError);
    expect((error as MissingSecretsError).malformed).toEqual(["OSN_TOTP_ENCRYPTION_KEY_PREVIOUS"]);
  });

  test("refuses a padded optional value like a required one", () => {
    const env = { ...envFor("osn-api", "dev"), OSN_TOTP_ENCRYPTION_KEY_PREVIOUS: " outgoing-key" };
    const error = thrown(() => requireSecrets({ worker: "osn-api", stage: "dev", env }));
    expect((error as MissingSecretsError).malformed).toEqual(["OSN_TOTP_ENCRYPTION_KEY_PREVIOUS"]);
  });
});

describe("SH1: requireSecrets refuses a dev secret that breaks its tier's rule before anything uploads", () => {
  test.each([
    "sk_live_51Hx0placeholder",
    "rk_live_51Hx0placeholder",
    "pk_test_51Hx0",
    "sk_test-51Hx0",
    "whsec_0",
  ])(
    "STRIPE_SECRET_KEY %s on dev: refused, naming the secret and the rule, never the value",
    (value) => {
      const env = { ...envFor("cire-api", "dev"), STRIPE_SECRET_KEY: value };
      const error = thrown(() => requireSecrets({ worker: "cire-api", stage: "dev", env }));
      expect(error).toBeInstanceOf(MissingSecretsError);
      expect(error).toMatchObject({
        missing: [],
        malformed: [],
        breaksRule: ["STRIPE_SECRET_KEY"],
      });
      const { message } = error as Error;
      expect(message).toContain("STRIPE_SECRET_KEY");
      expect(message).toContain("sk_test_ or rk_test_");
      expect(message).not.toContain(value);
    },
  );

  test("STRIPE_SECRET_KEY on dev takes a test-mode secret or restricted key", () => {
    for (const value of ["sk_test_51Hx0placeholder", "rk_test_51Hx0placeholder"]) {
      const env = { ...envFor("cire-api", "dev"), STRIPE_SECRET_KEY: value };
      const out = requireSecrets({ worker: "cire-api", stage: "dev", env });
      expect(Redacted.value(out.STRIPE_SECRET_KEY)).toBe(value);
    }
  });

  test("DEV_LOGIN_SECRET under 32 characters is refused on dev and in an investigation stage; 32 is taken", () => {
    const short = "s3cr3t".padEnd(31, "x");
    for (const stage of ["dev", "probe"]) {
      const env = { ...envFor("osn-api", "dev"), DEV_LOGIN_SECRET: short };
      const error = thrown(() => requireSecrets({ worker: "osn-api", stage, env }));
      expect(error).toMatchObject({ breaksRule: ["DEV_LOGIN_SECRET"] });
      expect((error as Error).message).toContain("DEV_LOGIN_SECRET");
      expect((error as Error).message).toContain("at least 32 characters");
      expect((error as Error).message).not.toContain(short);
    }
    const env = { ...envFor("osn-api", "dev"), DEV_LOGIN_SECRET: "s3cr3t".padEnd(32, "x") };
    expect(
      Redacted.value(requireSecrets({ worker: "osn-api", stage: "dev", env }).DEV_LOGIN_SECRET),
    ).toBe("s3cr3t".padEnd(32, "x"));
  });

  test("CIRE_INTERNAL_REVOKE_SECRET under 32 characters is refused on dev and production for both Workers that hold it; 32 is taken", () => {
    const short = "s3cr3t".padEnd(31, "x");
    for (const stage of ["dev", "production"] as const) {
      for (const worker of ["osn-api", "cire-api"] as const) {
        const env = { ...envFor(worker, stage), CIRE_INTERNAL_REVOKE_SECRET: short };
        const error = thrown(() => requireSecrets({ worker, stage, env }));
        expect(error).toMatchObject({ breaksRule: ["CIRE_INTERNAL_REVOKE_SECRET"] });
        expect((error as Error).message).toContain("at least 32 characters");
        expect((error as Error).message).not.toContain(short);
        const long = {
          ...envFor(worker, stage),
          CIRE_INTERNAL_REVOKE_SECRET: "s3cr3t".padEnd(32, "x"),
        };
        expect(
          Redacted.value(requireSecrets({ worker, stage, env: long }).CIRE_INTERNAL_REVOKE_SECRET),
        ).toBe("s3cr3t".padEnd(32, "x"));
      }
    }
  });

  test("one error names every unset, padded and rule-breaking secret together", () => {
    const env: Record<string, string | undefined> = {
      ...envFor("cire-api", "dev"),
      STRIPE_SECRET_KEY: "sk_live_51Hx0placeholder",
      STRIPE_WEBHOOK_SECRET: " whsec_padded",
    };
    delete env.CIRE_OIDC_CLIENT_SECRET;
    const error = thrown(() => requireSecrets({ worker: "cire-api", stage: "dev", env }));
    expect(error).toMatchObject({
      missing: ["CIRE_OIDC_CLIENT_SECRET"],
      malformed: ["STRIPE_WEBHOOK_SECRET"],
      breaksRule: ["STRIPE_SECRET_KEY"],
    });
  });
});

describe("requireSeedValue", () => {
  test("B6: refuses an unset, blank or padded value, naming the variable and never the value", () => {
    for (const value of [undefined, "", "   ", " s3cr3t-seed", "s3cr3t-seed\n"]) {
      const env = { CIRE_OIDC_CLIENT_SECRET: value };
      const error = thrown(() => requireSeedValue(env, "CIRE_OIDC_CLIENT_SECRET"));
      expect(error).toBeInstanceOf(SeedValueError);
      expect((error as Error).message).toContain("CIRE_OIDC_CLIENT_SECRET");
      expect((error as Error).message).not.toContain("s3cr3t-seed");
    }
    expect(
      requireSeedValue({ CIRE_OIDC_CLIENT_SECRET: "s3cr3t-seed" }, "CIRE_OIDC_CLIENT_SECRET"),
    ).toBe("s3cr3t-seed");
  });
});

import { Redacted } from "effect";
import { describe, expect, test } from "vitest";

import { tierSecrets, type WorkerKey } from "../../src/secrets/inventory";
import {
  MissingSecretsError,
  requireSecrets,
  requireSeedSecret,
  SeedSecretError,
} from "../../src/secrets/require";
import type { Tier } from "../../src/stage";

const envFor = (worker: WorkerKey, tier: Tier): Record<string, string> =>
  Object.fromEntries(tierSecrets(worker, tier).secrets.map((name) => [name, `value-of-${name}`]));

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
    delete env.CIRE_OIDC_CLIENT_SECRET;
    delete env.OSN_API_URL;
    env.STRIPE_SECRET_KEY = "";
    env.STRIPE_WEBHOOK_SECRET = "   ";
    const error = thrown(() => requireSecrets({ worker: "cire-api", stage: "dev", env }));
    expect(error).toBeInstanceOf(MissingSecretsError);
    expect((error as MissingSecretsError).missing).toEqual([
      "CIRE_OIDC_CLIENT_SECRET",
      "OSN_API_URL",
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

describe("requireSeedSecret", () => {
  test("B6: refuses an unset, blank or padded value, naming the variable and never the value", () => {
    for (const value of [undefined, "", "   ", " s3cr3t-seed", "s3cr3t-seed\n"]) {
      const env = { CIRE_OIDC_CLIENT_SECRET: value };
      const error = thrown(() => requireSeedSecret(env, "CIRE_OIDC_CLIENT_SECRET"));
      expect(error).toBeInstanceOf(SeedSecretError);
      expect((error as Error).message).toContain("CIRE_OIDC_CLIENT_SECRET");
      expect((error as Error).message).not.toContain("s3cr3t-seed");
    }
    expect(
      requireSeedSecret({ CIRE_OIDC_CLIENT_SECRET: "s3cr3t-seed" }, "CIRE_OIDC_CLIENT_SECRET"),
    ).toBe("s3cr3t-seed");
  });
});

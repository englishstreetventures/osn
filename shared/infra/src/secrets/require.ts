import { Data, Redacted } from "effect";

import { tierOf, type Tier } from "../stage";
import { tierSecrets, type WorkerKey } from "./inventory";

export class MissingSecretsError extends Data.TaggedError("MissingSecretsError")<{
  readonly worker: WorkerKey;
  readonly tier: Tier;
  /** Required GitHub Environment secret names that are unset, empty or only whitespace. Never values. */
  readonly missing: readonly string[];
  /** Names whose value starts or ends with whitespace, an optional name holding only whitespace included. Never values. */
  readonly malformed: readonly string[];
  /** Names whose value breaks the rule its tier sets for it (`TIER_VALUE_RULES`). Never values. */
  readonly breaksRule: readonly string[];
  readonly message: string;
}> {}

/** A rule one secret's value must meet on one tier, beyond being set and unpadded. */
interface ValueRule {
  /** What the value must be, as the refusal states it. */
  readonly rule: string;
  readonly fits: (value: string) => boolean;
}

/**
 * The rules each tier sets for a secret's value, by secret name. Each is a
 * prefix or a length, so it cannot refuse a correct value. On dev, Stripe
 * takes only a test-mode key, so no dev deploy can move real money; and the
 * dev sign-in secret, which alone stands between a public route and the
 * seeded owner's session, is long enough that guessing it is hopeless.
 */
const TIER_VALUE_RULES = {
  dev: new Map<string, ValueRule>([
    [
      "STRIPE_SECRET_KEY",
      {
        rule: "a test-mode key, starting sk_test_ or rk_test_",
        fits: (value) => /^(sk|rk)_test_/.test(value),
      },
    ],
    ["DEV_LOGIN_SECRET", { rule: "at least 32 characters", fits: (value) => value.length >= 32 }],
  ]),
  production: new Map<string, ValueRule>(),
} satisfies Record<Tier, ReadonlyMap<string, ValueRule>>;

/**
 * Reads every secret the inventory declares for `worker` at `stage` from
 * `env` (the GitHub Environment secrets a deploy job passes through), and
 * throws before anything is uploaded when a required one is unset, empty or
 * only whitespace, any value carries leading or trailing whitespace, or a
 * value breaks a rule its tier sets (`TIER_VALUE_RULES`). An optional
 * secret is left out only when it is unset or empty; one holding only
 * whitespace is refused, because leaving it out would delete the live
 * secret from the Worker. A value is never trimmed: a pasted trailing newline
 * would otherwise reach the Worker as a different key. The error names each
 * secret and the rule it breaks, never a value.
 */
export function requireSecrets(input: {
  readonly worker: WorkerKey;
  readonly stage: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Readonly<Record<string, Redacted.Redacted<string>>> {
  const tier = tierOf(input.stage);
  const row = tierSecrets(input.worker, tier);
  const rules = TIER_VALUE_RULES[tier];
  const missing: string[] = [];
  const malformed: string[] = [];
  const breaksRule: string[] = [];
  const present: (readonly [string, Redacted.Redacted<string>])[] = [];
  const read = (name: string, required: boolean): void => {
    const value = input.env[name];
    if (value === undefined || value === "" || (required && value.trim() === "")) {
      if (required) missing.push(name);
    } else if (value !== value.trim()) {
      malformed.push(name);
    } else if (rules.get(name)?.fits(value) === false) {
      breaksRule.push(name);
    } else {
      present.push([name, Redacted.make(value)]);
    }
  };
  for (const name of row.secrets) read(name, true);
  for (const name of row.optional) read(name, false);
  if (missing.length > 0 || malformed.length > 0 || breaksRule.length > 0) {
    const broken = breaksRule.map((name) => `${name} (must be ${rules.get(name)?.rule})`);
    const parts = [
      missing.length > 0 ? `unset or blank: ${missing.join(", ")}` : "",
      malformed.length > 0 ? `leading or trailing whitespace: ${malformed.join(", ")}` : "",
      breaksRule.length > 0 ? `that break the ${tier} tier's rules: ${broken.join(", ")}` : "",
    ].filter((part) => part !== "");
    throw new MissingSecretsError({
      worker: input.worker,
      tier,
      missing,
      malformed,
      breaksRule,
      message: `${input.worker} cannot deploy at stage '${input.stage}' (${tier} tier). GitHub Environment secrets ${parts.join("; ")}.`,
    });
  }
  return Object.fromEntries(present);
}

export class SeedValueError extends Data.TaggedError("SeedValueError")<{
  /** The environment variable's name. Never its value. */
  readonly variable: string;
  readonly message: string;
}> {}

/**
 * One value a stack builds its own seed from, never uploaded to a Worker;
 * refused unset, blank or padded. The value is never trimmed, and the error
 * names the variable only.
 */
export function requireSeedValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name] ?? "";
  if (value.trim() === "") {
    throw new SeedValueError({
      variable: name,
      message: `${name} is unset or blank; the stack needs it to build its seed.`,
    });
  }
  if (value !== value.trim()) {
    throw new SeedValueError({
      variable: name,
      message: `${name} has leading or trailing whitespace; the stack takes it as given, never trimmed.`,
    });
  }
  return value;
}

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
  readonly message: string;
}> {}

/**
 * Reads every secret the inventory declares for `worker` at `stage` from
 * `env` (the GitHub Environment secrets a deploy job passes through), and
 * throws before anything is uploaded when a required one is unset, empty or
 * only whitespace, or any value carries leading or trailing whitespace. An
 * optional secret is left out only when it is unset or empty; one holding
 * only whitespace is refused, because leaving it out would delete the live
 * secret from the Worker. A value is never trimmed: a pasted trailing newline
 * would otherwise reach the Worker as a different key.
 */
export function requireSecrets(input: {
  readonly worker: WorkerKey;
  readonly stage: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Readonly<Record<string, Redacted.Redacted<string>>> {
  const tier = tierOf(input.stage);
  const row = tierSecrets(input.worker, tier);
  const missing: string[] = [];
  const malformed: string[] = [];
  const present: (readonly [string, Redacted.Redacted<string>])[] = [];
  const read = (name: string, required: boolean): void => {
    const value = input.env[name];
    if (value === undefined || value === "" || (required && value.trim() === "")) {
      if (required) missing.push(name);
    } else if (value !== value.trim()) {
      malformed.push(name);
    } else {
      present.push([name, Redacted.make(value)]);
    }
  };
  for (const name of row.secrets) read(name, true);
  for (const name of row.optional) read(name, false);
  if (missing.length > 0 || malformed.length > 0) {
    const parts = [
      missing.length > 0 ? `unset or blank: ${missing.join(", ")}` : "",
      malformed.length > 0 ? `leading or trailing whitespace: ${malformed.join(", ")}` : "",
    ].filter((part) => part !== "");
    throw new MissingSecretsError({
      worker: input.worker,
      tier,
      missing,
      malformed,
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

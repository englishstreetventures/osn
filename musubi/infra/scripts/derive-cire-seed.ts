#!/usr/bin/env bun
/**
 * Derives what osn-api's dev seed needs from two cire secrets, so the step
 * that runs the musubi stack holds neither.
 *
 * The musubi stack seeds osn-db-dev with the `cid_cire` OIDC client and
 * cire-api's ARC key (`src/seeds.ts`). The client row stores only the
 * SHA-256 of `CIRE_OIDC_CLIENT_SECRET`, and the key row only the public half
 * of `CIRE_API_ARC_PRIVATE_KEY`. deploy.yml's musubi stack job runs this as
 * its `cire_seed` step, the one step holding those secrets, and hands the
 * deploy step what it writes:
 *
 *   key_id                the ARC key id, `CIRE_API_ARC_KEY_ID`, checked as a UUID;
 *   public_jwk            the key's kty, crv, x and y as JSON, never `d`;
 *   client_secret_sha256  the client secret's SHA-256 in lower-case hex, as
 *                         osn-api's `hashClientSecret` computes it.
 *
 * Each goes to $GITHUB_OUTPUT on one line, checked first so no value can
 * start a line of its own. Nothing goes to stdout; a refusal names the
 * variable on stderr, never its value, and writes no output.
 *
 * Imports only node built-ins, so CI runs it with `bun --no-install` and no
 * package code runs beside the secrets.
 */

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

class DeriveError extends Error {
  /** The variable that was refused, by name. Never its value. */
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(message);
    this.name = "DeriveError";
    this.variable = variable;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One P-256 coordinate: 32 bytes, base64url without padding. */
const COORDINATE = /^[A-Za-z0-9_-]{43}$/;

/** SHA-256 hex of a client secret, as osn-api's `hashClientSecret` computes it (`osn/api/src/services/auth/oidc.ts`). */
function clientSecretHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

const refuseKey = (reason: string): DeriveError =>
  new DeriveError(
    "CIRE_API_ARC_PRIVATE_KEY",
    `CIRE_API_ARC_PRIVATE_KEY ${reason}; it must be a raw ES256 JWK (kty EC, crv P-256, with x and y).`,
  );

interface JwkFields {
  readonly kty?: unknown;
  readonly crv?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
}

/**
 * The public half of cire-api's ARC key, as the JSON string osn-api stores
 * in `service_account_keys.public_key_jwk`. The key is a raw JWK string, not
 * base64. Only `kty`, `crv`, `x` and `y` are kept, so `d` never leaves.
 */
function arcPublicJwk(privateJwk: string): string {
  let parsed: JwkFields | null;
  try {
    parsed = JSON.parse(privateJwk) as JwkFields | null;
  } catch {
    // JSON.parse's message can quote the input, so it is never passed on.
    throw refuseKey("is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw refuseKey("is not a JSON object");
  }
  const { kty, crv, x, y } = parsed;
  if (kty !== "EC" || crv !== "P-256") throw refuseKey("is not an EC P-256 key");
  if (typeof x !== "string" || typeof y !== "string") throw refuseKey("has no x or no y");
  if (!COORDINATE.test(x) || !COORDINATE.test(y)) {
    throw refuseKey("has an x or y that is not a 32-byte base64url value");
  }
  return JSON.stringify({ kty, crv, x, y });
}

/** One secret, refused unset, blank or padded; never trimmed. */
function readSecret(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name] ?? "";
  if (value.trim() === "") {
    throw new DeriveError(name, `GitHub Environment secret ${name} is unset or blank.`);
  }
  if (value !== value.trim()) {
    throw new DeriveError(
      name,
      `GitHub Environment secret ${name} has leading or trailing whitespace; set it without.`,
    );
  }
  return value;
}

/** The step's outputs, in the order they are written. */
function deriveCireSeed(
  env: Readonly<Record<string, string | undefined>>,
): readonly (readonly [string, string])[] {
  const keyId = readSecret(env, "CIRE_API_ARC_KEY_ID");
  if (!UUID.test(keyId)) {
    throw new DeriveError("CIRE_API_ARC_KEY_ID", "CIRE_API_ARC_KEY_ID is not a UUID.");
  }
  const publicJwk = arcPublicJwk(readSecret(env, "CIRE_API_ARC_PRIVATE_KEY"));
  const hash = clientSecretHash(readSecret(env, "CIRE_OIDC_CLIENT_SECRET"));
  return [
    ["key_id", keyId],
    ["public_jwk", publicJwk],
    ["client_secret_sha256", hash],
  ];
}

/** Writes the outputs to $GITHUB_OUTPUT; returns the exit code. */
function main(env: Readonly<Record<string, string | undefined>>): number {
  try {
    const outputs = deriveCireSeed(env);
    const target = env.GITHUB_OUTPUT ?? "";
    if (target === "") {
      throw new DeriveError(
        "GITHUB_OUTPUT",
        "GITHUB_OUTPUT is not set; this runs as deploy.yml's cire_seed step.",
      );
    }
    appendFileSync(target, outputs.map(([name, value]) => `${name}=${value}\n`).join(""));
    return 0;
  } catch (error) {
    // A DeriveError names the variable only. Anything else is reported by
    // its kind alone: its message could quote a secret.
    const reason =
      error instanceof DeriveError
        ? error.message
        : `failed (${error instanceof Error ? error.name : "unknown error"})`;
    process.stderr.write(`derive-cire-seed: ${reason}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.env);
}

/**
 * AES-GCM encryption for TOTP shared secrets at rest.
 *
 * Every other credential in this schema is stored as a hash — recovery codes,
 * session tokens, OIDC authorization codes. A TOTP secret cannot be: RFC 6238
 * verification derives the expected code from the raw HMAC key, so the server
 * has to get the key back. Encryption is what stands in for hashing here, and
 * the security it buys is a specific, limited thing: the key lives in the
 * Worker's secret store and the ciphertext lives in D1, so a database dump on
 * its own yields no working second factor for anybody. It does not protect
 * against an attacker who has the running Worker.
 *
 * The accountId is bound in as additional authenticated data, so a row copied
 * onto another account fails to decrypt rather than authenticating the wrong
 * person.
 *
 * Two keys can be live at once, which is what makes the key rotatable. The
 * Worker holds `OSN_TOTP_ENCRYPTION_KEY` and, during a rotation, the outgoing
 * key as `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS`; {@link createTotpKeyRing} turns
 * the pair into a version-to-key map. New ciphertext is always written under
 * the highest version present, and `services/auth/totp.ts` re-encrypts a row
 * under that key the next time its owner verifies a code, so the outgoing key
 * drains as it is used rather than in a bulk job.
 *
 * **A row's `keyVersion` is a hint, not the selector.** {@link decryptTotpSecret}
 * tries every key in the ring and reports the highest-numbered one that opened
 * the row. That is what makes a rotation safe in any order: the two secrets are
 * written one at a time, minutes or hours apart, and between those writes a
 * row's stamp and the key it is really under can disagree. Selecting strictly
 * by the stamp would refuse those rows — and a row rewritten during the
 * disagreement would carry a stamp whose key can never open it again. Trial
 * decryption is sound because GCM authenticates: a wrong key fails, it does not
 * return plausible bytes.
 *
 * The stamp is therefore **not** how an operator measures a drain either;
 * versions are slot numbers and are reused by the next rotation. `last_used_at`
 * is the gauge, because the same statement that re-encrypts a row sets it —
 * see `[[wiki/systems/totp]]`.
 */

/** Length of `OSN_TOTP_ENCRYPTION_KEY` once base64-decoded. AES-256. */
const TOTP_KEY_BYTES = 32;

/** GCM's nonce length. 96 bits is the only size the spec optimises for. */
const TOTP_IV_BYTES = 12;

/**
 * The version a lone key sits at — so every row written before a second key
 * existed carries it, and the column's `default(1)` agrees. A configured
 * previous key takes this slot and pushes the current key one above it; see
 * {@link createTotpKeyRing}.
 */
export const TOTP_KEY_VERSION = 1;

/** Every key this process can decrypt with, by the version stamped on a row. */
export type TotpKeyRing = ReadonlyMap<number, CryptoKey>;

/**
 * No key in the ring opens this row.
 *
 * One error for four causes — an unknown version, a key that was never
 * installed, a tampered ciphertext, and a row moved to another account —
 * because they are one fact to the caller: this process cannot read this
 * secret. `checkTotpCode` answers all of them with the generic code failure,
 * which is what every other TOTP rejection already answers.
 */
export class TotpSecretUnreadableError extends Error {
  constructor() {
    // No ciphertext, no IV, no version: this message can reach a log.
    super("No configured TOTP encryption key can decrypt this credential");
    this.name = "TotpSecretUnreadableError";
  }
}

/**
 * The ring the Worker's two secrets describe.
 *
 * The previous key takes {@link TOTP_KEY_VERSION} — the slot every existing row
 * is stamped with — and the current key sits one above it, so the current key
 * is always the highest version present and {@link encryptTotpSecret} needs no
 * other input to find it. With no previous key the current one holds the base
 * slot alone, which is exactly the state before any rotation.
 *
 * The numbering is derived from what is configured rather than fixed in a
 * constant, and that is load-bearing: a constant would have to be changed by a
 * deploy while the keys change by a secret write, and no ordering of those two
 * moments is safe.
 */
export function createTotpKeyRing(current: CryptoKey, previous?: CryptoKey): TotpKeyRing {
  return previous
    ? new Map([
        [TOTP_KEY_VERSION, previous],
        [TOTP_KEY_VERSION + 1, current],
      ])
    : new Map([[TOTP_KEY_VERSION, current]]);
}

/**
 * The version new ciphertext is written under: the highest in the ring.
 *
 * Throws on an empty ring rather than returning `Math.max()`'s `-Infinity`,
 * which would stamp rows with a version nothing can ever look up. A `Map` is
 * always truthy, so an empty one would otherwise sail through every
 * `key ? … : fail` check a caller makes.
 */
export function currentTotpKeyVersion(ring: TotpKeyRing): number {
  if (ring.size === 0) throw new Error("No TOTP encryption key is configured");
  return Math.max(...ring.keys());
}

export interface EncryptedTotpSecret {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  keyVersion: number;
}

/**
 * A stored secret as {@link decryptTotpSecret} needs it. Structurally what a
 * `totp_credentials` row already is, so a row goes in without a mapping step —
 * and what {@link fromJsonSafe} produces from a parked enrolment, so both
 * callers meet the same contract.
 */
export interface StoredTotpSecret {
  secretCiphertext: Uint8Array;
  iv: Uint8Array;
  keyVersion: number;
}

/**
 * How {@link importTotpEncryptionKey} reports a key it will not import.
 *
 * `envName` names the variable being imported, because two now are: an operator
 * mid-rotation reading "OSN_TOTP_ENCRYPTION_KEY is wrong" when the fault is in
 * `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS` looks at the wrong value first, during the
 * one procedure where that costs the most.
 */
export interface ImportTotpKeyOptions {
  readonly envName?: string;
  readonly onInvalidLength?: (decodedBytes: number) => void;
}

/**
 * Import a base64 TOTP encryption key as a non-extractable AES-GCM key.
 *
 * Throws on anything that is not exactly 32 decoded bytes — in every tier, not
 * just deployed ones, and for the previous key as well as the current one. A
 * short or mistyped key would otherwise import fine in local dev and fail at
 * the first enrolment, and the point of a boot-time check is that the wrong
 * value is loud where it is set rather than quiet until someone uses the
 * feature. For the previous key "quiet" would be worse still: the rotation
 * would appear to have been staged while every un-drained credential silently
 * stopped verifying.
 *
 * The thrown message names the variable, states the requirement and
 * interpolates nothing of the value, because `index.ts` turns a boot failure
 * into the body of an **unauthenticated** 503: the decoded length is a property
 * of the secret's value and does not belong on that wire. `onInvalidLength` is
 * the operator's channel for it — `build-deps` passes a reporter that writes
 * the number through the redacting logger.
 */
export async function importTotpEncryptionKey(
  base64: string,
  options: ImportTotpKeyOptions = {},
): Promise<CryptoKey> {
  const envName = options.envName ?? "OSN_TOTP_ENCRYPTION_KEY";
  let raw: Buffer;
  try {
    raw = Buffer.from(base64, "base64");
  } catch {
    throw new Error(`${envName} is not valid base64`);
  }
  // Buffer.from is lenient — it decodes what it can and drops the rest rather
  // than throwing — so the length check is the real validation, not a formality.
  if (raw.length !== TOTP_KEY_BYTES) {
    options.onInvalidLength?.(raw.length);
    throw new Error(`${envName} must decode to exactly ${TOTP_KEY_BYTES} bytes`);
  }
  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * A fresh AES-GCM key for local development, mirroring what `loadJwtKeyPair`
 * does when the signing pair is unset. Credentials enrolled against it stop
 * decrypting when the process restarts, which is the same bargain local dev
 * already makes with its ephemeral signing key. Never reachable in a deployed
 * tier — `buildAppDeps` throws there before this is called.
 */
export function generateEphemeralTotpEncryptionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: TOTP_KEY_BYTES * 8 }, false, [
    "encrypt",
    "decrypt",
  ]) as Promise<CryptoKey>;
}

/**
 * The accountId as AAD bytes. One place, so encrypt and decrypt cannot drift.
 *
 * Copied into a fresh view because `TextEncoder.encode` is typed over
 * `ArrayBufferLike`, which includes `SharedArrayBuffer`, and WebCrypto's
 * `BufferSource` does not.
 */
const aad = (accountId: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(accountId));

/**
 * Encrypt a raw TOTP secret for `accountId` under a fresh IV and the ring's
 * current key — always the highest version present, never the previous one.
 */
export async function encryptTotpSecret(
  ring: TotpKeyRing,
  accountId: string,
  secret: Uint8Array,
): Promise<EncryptedTotpSecret> {
  const keyVersion = currentTotpKeyVersion(ring);
  const key = ring.get(keyVersion);
  if (!key) throw new Error("No TOTP encryption key is configured");
  const iv = crypto.getRandomValues(new Uint8Array(TOTP_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(accountId) },
    key,
    new Uint8Array(secret),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv, keyVersion };
}

/** A recovered secret, and which of the ring's keys actually opened it. */
export interface DecryptedTotpSecret {
  secret: Uint8Array;
  keyVersion: number;
}

/**
 * Recover a raw TOTP secret, trying the key the row's `keyVersion` names first
 * and then the rest of the ring.
 *
 * The fallback is what lets a rotation be staged in any order — see the module
 * docstring — and it is safe because GCM authenticates: a key that is not the
 * right one fails to open the row rather than returning plausible bytes, so
 * trying a second key cannot produce a wrong secret. The reported `keyVersion`
 * is the one that worked, which is what the caller re-keys against; the stamp
 * on the row is never trusted for that decision.
 *
 * Throws {@link TotpSecretUnreadableError} when nothing opens it, which also
 * covers a tampered ciphertext and a row moved to another account — the AAD
 * binding still holds, because every attempt authenticates `accountId`.
 *
 * `Uint8Array` in the parameter type covers what both drivers hand back:
 * drizzle's blob-buffer mode maps every driver value through `Buffer.from`, and
 * a `Buffer` IS a `Uint8Array`. The bytes are copied into a plain
 * `ArrayBuffer`-backed view anyway, because a `Buffer` from bun:sqlite can be a
 * window onto a larger pooled allocation and WebCrypto would read the whole
 * thing.
 */
export async function decryptTotpSecret(
  ring: TotpKeyRing,
  accountId: string,
  row: StoredTotpSecret,
): Promise<DecryptedTotpSecret> {
  // Highest version first, so a row is attributed to the NEWEST key that can
  // open it. That matters in the window where both secrets hold the same value
  // — the operator has staged the outgoing key but not yet installed the new
  // one — because attributing those rows to the lower slot would re-encrypt the
  // entire population under the key it is already using, for nothing.
  //
  // The row's own `keyVersion` deliberately does not steer this. It is a hint
  // for operators and logs; a rotation is staged by two secret writes minutes
  // or hours apart, and between them a row's stamp and the key it is really
  // under can disagree. Selecting on the stamp is what makes that disagreement
  // fatal.
  const order = [...ring.keys()].toSorted((a, b) => b - a);

  const iv = new Uint8Array(row.iv);
  const ciphertext = new Uint8Array(row.secretCiphertext);
  const additionalData = aad(accountId);

  // Every key is tried, rather than stopping at the first that works. The ring
  // holds at most two keys and the payload is twenty bytes, so the extra
  // attempt is unmeasurable — and it buys a decrypt cost that does not depend
  // on WHICH key opened the row, which is the same reason `verifyTotpCode`
  // derives every candidate code instead of returning on the first match.
  // `allSettled` never rejects, so a wrong key cannot surface as an unhandled
  // rejection either.
  const attempts = await Promise.allSettled(
    order.map((keyVersion) => {
      const key = ring.get(keyVersion);
      return key
        ? crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, key, ciphertext)
        : Promise.reject(new TotpSecretUnreadableError());
    }),
  );

  for (const [index, attempt] of attempts.entries()) {
    if (attempt.status === "fulfilled") {
      return { secret: new Uint8Array(attempt.value), keyVersion: order[index] as number };
    }
  }
  // Nothing here distinguishes "wrong key" from "tampered row" or "row moved to
  // another account", and nothing should: all three mean this process cannot
  // read this secret, and all three already answer one generic failure.
  throw new TotpSecretUnreadableError();
}

/**
 * The ceremony-store shape for a pending, unconfirmed enrolment.
 *
 * Base64 strings, not byte arrays, and that is load-bearing rather than
 * stylistic: the in-memory store keeps the value by reference while the Redis
 * store round-trips it through `JSON.stringify`. A `Uint8Array` here would work
 * in every test and come back from Upstash as `{"0":12,"1":200,…}`.
 */
export interface EncryptedTotpSecretJson {
  ciphertextB64: string;
  ivB64: string;
  keyVersion: number;
}

export function toJsonSafe(encrypted: EncryptedTotpSecret): EncryptedTotpSecretJson {
  return {
    ciphertextB64: Buffer.from(encrypted.ciphertext).toString("base64"),
    ivB64: Buffer.from(encrypted.iv).toString("base64"),
    keyVersion: encrypted.keyVersion,
  };
}

export function fromJsonSafe(stored: EncryptedTotpSecretJson): StoredTotpSecret {
  return {
    secretCiphertext: new Uint8Array(Buffer.from(stored.ciphertextB64, "base64")),
    iv: new Uint8Array(Buffer.from(stored.ivB64, "base64")),
    keyVersion: stored.keyVersion,
  };
}

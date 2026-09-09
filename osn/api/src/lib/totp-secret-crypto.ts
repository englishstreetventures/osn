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
 * Key rotation is NOT implemented. There is one key and one version, no map
 * from version to key, and a row stamped with any other version is refused
 * rather than decrypted — so two keys cannot coexist and no staged rotation is
 * expressible. `keyVersion` is stored per row so that adding rotation later is
 * a code change rather than a migration; until then the only remedy for an
 * exposed key is re-enrolment by every user. Adding it is xchromo/osn#968.
 */

/** Length of `OSN_TOTP_ENCRYPTION_KEY` once base64-decoded. AES-256. */
const TOTP_KEY_BYTES = 32;

/** GCM's nonce length. 96 bits is the only size the spec optimises for. */
const TOTP_IV_BYTES = 12;

/**
 * The version every ciphertext is written under, and the only version
 * {@link decryptTotpSecret} accepts. Nothing selects a key by it, because there
 * is only one key — see the module docstring.
 */
export const TOTP_KEY_VERSION = 1;

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
 * Import the base64 `OSN_TOTP_ENCRYPTION_KEY` as a non-extractable AES-GCM key.
 *
 * Throws on anything that is not exactly 32 decoded bytes — in every tier, not
 * just deployed ones. A short or mistyped key would otherwise import fine in
 * local dev and fail at the first enrolment, and the point of a boot-time check
 * is that the wrong value is loud where it is set rather than quiet until
 * someone uses the feature.
 *
 * The thrown message states the requirement and interpolates nothing, because
 * `index.ts` turns a boot failure into the body of an **unauthenticated** 503:
 * the decoded length is a property of the secret's value and does not belong on
 * that wire. `onInvalidLength` is the operator's channel for it — `build-deps`
 * passes a reporter that writes the number through the redacting logger.
 */
export async function importTotpEncryptionKey(
  base64: string,
  onInvalidLength?: (decodedBytes: number) => void,
): Promise<CryptoKey> {
  let raw: Buffer;
  try {
    raw = Buffer.from(base64, "base64");
  } catch {
    throw new Error("OSN_TOTP_ENCRYPTION_KEY is not valid base64");
  }
  // Buffer.from is lenient — it decodes what it can and drops the rest rather
  // than throwing — so the length check is the real validation, not a formality.
  if (raw.length !== TOTP_KEY_BYTES) {
    onInvalidLength?.(raw.length);
    throw new Error(`OSN_TOTP_ENCRYPTION_KEY must decode to exactly ${TOTP_KEY_BYTES} bytes`);
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

/** Encrypt a raw TOTP secret for `accountId` under a fresh IV. */
export async function encryptTotpSecret(
  key: CryptoKey,
  accountId: string,
  secret: Uint8Array,
): Promise<EncryptedTotpSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(TOTP_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(accountId) },
    key,
    new Uint8Array(secret),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv, keyVersion: TOTP_KEY_VERSION };
}

/**
 * Recover a raw TOTP secret. Throws when the ciphertext, the IV, the account or
 * the key is wrong — GCM authenticates, so a tampered row cannot decrypt to
 * plausible bytes.
 *
 * `Uint8Array` in the parameter type covers what both drivers hand back:
 * drizzle's blob-buffer mode maps every driver value through `Buffer.from`, and
 * a `Buffer` IS a `Uint8Array`. The bytes are copied into a plain
 * `ArrayBuffer`-backed view anyway, because a `Buffer` from bun:sqlite can be a
 * window onto a larger pooled allocation and WebCrypto would read the whole
 * thing.
 */
export async function decryptTotpSecret(
  key: CryptoKey,
  accountId: string,
  row: StoredTotpSecret,
): Promise<Uint8Array> {
  if (row.keyVersion !== TOTP_KEY_VERSION) {
    throw new Error(`Unsupported TOTP key version ${row.keyVersion}`);
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(row.iv), additionalData: aad(accountId) },
    key,
    new Uint8Array(row.secretCiphertext),
  );
  return new Uint8Array(plaintext);
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

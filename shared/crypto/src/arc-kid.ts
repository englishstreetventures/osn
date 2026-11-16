/**
 * Key ids for osn-api's outbound ARC keys that an app can check before it
 * fetches anything.
 *
 * osn-api publishes the public half of each key it signs with
 * (`GET /.well-known/arc-jwks.json`), and an app looks a token's key up there
 * by its `kid`. A lookup of a kid the app has not seen costs a fetch, so a
 * stream of tokens with made-up kids would make the app fetch on every
 * request. A kid minted here carries the key's expiry and an HMAC of both:
 * `<uuid>.<expiry, unix seconds>.<MAC>`. An app holding the secret osn-api
 * holds (`INTERNAL_SERVICE_SECRET`) refuses a kid whose MAC fails or whose
 * expiry has passed before it fetches.
 *
 * On the ARC path the MAC gates fetching only. A token is authenticated by
 * its signature against the published key, never by its kid, so a kid that
 * passes this check proves nothing else.
 *
 * The MAC key is derived from the secret with HKDF-SHA-256 under a fixed salt
 * and an `info` naming this use ({@link macKey}), never the secret itself:
 * the same secret is the bearer of the service-key registration routes, and
 * a published MAC keyed with it would be a MAC under that bearer. Minting and
 * checking both derive the key here, so osn-api and every app agree on it.
 *
 * Every published kid still lets anyone test a guess at the secret offline:
 * derive, MAC, compare. HKDF is fast and adds no entropy, so the derivation
 * does not slow that search or protect a weak secret. What stands between a
 * guess and the secret is the secret's own randomness. A secret shorter than
 * {@link ARC_KID_SECRET_MIN_LENGTH} characters is never used to key the MAC:
 * kids are minted without one and checked as if no secret were held. The
 * floor refuses a value too short to be random; it cannot tell a long random
 * value from a long guessable one, so the secret must be generated (for
 * example `openssl rand -base64 32`), never chosen.
 *
 * DB-free, so it loads on Workers: import it as `@shared/crypto/arc-kid`.
 */

import { timingSafeEqualString } from "./timing-safe";

/** Base64url characters of the MAC a kid carries: 132 bits. */
const MAC_LENGTH = 22;

/** The shortest secret used as the MAC key. */
export const ARC_KID_SECRET_MIN_LENGTH = 32;

/** `secret` when it is long enough to key the MAC; otherwise undefined, as if unset. */
export function arcKidMacSecret(secret: string | undefined): string | undefined {
  return secret !== undefined && secret.length >= ARC_KID_SECRET_MIN_LENGTH ? secret : undefined;
}

const encoder = new TextEncoder();

/**
 * HKDF's salt and `info` for the kid MAC key. osn-api and every app that
 * checks its kids must use the same two values: changing either refuses
 * every kid minted under the other until both sides run the change.
 */
const MAC_KEY_SALT = encoder.encode("osn-arc-kid-salt");
const MAC_KEY_INFO = encoder.encode("osn-arc-kid-mac-v1");

async function deriveMacKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: MAC_KEY_SALT, info: MAC_KEY_INFO },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** One derived HMAC key per secret, for the isolate's life; a derivation that failed is dropped. */
const macKeys = new Map<string, Promise<CryptoKey>>();

/** The HMAC key for kid MACs under `secret`: derived from it, never the secret itself. */
function macKey(secret: string): Promise<CryptoKey> {
  let key = macKeys.get(secret);
  if (!key) {
    const imported = deriveMacKey(secret);
    imported.catch(() => {
      if (macKeys.get(secret) === imported) macKeys.delete(secret);
    });
    macKeys.set(secret, imported);
    key = imported;
  }
  return key;
}

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function macOf(secret: string, uuid: string, expiresAt: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await macKey(secret),
    encoder.encode(`osn-arc-kid:${uuid}.${expiresAt}`),
  );
  return base64url(signature).slice(0, MAC_LENGTH);
}

/**
 * A new kid for a key that expires at `expiresAt` (unix seconds): with a MAC
 * when `secret` can key one ({@link arcKidMacSecret}), `<uuid>.<expiresAt>`
 * alone when it cannot.
 */
export async function mintArcKid(secret: string | undefined, expiresAt: number): Promise<string> {
  const uuid = crypto.randomUUID();
  const expiry = String(Math.floor(expiresAt));
  const macSecret = arcKidMacSecret(secret);
  if (!macSecret) return `${uuid}.${expiry}`;
  return `${uuid}.${expiry}.${await macOf(macSecret, uuid, expiry)}`;
}

/**
 * Whether an app may fetch the key `kid` names. With no `secret` that can key
 * the MAC ({@link arcKidMacSecret}) it always may: the app cannot tell. With
 * one, only a kid of three parts whose expiry is after `nowSec` and whose MAC
 * verifies.
 */
export async function checkArcKid(
  kid: string,
  secret: string | undefined,
  nowSec: number,
): Promise<boolean> {
  const macSecret = arcKidMacSecret(secret);
  if (!macSecret) return true;
  const parts = kid.split(".");
  if (parts.length !== 3) return false;
  const [uuid, expiry, mac] = parts as [string, string, string];
  if (!/^\d{1,12}$/.test(expiry) || Number(expiry) <= nowSec) return false;
  if (mac.length !== MAC_LENGTH) return false;
  return timingSafeEqualString(mac, await macOf(macSecret, uuid, expiry));
}

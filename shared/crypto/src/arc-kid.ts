/**
 * Key ids for osn-api's outbound ARC keys that an app can check before it
 * fetches anything.
 *
 * osn-api publishes the public half of each key it signs with
 * (`GET /.well-known/arc-jwks.json`), and an app looks a token's key up there
 * by its `kid`. A lookup of a kid the app has not seen costs a fetch, so a
 * stream of tokens with made-up kids would make the app fetch on every
 * request. A kid minted here carries the key's expiry and up to two HMACs of
 * both: `<uuid>.<expiry, unix seconds>[.<MAC>[.<MAC>]]`. An app holding a
 * secret osn-api holds refuses a kid whose expiry has passed, or that carries
 * no MAC it can verify, before it fetches.
 *
 * Two secrets key the MACs ({@link ArcKidSecrets}):
 *
 *  - `OSN_ARC_KID_SECRET`, held for this MAC alone, keys the first MAC.
 *  - `INTERNAL_SERVICE_SECRET` keys the second, until every Worker on every
 *    tier holds the first (englishstreetventures/osn#2540). With both, osn-api
 *    puts both MACs in each kid, so an app holding either secret accepts it,
 *    whichever Worker was given the kid secret first. An app holding both
 *    accepts a kid either MAC verifies; an app holding only the kid secret
 *    (cire-api, which holds no service secret) accepts only a kid whose MAC
 *    under the kid secret verifies.
 *
 * On the ARC path the MAC gates fetching only. A token is authenticated by
 * its signature against the published key, never by its kid, so a kid that
 * passes this check proves nothing else.
 *
 * An app asks osn-api for one key by id ({@link ArcKidLookup}'s `ask`), and
 * osn-api, which holds the secrets, checks the MACs again itself: it answers
 * a kid one of its MACs verifies from memory, and reads the ask's
 * `<uuid>.<expiry>` with {@link readArcKeyAsk}. Both rules live here, so an
 * app never asks in a form osn-api refuses for a real key.
 *
 * Each MAC key is derived from its secret with HKDF-SHA-256 under a fixed salt
 * and an `info` naming the secret's role ({@link macKey}), never the secret
 * itself: the service secret is the bearer of the service-key registration
 * routes, and a published MAC keyed with it would be a MAC under that bearer.
 * The two `info` values differ, so a MAC under one secret never passes for
 * the other. A kid secret set to the service secret's value is ignored
 * ({@link usableKeys}). Minting and checking both derive the keys here, so
 * osn-api and every app agree on them.
 *
 * Every published kid still lets anyone test a guess at a secret offline:
 * derive, MAC, compare. HKDF is fast and adds no entropy, so the derivation
 * does not slow that search or protect a weak secret. What stands between a
 * guess and the secret is the secret's own randomness. A secret shorter than
 * {@link ARC_KID_SECRET_MIN_LENGTH} characters is never used to key a MAC:
 * kids are minted without it and checked as if it were not held. The floor
 * refuses a value too short to be random; it cannot tell a long random value
 * from a long guessable one, so each secret must be generated (for example
 * `openssl rand -base64 32`), never chosen.
 *
 * DB-free, so it loads on Workers: import it as `@shared/crypto/arc-kid`.
 */

import { timingSafeEqualString } from "./timing-safe";

/** Base64url characters of each MAC a kid carries: 132 bits. */
const MAC_LENGTH = 22;

/** The shortest secret used as a MAC key. */
export const ARC_KID_SECRET_MIN_LENGTH = 32;

/** `secret` when it is long enough to key a MAC; otherwise undefined, as if unset. */
export function arcKidMacSecret(secret: string | undefined): string | undefined {
  return secret !== undefined && secret.length >= ARC_KID_SECRET_MIN_LENGTH ? secret : undefined;
}

/** The secrets a Worker holds for kid MACs; either may be unset. */
export interface ArcKidSecrets {
  /** `OSN_ARC_KID_SECRET`: held for the kid MAC alone. */
  readonly kidSecret: string | undefined;
  /**
   * `INTERNAL_SERVICE_SECRET`, keying the MAC every Worker checks until each
   * holds `kidSecret`. Bounded until englishstreetventures/osn#2540 lands.
   */
  readonly serviceSecret: string | undefined;
}

const encoder = new TextEncoder();

/**
 * HKDF's salt, and the `info` for each secret's MAC key. osn-api and every
 * app that checks its kids must use the same values: changing one refuses
 * every kid minted under the other until both sides run the change.
 */
const MAC_KEY_SALT = encoder.encode("osn-arc-kid-salt");
const KID_SECRET_INFO = "osn-arc-kid-mac-v2";
const SERVICE_SECRET_INFO = "osn-arc-kid-mac-v1";

async function deriveMacKey(secret: string, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: MAC_KEY_SALT, info: encoder.encode(info) },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/**
 * One derived HMAC key per `info` and secret, for the isolate's life; a
 * derivation that failed is dropped.
 */
const macKeys = new Map<string, Promise<CryptoKey>>();

/** The HMAC key for kid MACs under `secret` in the role `info` names: derived, never the secret itself. */
function macKey(secret: string, info: string): Promise<CryptoKey> {
  const id = `${info}\u0000${secret}`;
  let key = macKeys.get(id);
  if (!key) {
    const imported = deriveMacKey(secret, info);
    imported.catch(() => {
      if (macKeys.get(id) === imported) macKeys.delete(id);
    });
    macKeys.set(id, imported);
    key = imported;
  }
  return key;
}

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function macOf(
  secret: string,
  info: string,
  uuid: string,
  expiresAt: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await macKey(secret, info),
    encoder.encode(`osn-arc-kid:${uuid}.${expiresAt}`),
  );
  return base64url(signature).slice(0, MAC_LENGTH);
}

/**
 * The MAC keys `secrets` can key, the kid secret's first, each as
 * `[secret, info]`. A kid secret equal to the service secret is never used:
 * the kid secret is handed to Workers that must not hold the service secret,
 * so it must be generated on its own.
 */
function usableKeys(secrets: ArcKidSecrets): (readonly [string, string])[] {
  const keys: (readonly [string, string])[] = [];
  const kidSecret = arcKidMacSecret(secrets.kidSecret);
  const serviceSecret = arcKidMacSecret(secrets.serviceSecret);
  if (kidSecret && kidSecret !== serviceSecret) keys.push([kidSecret, KID_SECRET_INFO]);
  if (serviceSecret) keys.push([serviceSecret, SERVICE_SECRET_INFO]);
  return keys;
}

/**
 * Whether `secrets` key any kid MAC: the rule {@link mintArcKid} mints by and
 * {@link checkArcKid} checks by. Never infer it from {@link checkArcKid}'s
 * answer, which passes every kid when no secret can key a MAC.
 */
export function holdsArcKidKey(secrets: ArcKidSecrets): boolean {
  return usableKeys(secrets).length > 0;
}

/**
 * A new kid for a key that expires at `expiresAt` (unix seconds): one MAC
 * under each secret that can key one ({@link arcKidMacSecret}), the kid
 * secret's first, and `<uuid>.<expiresAt>` alone when neither can.
 */
export async function mintArcKid(secrets: ArcKidSecrets, expiresAt: number): Promise<string> {
  const uuid = crypto.randomUUID();
  const expiry = String(Math.floor(expiresAt));
  const macs = await Promise.all(
    usableKeys(secrets).map(([secret, info]) => macOf(secret, info, uuid, expiry)),
  );
  return [uuid, expiry, ...macs].join(".");
}

/**
 * How an app looks up the key a kid names, once the kid has passed
 * {@link checkArcKid}.
 */
export interface ArcKidLookup {
  /**
   * What the app caches the key under. For a kid whose MAC verified, the
   * `<uuid>.<expiry>` that MAC covers: a 4-part kid carries a MAC the app may
   * hold no key for, which anyone can replace, so no lookup depends on it.
   * The whole kid only when the app holds no secret and checked nothing.
   */
  readonly id: string;
  /** Whether a kid in osn-api's published set is the key this lookup wants. */
  readonly names: (publishedKid: string) => boolean;
  /**
   * What the app sends osn-api to ask for the key (`?kid=`), which osn-api
   * reads with {@link readArcKeyAsk}. For a kid whose MAC verified: its
   * `<uuid>.<expiry>` and every part shaped as a MAC (22 base64url
   * characters), in order, the verified one always among them, so osn-api
   * can check each MAC it holds and never sees what a part the app could not
   * verify held otherwise. The kid as sent when the app checked nothing.
   */
  readonly ask: string;
}

/** A MAC part as {@link mintArcKid} writes one. */
const MAC_PART = /^[A-Za-z0-9_-]{22}$/;
/** A uuid as `crypto.randomUUID` writes one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An expiry as {@link mintArcKid} writes one: unix seconds, no leading zero. */
const EXPIRY = /^[1-9]\d{0,11}$/;

/**
 * The `<uuid>.<expiry>` an ask names, or `null` for an ask no osn-api could
 * have minted a kid for: a uuid as `crypto.randomUUID` writes it, an expiry
 * after `nowSec` and no more than `maxLifeSec` past it, and at most two MAC
 * parts of 22 base64url characters. Every ask {@link checkArcKid} builds
 * for a kid whose MAC verified reads, whatever its unverified parts held.
 */
export function readArcKeyAsk(ask: string, nowSec: number, maxLifeSec: number): string | null {
  const parts = ask.split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  const [uuid, expiry, ...macs] = parts as [string, string, ...string[]];
  if (!UUID.test(uuid) || !EXPIRY.test(expiry)) return null;
  const expiresAt = Number(expiry);
  if (expiresAt <= nowSec || expiresAt > nowSec + maxLifeSec) return null;
  if (!macs.every((mac) => MAC_PART.test(mac))) return null;
  return `${uuid}.${expiry}`;
}

/**
 * Whether an app may fetch the key `kid` names, what it looks the key up by
 * and what it asks osn-api for ({@link ArcKidLookup}); `null` refuses. With no secret that can key a
 * MAC ({@link arcKidMacSecret}) every kid passes, looked up exactly: the app
 * cannot tell. With one, only a kid of one or two MACs, each
 * {@link MAC_LENGTH} characters, whose expiry is after `nowSec`, and one of
 * whose MACs verifies under a secret the app holds.
 */
export async function checkArcKid(
  kid: string,
  secrets: ArcKidSecrets,
  nowSec: number,
): Promise<ArcKidLookup | null> {
  const keys = usableKeys(secrets);
  if (keys.length === 0) return { id: kid, names: (published) => published === kid, ask: kid };
  const parts = kid.split(".");
  if (parts.length < 3 || parts.length > 4) return null;
  const [uuid, expiry, ...macs] = parts as [string, string, ...string[]];
  if (!/^\d{1,12}$/.test(expiry) || Number(expiry) <= nowSec) return null;
  if (macs.some((mac) => mac.length !== MAC_LENGTH)) return null;
  // Under each key in turn, the kid secret's first, as osn-api writes its MACs:
  // the first that verifies decides, and the next is not computed. The ask
  // keeps every part shaped as a MAC, whichever verified.
  const verifiesFrom = async (index: number): Promise<boolean> => {
    const key = keys[index];
    if (!key) return false;
    const expected = await macOf(key[0], key[1], uuid, expiry);
    return macs.some((part) => timingSafeEqualString(part, expected)) || verifiesFrom(index + 1);
  };
  if (!(await verifiesFrom(0))) return null;
  const id = `${uuid}.${expiry}`;
  return {
    id,
    ask: [uuid, expiry, ...macs.filter((part) => MAC_PART.test(part))].join("."),
    names: (published) => {
      const named = published.split(".");
      return (named.length === 3 || named.length === 4) && `${named[0]}.${named[1]}` === id;
    },
  };
}

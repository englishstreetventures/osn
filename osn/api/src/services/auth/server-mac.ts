/**
 * Keyed digests the auth service makes under one server secret, the session IP
 * pepper (`OSN_SESSION_IP_PEPPER`, read in `build-deps.ts` and required in
 * every deployed tier). Each use hashes its own label in first, so no two uses
 * can produce the same digest from the same input, and none can collide with
 * the IP hashes the pepper also keys (an IP never starts with a label).
 *
 * Rotating the pepper changes every probe key, which only moves padding to
 * fresh objects, and voids the discoverable passkey challenges in flight,
 * which live five minutes.
 *
 * With no pepper (local dev and tests), the key is random and made once per
 * service, never a fixed one: a fixed key in the source would make every
 * digest reversible by anyone who reads it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Each use's label. A new use takes a new label. */
const PROBE_KEY_LABEL = "osn-api probe key\0";
const CHALLENGE_LABEL = "osn-api discoverable passkey challenge\0";

/** A discoverable challenge's bytes: nonce, expiry (ms, big-endian), MAC. */
const NONCE_BYTES = 16;
const EXPIRY_BYTES = 8;
const MAC_BYTES = 32;
const CHALLENGE_BYTES = NONCE_BYTES + EXPIRY_BYTES + MAC_BYTES;

/** What opening a discoverable challenge found. */
export type OpenedChallenge =
  | { readonly ok: true; readonly nonce: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: "malformed" | "forged" | "expired" };

export interface ServerMac {
  /**
   * The store key a refusal pads with for `normalisedIdentifier`: `prb_` and
   * 12 hex digits, the length of an account id (`acc_` and 12), and the same
   * for every request naming that identifier, so a padding call reaches an
   * object of the same name shape and age as a real account's call does. The
   * `prb_` prefix keeps it from ever naming a real account's entry.
   *
   * Keyed, so a list of email addresses cannot be run through it to learn
   * which of them someone asked about.
   */
  probeKey(normalisedIdentifier: string): string;
  /**
   * A discoverable passkey challenge good until `expiresAt` (epoch ms): 16
   * random bytes, the expiry, and a MAC over both. The bytes are the WebAuthn
   * challenge itself, so the browser signs them and sends them back in
   * `clientDataJSON`; nothing is stored until the challenge is used.
   */
  mintChallenge(expiresAt: number): Uint8Array<ArrayBuffer>;
  /**
   * The nonce and expiry of a challenge this secret minted, from its
   * base64url form. Refuses anything of the wrong length (`malformed`), any
   * change to a minted challenge (`forged`, compared in constant time), and a
   * challenge past its expiry (`expired`). A challenge opens as often as it
   * is presented: single use is the caller's, by claiming the nonce.
   */
  openChallenge(challenge: string, now?: number): OpenedChallenge;
}

export function createServerMac(secret: string | undefined): ServerMac {
  const key: string | Uint8Array = secret ?? crypto.getRandomValues(new Uint8Array(32));
  const mac = (label: string) => createHmac("sha256", key).update(label);
  const challengeMac = (signed: Uint8Array): Uint8Array =>
    new Uint8Array(mac(CHALLENGE_LABEL).update(signed).digest());
  return {
    probeKey(normalisedIdentifier) {
      return `prb_${mac(PROBE_KEY_LABEL).update(normalisedIdentifier).digest("hex").slice(0, 12)}`;
    },
    mintChallenge(expiresAt) {
      const bytes = new Uint8Array(CHALLENGE_BYTES);
      crypto.getRandomValues(bytes.subarray(0, NONCE_BYTES));
      new DataView(bytes.buffer).setBigUint64(NONCE_BYTES, BigInt(Math.max(0, expiresAt)));
      const signed = bytes.subarray(0, NONCE_BYTES + EXPIRY_BYTES);
      bytes.set(challengeMac(signed), NONCE_BYTES + EXPIRY_BYTES);
      return bytes;
    },
    openChallenge(challenge, now = Date.now()) {
      const bytes = new Uint8Array(Buffer.from(challenge, "base64url"));
      if (bytes.length !== CHALLENGE_BYTES) return { ok: false, reason: "malformed" };
      const signed = bytes.subarray(0, NONCE_BYTES + EXPIRY_BYTES);
      const presented = bytes.subarray(NONCE_BYTES + EXPIRY_BYTES);
      if (!timingSafeEqual(presented, challengeMac(signed))) return { ok: false, reason: "forged" };
      const expiresAt = Number(new DataView(bytes.buffer).getBigUint64(NONCE_BYTES));
      if (expiresAt <= now) return { ok: false, reason: "expired" };
      const nonce = Array.from(bytes.subarray(0, NONCE_BYTES), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      return { ok: true, nonce, expiresAt };
    },
  };
}

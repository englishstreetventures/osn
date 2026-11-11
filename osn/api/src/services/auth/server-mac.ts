/**
 * Keyed digests the auth service makes under one server secret, the session IP
 * pepper (`OSN_SESSION_IP_PEPPER`, read in `build-deps.ts` and required in
 * every deployed tier). Each use hashes its own label in first, so no two uses
 * can produce the same digest from the same input, and none can collide with
 * the IP hashes the pepper also keys (an IP never starts with a label).
 *
 * Rotating the pepper changes every probe key, which only moves padding to
 * fresh objects; voids the discoverable passkey challenges in flight, which
 * live two minutes (`CHALLENGE_TTL_MS`); and voids the emailed-link requests in
 * flight, which live ten minutes (`otpTtl`): their pairing number is no longer
 * among the candidates the confirm page shows, so a person begins again.
 *
 * With no pepper (local dev and tests), the key is random and made once per
 * service, never a fixed one: a fixed key in the source would make every
 * digest reversible by anyone who reads it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Each use's label. A new use takes a new label. */
const PROBE_KEY_LABEL = "osn-api probe key\0";
const CHALLENGE_LABEL = "osn-api discoverable passkey challenge\0";
const PAIRING_CANDIDATES_LABEL = "osn-api email link candidates\0";
const PAIRING_DIGEST_LABEL = "osn-api email link pairing\0";

/** Two-digit pairing numbers: 10 to 99. */
const PAIRING_MIN = 10;
const PAIRING_SPAN = 90;
/** The largest multiple of `PAIRING_SPAN` a byte can hold; bytes at or past it are skipped. */
const PAIRING_BYTE_CEILING = Math.floor(256 / PAIRING_SPAN) * PAIRING_SPAN;

/** A discoverable challenge's bytes: nonce, expiry (ms, big-endian), MAC. */
const NONCE_BYTES = 16;
const EXPIRY_BYTES = 8;
const MAC_BYTES = 32;
const CHALLENGE_BYTES = NONCE_BYTES + EXPIRY_BYTES + MAC_BYTES;

/** What opening a discoverable challenge found. */
type OpenedChallenge =
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
  /**
   * The `count` two-digit numbers (`10`–`99`, distinct, ascending) an emailed
   * link's confirm page offers for `requestId`. Derived, never stored: the
   * same request always gets the same list, and nobody without this secret can
   * work it out from the request id.
   */
  pairingCandidates(requestId: string, count: number): string[];
  /**
   * The keyed digest a request stores in place of its pairing number. The
   * number space is small, so only the key keeps the stored digest from
   * naming it.
   */
  pairingDigest(requestId: string, value: string): string;
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
    pairingCandidates(requestId, count) {
      const found = new Set<number>();
      for (let round = 0; found.size < count; round++) {
        const digest = mac(PAIRING_CANDIDATES_LABEL).update(`${requestId}\0${round}`).digest();
        for (const byte of digest) {
          // Uniform over the 90 values: a byte past the last whole multiple
          // of 90 would favour the low ones, so it is skipped.
          if (byte >= PAIRING_BYTE_CEILING) continue;
          found.add(PAIRING_MIN + (byte % PAIRING_SPAN));
          if (found.size === count) break;
        }
      }
      return [...found].toSorted((a, b) => a - b).map(String);
    },
    pairingDigest(requestId, value) {
      return mac(PAIRING_DIGEST_LABEL).update(`${requestId}\0${value}`).digest("hex");
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

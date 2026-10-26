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

import { createHmac } from "node:crypto";

/** Each use's label. A new use takes a new label. */
const PROBE_KEY_LABEL = "osn-api probe key\0";

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
}

export function createServerMac(secret: string | undefined): ServerMac {
  const key: string | Uint8Array = secret ?? crypto.getRandomValues(new Uint8Array(32));
  const mac = (label: string) => createHmac("sha256", key).update(label);
  return {
    probeKey(normalisedIdentifier) {
      return `prb_${mac(PROBE_KEY_LABEL).update(normalisedIdentifier).digest("hex").slice(0, 12)}`;
    },
  };
}

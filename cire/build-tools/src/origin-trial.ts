/**
 * The Chrome origin-trial tokens cire serves, and a decoder for them.
 *
 * Each token was issued for `https://cireweddings.com:443` with subdomain
 * matching, so it is valid on `invite.`, `host.`, `vendor.` and `api.` there
 * and on no other zone. The dev tier runs on its own zone and gets none of
 * the features; Chrome ignores a token whose origin does not match, so the
 * header is sent there harmlessly.
 *
 * A token is public: it ships in a response header. Pure and free of
 * `node:fs`, so a Worker bundle can import it (the guest site does, for its
 * response headers).
 *
 * Where each token is served:
 * - `htmlInCanvas`: every guest-site response
 *   (`cire/invites/src/lib/security-headers.ts`).
 * - `webmcp`: every organiser-portal path (`cire/host/public/_headers`,
 *   which holds its own copy of the string; its test compares the two).
 *
 * Renewal: register the origin again for the feature on the Chrome
 * origin-trials site, replace the string here (and the host's copy), and keep
 * the expiry in `tests/origin-trial.test.ts` in step. That test fails once a
 * token is inside {@link ORIGIN_TRIAL_RENEWAL_WINDOW_MS} of its expiry.
 */

export const ORIGIN_TRIAL_TOKENS = {
  /** `HTMLInCanvas`: the guest site's envelope opening. Lapses 2 Mar 2027. */
  htmlInCanvas:
    "AmzwHiFc5WrSZKP9N9WR31IhpARcOoAOPUsOZ/6VgK7kchGrsYYTkpBFN4iQwr4A3qoJh2E/QzRLT2/jNs53iQQAAABpeyJvcmlnaW4iOiJodHRwczovL2NpcmV3ZWRkaW5ncy5jb206NDQzIiwiZmVhdHVyZSI6IkhUTUxJbkNhbnZhcyIsImV4cGlyeSI6MTgwMzk0NTYwMCwiaXNTdWJkb21haW4iOnRydWV9",
  /** `WebMCP`: the organiser portal's agent tools. Lapses 30 Mar 2027. */
  webmcp:
    "AgPxiGR6Xgoixpqap0KVAvRxTwIRut1C3PfF/TFDXNbFNBDbUMSFSFDajYg9B7YOFNynoj7zuZBXsxbDM4HK6AoAAABjeyJvcmlnaW4iOiJodHRwczovL2NpcmV3ZWRkaW5ncy5jb206NDQzIiwiZmVhdHVyZSI6IldlYk1DUCIsImV4cGlyeSI6MTgwNjM2NDgwMCwiaXNTdWJkb21haW4iOnRydWV9",
} as const;

/** How long before a token's expiry the tests start to fail: 14 days. */
export const ORIGIN_TRIAL_RENEWAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The fields Chrome reads from a token's payload. */
export interface OriginTrialPayload {
  origin: string;
  feature: string;
  /** Seconds since the epoch. */
  expiry: number;
  isSubdomain: boolean;
}

// A token is one version byte, a 64-byte signature, a 4-byte big-endian
// payload length, then the payload as JSON.
const VERSION_BYTES = 1;
const SIGNATURE_BYTES = 64;
const LENGTH_BYTES = 4;
const PAYLOAD_OFFSET = VERSION_BYTES + SIGNATURE_BYTES + LENGTH_BYTES;

/** Reads a token's payload. Does not check the signature; Chrome does. */
export function decodeOriginTrialToken(token: string): OriginTrialPayload {
  const bytes = Uint8Array.from(atob(token), (char) => char.charCodeAt(0));
  if (bytes.length <= PAYLOAD_OFFSET) {
    throw new Error("origin-trial token too short to hold a payload");
  }
  const length = new DataView(bytes.buffer).getUint32(VERSION_BYTES + SIGNATURE_BYTES);
  const json = new TextDecoder().decode(bytes.slice(PAYLOAD_OFFSET, PAYLOAD_OFFSET + length));
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error("origin-trial token payload is not JSON");
  }
  const fields = payload as Partial<OriginTrialPayload>;
  for (const field of ["origin", "feature", "expiry"] as const) {
    if (fields[field] === undefined) {
      throw new Error(`origin-trial token payload has no ${field}`);
    }
  }
  return {
    origin: fields.origin as string,
    feature: fields.feature as string,
    expiry: fields.expiry as number,
    isSubdomain: fields.isSubdomain === true,
  };
}

/** An `Origin-Trial` header value for these tokens. */
export function originTrialHeader(...tokens: string[]): string {
  return tokens.join(", ");
}

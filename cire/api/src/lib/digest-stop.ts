/**
 * Signed stop links for the daily RSVP digest.
 *
 * Every digest names one recipient and one wedding, and carries a link that
 * turns that recipient's digest off for that wedding without signing in. The
 * link holds a token: the two ids, and an HMAC-SHA256 over them. The stop
 * route acts only on a token whose MAC verifies, so nobody can stop a digest
 * they were not sent.
 *
 * KEY: derived by HKDF-SHA256 from the OIDC client secret
 * (`CIRE_OIDC_CLIENT_SECRET`) under its own `info`, the same way the OIDC
 * transaction cookie's MAC key is, so the two keys are unrelated and no new
 * secret needs provisioning. Rotating the client secret voids every stop link
 * already sent; the Overview switch still works.
 *
 * NO EXPIRY: a stop link in an old email keeps working, as a mail client's
 * one-click unsubscribe expects. The token is not secret from everyone — it is
 * in the email, so the mail provider holds it, and in the request URL, so the
 * Worker's request logs hold it for their retention — and anyone holding it can
 * do exactly one thing: turn that one person's digest off for that one wedding.
 * The ids it carries are encoded, not encrypted.
 */

/** HKDF `info` for the stop-link MAC key. Distinct from every other use of the secret. */
export const DIGEST_STOP_HMAC_INFO = "cire-rsvp-digest-stop-v1";

/** Bumped if the payload's shape ever changes, so an old token cannot be misread. */
const TOKEN_VERSION = "v1";

const encoder = new TextEncoder();

const bytesToB64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** `null` for anything that is not base64url. */
function b64urlToBytes(raw: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(raw)) return null;
  try {
    return Uint8Array.from(atob(raw.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

/** The MAC key. Derive once per run or per isolate, not per token. */
export async function deriveDigestStopKey(secret: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode(DIGEST_STOP_HMAC_INFO),
    },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

/** Who a stop link speaks for. */
export interface DigestStopTarget {
  weddingId: string;
  osnProfileId: string;
}

/** `<base64url payload>.<base64url MAC>`. The payload is newline-separated, and
 *  neither id can hold a newline. */
export async function signDigestStopToken(
  key: CryptoKey,
  target: DigestStopTarget,
): Promise<string> {
  const payload = encoder.encode(`${TOKEN_VERSION}\n${target.weddingId}\n${target.osnProfileId}`);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
  return `${bytesToB64url(payload)}.${bytesToB64url(mac)}`;
}

/** The target a token names, or `null` when it is malformed or its MAC does not
 *  verify. The comparison is the platform's own constant-time verify. */
export async function verifyDigestStopToken(
  key: CryptoKey,
  token: string,
): Promise<DigestStopTarget | null> {
  // Far longer than any real token; refuses a huge query string before decoding it.
  if (token.length > 512) return null;
  const [payloadPart, macPart, extra] = token.split(".");
  if (payloadPart === undefined || macPart === undefined || extra !== undefined) return null;
  const payload = b64urlToBytes(payloadPart);
  const mac = b64urlToBytes(macPart);
  if (!payload || !mac) return null;
  const valid = await crypto.subtle.verify("HMAC", key, mac, payload);
  if (!valid) return null;
  const [version, weddingId, osnProfileId, ...rest] = new TextDecoder().decode(payload).split("\n");
  if (version !== TOKEN_VERSION || !weddingId || !osnProfileId || rest.length > 0) return null;
  return { weddingId, osnProfileId };
}

/** The stop link for one recipient, on the API's own origin. */
export async function digestStopUrl(
  apiOrigin: string,
  key: CryptoKey,
  target: DigestStopTarget,
): Promise<string> {
  const token = await signDigestStopToken(key, target);
  return `${apiOrigin.replace(/\/+$/, "")}/api/rsvp-digest/stop?t=${encodeURIComponent(token)}`;
}

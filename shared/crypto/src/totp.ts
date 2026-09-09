/**
 * RFC 6238 time-based one-time passwords, and the RFC 4648 base32 that carries
 * the shared secret to an authenticator app.
 *
 * The scheme: a 20-byte secret is generated once, shown to the user as a QR
 * code (`totpUri`) or as base32 text they can type back (`parseTotpSecret`),
 * and thereafter both sides derive the same six digits from it and the current
 * 30-second step. The server keeps the secret because HMAC verification needs
 * the raw key — unlike recovery codes and session tokens in this package, a
 * TOTP secret cannot be stored as a hash. Encrypting it at rest is the
 * caller's job, not this module's.
 *
 * Deliberately its own module importing nothing but `./timing-safe`:
 * `@shared/crypto`'s index pulls in `@osn/db` and `drizzle-orm`, which a
 * caller deriving six digits has no business loading. Import it as
 * `@shared/crypto/totp`.
 */

import { timingSafeEqualString } from "./timing-safe";

/** RFC 4648 §6 alphabet — uppercase letters then the digits 2 to 7. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * What `base32Decode` accepts once whitespace and `=` padding are stripped.
 * Tested BEFORE case-folding, never after: Unicode uppercasing maps `ß` to
 * `SS`, `ı` to `I`, `ſ` to `S` and `ﬀ` to `FF`, so folding first would let all
 * four through a check against the alphabet.
 */
const BASE32_INPUT = /^[A-Za-z2-7]*$/;

/** RFC 4226 §4 recommends 160 bits of shared secret. */
const TOTP_SECRET_BYTES = 20;

/** RFC 4226 §4 R6 — the shared secret must be at least 128 bits. */
const TOTP_MIN_SECRET_BYTES = 16;

/**
 * The floor is enforced at four entry points and thrown at three of them —
 * `verifyTotpCode` answers `false` instead — so the wording lives in one place
 * and reads the same wherever a caller meets it.
 */
function secretFloorError(functionName: string): TypeError {
  return new TypeError(`${functionName}: secret must be at least ${TOTP_MIN_SECRET_BYTES} bytes`);
}

/**
 * Ceiling on what `base32Decode` will look at, so the work one call performs is
 * bounded whatever the caller passes — the same principle `TOTP_MAX_WINDOW`
 * applies to verification. The input is a string an unauthenticated caller
 * chose the length of, and decoding is linear in it: eight million characters
 * measure in tens of milliseconds against a Workers CPU budget of ten. A
 * 20-byte secret is 32 characters, so 512 leaves room for spacing and padding
 * many times over.
 */
const BASE32_MAX_INPUT_LENGTH = 512;

const TOTP_DIGITS = 6;

/** RFC 6238's default time step X. */
const TOTP_STEP_SECONDS = 30;

/** One step either side, which is RFC 6238 §5.2's recommendation for drift. */
const TOTP_DEFAULT_WINDOW = 1;

/**
 * Hard ceiling on the drift window, so the work one call performs is bounded
 * whatever the caller passes. Ten steps is ±5 minutes; a window large enough
 * to matter beyond that is a clock problem, not a drift problem.
 */
const TOTP_MAX_WINDOW = 10;

/** Six ASCII digits. `\d` would do — without `u` it is ASCII-only — but say it. */
const SIX_ASCII_DIGITS = /^[0-9]{6}$/;

/**
 * Stand-in key for a secret `verifyTotpCode` cannot verify against, so that
 * case does the same HMACs and the same comparisons as a real one instead of
 * returning in microseconds. "Not enrolled" is an absent or empty secret in
 * every schema shape this will sit behind, so the fast path would otherwise
 * answer, to anyone who can reach the route, whether an account has a second
 * factor. Same move as hashing an incoming password against a dummy hash when
 * no user matches. Its bytes are never compared against anything, so a
 * constant serves.
 */
const TOTP_DUMMY_SECRET = new Uint8Array(TOTP_SECRET_BYTES);

/** A fresh 160-bit TOTP shared secret. */
export function generateTotpSecret(): Uint8Array {
  const bytes = new Uint8Array(TOTP_SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Base32 of `bytes`: uppercase, unpadded, RFC 4648 alphabet. */
export function base32Encode(bytes: Uint8Array): string {
  let carry = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    carry = (carry << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(carry >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(carry << (5 - bits)) & 0x1f];
  return out;
}

/**
 * Bytes from base32. Tolerant of what a person retypes — lowercase, spaces
 * between groups, and the `=` padding some apps display — and strict about
 * everything else: any other character throws a `TypeError`. Bits left over in
 * a trailing partial group are discarded, so a truncated string decodes to the
 * whole bytes it does carry rather than failing.
 *
 * Input longer than 512 characters is refused before anything scans it, so an
 * unauthenticated caller cannot choose how long one decode runs.
 *
 * A general codec, and deliberately not a secret parser: it returns whatever
 * bytes the input carries, including none at all for a one- or two-character
 * input whose only bits are the leftover ones. Use `parseTotpSecret` for
 * anything that has to be a usable secret.
 *
 * The thrown message names no part of the input. This function's argument is a
 * shared secret a user pasted, and an error message is the one place a
 * fragment of it would reach a log.
 */
export function base32Decode(input: string): Uint8Array {
  if (input.length > BASE32_MAX_INPUT_LENGTH) {
    throw new TypeError(`base32Decode: input is longer than ${BASE32_MAX_INPUT_LENGTH} characters`);
  }

  const compact = input.replace(/[\s=]/g, "");
  if (!BASE32_INPUT.test(compact)) {
    throw new TypeError("base32Decode: input has a character outside the RFC 4648 alphabet");
  }

  const symbols = compact.toUpperCase();
  const out = new Uint8Array(Math.floor((symbols.length * 5) / 8));
  let carry = 0;
  let bits = 0;
  let index = 0;
  for (const symbol of symbols) {
    carry = (carry << 5) | BASE32_ALPHABET.indexOf(symbol);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (carry >>> bits) & 0xff;
      index += 1;
    }
  }
  return out;
}

/**
 * A shared secret from the base32 a user typed or pasted: `base32Decode`, then
 * RFC 4226 §4 R6's 128-bit floor.
 *
 * The floor is the whole difference from the codec, and it is what an enrolment
 * route needs. `base32Decode("A")` is not an error and is not a secret: five
 * bits do not fill a byte, so it decodes to zero bytes, and a zero-length key
 * is one WebCrypto refuses rather than one it verifies. Anything that becomes
 * a stored secret comes through here.
 *
 * Throws a `TypeError` naming no part of the input, for the reason
 * `base32Decode` gives.
 */
export function parseTotpSecret(input: string): Uint8Array {
  const secret = base32Decode(input);
  if (secret.length < TOTP_MIN_SECRET_BYTES) throw secretFloorError("parseTotpSecret");
  return secret;
}

/**
 * The `otpauth://` URI an authenticator app scans, per the Key Uri Format the
 * ecosystem settled on.
 *
 * **The return value is secret material**: it carries the whole shared secret
 * in its `secret` parameter, in the shape most likely to be logged. Do not log
 * it, cache it or persist it, and put it only in a `Cache-Control: no-store`
 * response, straight to the person enrolling.
 *
 * Throws a `TypeError` on a secret below the 128-bit floor, which
 * `deriveTotpCode` would refuse to derive against: a QR code is the one place
 * an unusable secret would otherwise be committed to, since the authenticator
 * keeps it and nothing checks it again until the first code fails.
 *
 * The issuer appears twice, as the label prefix and as the `issuer` parameter,
 * because apps differ in which they read. Both halves of the label are
 * percent-encoded and joined with a literal colon, so a colon inside either
 * field arrives as `%3A` and cannot be mistaken for the separator. The
 * parameters are assembled by hand rather than through `URLSearchParams`,
 * which form-encodes a space as `+` — an authenticator would show that plus
 * sign to the user.
 */
export function totpUri(opts: { secret: Uint8Array; accountName: string; issuer: string }): string {
  if (opts.secret.length < TOTP_MIN_SECRET_BYTES) throw secretFloorError("totpUri");

  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.accountName)}`;
  const params = [
    `secret=${base32Encode(opts.secret)}`,
    `issuer=${encodeURIComponent(opts.issuer)}`,
    "algorithm=SHA1",
    `digits=${TOTP_DIGITS}`,
    `period=${TOTP_STEP_SECONDS}`,
  ].join("&");
  return `otpauth://totp/${label}?${params}`;
}

/**
 * The six-digit code for one counter value: HMAC-SHA-1 over the counter as an
 * 8-byte big-endian integer, RFC 4226 §5.3 dynamic truncation, then modulo a
 * million and zero-padded.
 *
 * Throws a `TypeError` on a counter that is not a non-negative safe integer,
 * or a secret below the 128-bit floor. Both would otherwise fail quietly:
 * `setBigUint64` wraps a negative counter modulo 2^64 and returns a plausible
 * wrong code, and WebCrypto refuses a zero-length HMAC key with a `DataError`
 * that says nothing about which argument was wrong.
 */
export async function deriveTotpCode(secret: Uint8Array, counter: number): Promise<string> {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new TypeError("deriveTotpCode: counter must be a non-negative safe integer");
  }
  if (secret.length < TOTP_MIN_SECRET_BYTES) throw secretFloorError("deriveTotpCode");

  // Copied, not passed through: it re-types the array as one backed by a plain
  // ArrayBuffer, which is what WebCrypto's BufferSource accepts, and it stops
  // the caller's buffer from being the live HMAC key.
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  const message = new ArrayBuffer(8);
  new DataView(message).setBigUint64(0, BigInt(counter), false);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));

  const offset = mac[mac.length - 1] & 0x0f;
  const truncated =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];

  return (truncated % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

/**
 * Whether `code` is valid for `secret` at `at`, allowing `window` steps of
 * clock drift either side.
 *
 * Never throws and never returns early on a match: every candidate in the
 * window is derived and every one is compared, so a valid code and an invalid
 * code of the same shape do the same work. A malformed code, an unusable
 * secret or an unusable date is `false`, not an exception — this runs behind
 * routes that take the code from an untrusted request body.
 *
 * `false` does not say which of "wrong code" and "no TOTP on this account" it
 * means, and it costs the same either way: a secret below the 128-bit floor —
 * the shape an absent credential row takes — is run against a dummy secret so
 * the answer is not faster. A code that is not six ASCII digits is rejected
 * before any of that, which reveals nothing: the caller wrote the code.
 *
 * # Caller obligations
 *
 * Two things a complete implementation needs that a stateless function cannot
 * do, so the entry point above it must:
 *
 * - **Single use.** RFC 6238 §5.2: a code accepted once must be refused for the
 *   rest of its step, per account. Record the accepted step and reject a
 *   repeat. A code that mints a session — recovery, rather than step-up —
 *   makes a replay worth an account takeover rather than a repeated ceremony,
 *   and one code is valid for a minute and a half at the default window.
 * - **Attempt throttling.** RFC 4226 §7.3 requires a throttling parameter, and
 *   the arithmetic is why: six digits over ±1 step is three acceptable codes in
 *   a million, which is even odds inside a few hundred thousand attempts and
 *   under an hour of traffic at a hundred a second. A per-IP limit alone does
 *   not do it against a rotating fleet, so every entry point that reaches here
 *   needs a per-account lockout too.
 *
 * Encrypting the secret at rest is the caller's job in the same way — see the
 * module docstring.
 */
export async function verifyTotpCode(opts: {
  secret: Uint8Array;
  code: string;
  at?: Date;
  window?: number;
}): Promise<boolean> {
  const { secret, code, at = new Date(), window = TOTP_DEFAULT_WINDOW } = opts;

  if (!SIX_ASCII_DIGITS.test(code)) return false;

  const counter = Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
  if (!Number.isSafeInteger(counter) || counter < 0) return false;

  // Clamped at both ends. The lower bound keeps a nonsensical window from
  // disabling verification silently; the upper bound keeps `window` from
  // choosing how much CPU one request spends. A NaN window collapses to the
  // current step alone rather than falling through Math.max unnoticed.
  const span = Number.isFinite(window)
    ? Math.min(TOTP_MAX_WINDOW, Math.max(0, Math.trunc(window)))
    : 0;

  const counters = Array.from({ length: span * 2 + 1 }, (_, index) =>
    Math.max(0, counter - span + index),
  );

  // A secret under the floor cannot match anything, but it is answered at full
  // price rather than returned on: see the dummy secret's own comment.
  const usable = secret.length >= TOTP_MIN_SECRET_BYTES;
  const key = usable ? secret : TOTP_DUMMY_SECRET;
  const candidates = await Promise.all(counters.map((step) => deriveTotpCode(key, step)));

  // Bitwise `|`, not `||=` or `.some`: both short-circuit, which would make
  // the number of comparisons depend on whether — and where — the code matched.
  const matched = candidates.reduce(
    (accumulated, candidate) => accumulated | (timingSafeEqualString(candidate, code) ? 1 : 0),
    0,
  );
  return usable && matched === 1;
}

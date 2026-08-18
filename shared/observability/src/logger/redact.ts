/**
 * Deny-list based redaction for log annotations and error causes.
 *
 * # Goal
 *
 * Stop secret-bearing values from leaving the process via the logger. Every
 * `Effect.log*` call routes annotations and `cause` payloads through this
 * scrubber before serialization (see `./layer.ts`), so any object key listed
 * here is replaced with `[REDACTED]` regardless of where it appears in the
 * tree.
 *
 * # When to add a key
 *
 * Add a key here when **all** of the following are true:
 *
 *   1. The name is used as an actual object property somewhere in the
 *      codebase — a DB column, a request body field, a response field, an
 *      Effect tagged-error field, an HTTP header name, etc. We do not pad
 *      this list with hypothetical secret names; if a field doesn't exist,
 *      don't pre-emptively guard it. The `osn:lint:redact-coverage` mental
 *      model is "every entry should have a `grep` hit outside this file".
 *
 *   2. Logging the value would be a security or privacy regression — auth
 *      credentials (tokens, passkey assertions), private keys, or PII that
 *      we have a policy commitment to keep out of operator-readable logs
 *      (per CLAUDE.md: `profileId` is OK; `email` and `handle` are not).
 *
 *   3. There is no safer alternative on the call site. If the call site is
 *      `Effect.annotateLogs({ email })`, prefer fixing the call site to use
 *      `profileId` instead. The deny-list is the *second* line of defence,
 *      not the first.
 *
 * Add **both** the camelCase and snake_case spelling if the field is reached
 * in both forms (Drizzle returns camelCase from the TS layer but raw column
 * names — and OAuth wire format — surface snake_case).
 *
 * # When to remove a key
 *
 * Remove a key only when the underlying field is gone from the codebase
 * (schema column dropped, route body removed, type deleted). When that
 * happens, drop the entry from this list and the matching assertion in
 * `redact.test.ts` in the same commit so the deny-list never drifts.
 *
 * # What does NOT belong here
 *
 *   - Generic identifiers like `code` or `id` — too broad, would scrub PKCE
 *     codes, event IDs, etc. The right fix is to never log the whole
 *     in-memory store entry, not to redact the field name.
 *
 *   - Speculative entries for features that haven't been built. When the
 *     Signal/E2E messaging code lands in `@zap/api`, the PR that adds
 *     `ciphertext` / `ratchetKey` / `senderKey` to a schema also adds
 *     them here. Until then, they aren't fields, so they aren't on the list.
 *
 *   - Fields whose values are public by design — `publicKey`, `credentialId`
 *     (the WebAuthn handle, not the credential bytes), avatar URLs.
 *
 * # Matching rules
 *
 * Case-insensitive on the key name. No regex — exact key match only — to
 * keep the rule auditable and avoid surprising over-redaction.
 */

export const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Case-insensitive deny-list of object keys. Each entry maps to a real
 * field that exists somewhere in the codebase as of this commit; see the
 * file header for the criteria.
 *
 * Grouped by theme; sorted within group. Each group includes a brief note
 * pointing at the call site so reviewers can confirm the entry is earning
 * its keep.
 */
export const REDACT_KEYS: ReadonlySet<string> = new Set(
  [
    // --- HTTP headers ---
    // `headers.authorization` is read in osn/core routes (graph, auth) and
    // in the shared Elysia plugin. Anything that logs a `headers` object —
    // an error log that includes the inbound request, an outbound fetch
    // trace event — must not leak the bearer token.
    "authorization",
    // `cookie` header may carry the session token in HttpOnly cookies (C3).
    "cookie",

    // --- Session cookies (C3) ---
    // The HttpOnly session cookie names — if someone logs a parsed cookie
    // object or a Set-Cookie header, the raw session token must not appear.
    "__host-osn_session",
    "osn_session",

    // --- OAuth / first-party token responses ---
    // Both spellings exist: snake_case is the OAuth wire format
    // (osn/client/src/tokens.ts → tokenResponseSchema), camelCase is the
    // post-parse `Session` type and what auth.ts response bodies return.
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "idToken",
    "id_token",
    // Enrollment token — single-use bearer returned by /register/complete
    // (osn/core/src/routes/auth.ts:225 wire; osn/core/src/services/auth.ts:498
    // service return) and sent back as `Authorization: Bearer <token>` for
    // passkey enrollment (osn/client/src/register.ts:131,142). Same secrecy
    // profile as accessToken.
    "enrollmentToken",
    "enrollment_token",
    // Recovery codes (Copenhagen Book M2). Raw codes are returned once by
    // /recovery/generate and POSTed by /login/recovery/complete; hashed codes
    // live in the recovery_codes table (osn/db/src/schema/index.ts). Both
    // plaintext and the hash are session-granting and must never appear in
    // operator logs.
    "recoveryCode",
    "recovery_code",
    "recoveryCodes",
    "recovery_codes",
    "codeHash",
    "code_hash",

    // --- Step-up (sudo) tokens ---
    // Short-lived bearer tokens minted by /step-up/*/complete and required
    // by sensitive endpoints (/recovery/generate, /account/email/*). Same
    // secrecy profile as accessToken — anyone who holds one can execute the
    // gated action inside the 5-minute window.
    "stepUpToken",
    "step_up_token",

    // --- Session metadata ---
    // `ipHash` is HMAC-peppered but still a privacy signal — operators
    // shouldn't routinely see which IP issued which session. `uaLabel` is
    // coarse ("Firefox on macOS") and not secret in itself, but listing raw
    // user-agent strings under this key would be, so we redact both spellings
    // defensively.
    "ipHash",
    "ip_hash",
    "uaLabel",
    "ua_label",

    // --- Security events (M-PK1b) ---
    // `securityEventId` is the public row id for security_events audit rows
    // (osn/db/src/schema/index.ts → securityEvents). It's low-entropy and
    // scoped to the owning account, but pairing it with `accountId` in a
    // log line would let an operator fingerprint which accounts have
    // unacknowledged events. Defensive both-spellings.
    "securityEventId",
    "security_event_id",

    // --- WebAuthn ---
    // `assertion` is the AuthenticationResponseJSON body posted to
    // /passkey/login/complete (osn/core/src/routes/auth.ts:476,607). It
    // carries clientDataJSON + signature material that should never be
    // mirrored back into logs verbatim.
    "assertion",
    // `attestation` is the RegistrationResponseJSON body posted to
    // /passkey/register/complete. Same shape / same rationale as assertion —
    // clientDataJSON + attestationObject should not land in a log line.
    "attestation",
    // User-chosen free-text nickname for a passkey
    // (osn/db/src/schema/index.ts → passkeys.label; PATCH /passkeys/:id body).
    // Labels default to "iCloud Keychain"-style model names but are editable;
    // an operator-readable log of "Mom's old iPad" is a privacy regression.
    "passkeyLabel",
    "passkey_label",

    // --- Cross-device login ---
    // `cdlSecret` is the 256-bit random value shared via QR code between
    // device A and device B during cross-device login. SHA-256 hashed at
    // rest — the plaintext must never appear in operator logs.
    "cdlSecret",
    "cdl_secret",

    // --- ARC token signing keys ---
    // `privateKey` is the parameter name on createArcToken /
    // getOrCreateArcToken (osn/crypto/src/arc.ts). If a service ever logs
    // its config object or an Effect cause referencing the key handle,
    // the key material must not show up.
    "privateKey",
    "private_key",

    // --- PII (per CLAUDE.md observability rules) ---
    // The users table (osn/db/src/schema/index.ts) holds these as actual
    // columns. Policy: log `profileId`, never `email` / `handle` /
    // `displayName`. The deny-list backstops accidental annotations.
    // (Previously `userId`; renamed to `profileId` for multi-account.)
    //
    // `accountId` is the internal auth principal. Leaking it in logs would
    // let an operator correlate two profiles belonging to the same account,
    // breaking the multi-account privacy invariant (P6 audit).
    "accountId",
    "account_id",
    // `familyId` is the session family identifier — all rotated tokens in a
    // refresh chain share this value (Copenhagen Book C2). Leaking it would
    // let an operator correlate sessions across rotation events.
    "familyId",
    "family_id",
    "email",
    "handle",
    "displayName",
    "display_name",

    // --- Cire guest PII + session credential ---
    // Cire (wedding invites) runs its own Cloudflare D1 / R2 and a guest
    // session class entirely separate from OSN auth (see
    // wiki/systems/cire-auth.md). cire/api does not yet carry
    // @shared/observability (no redacted logger) — these entries are the
    // interim guard for the day it adopts the shared logger, and for any
    // cross-service log line that mirrors a cire payload.
    //
    // `cire_session` is the guest claim-code session token (256-bit, the
    // raw value lives in the HttpOnly cookie of the same name; SHA-256
    // hashed in cire's `sessions` table). Same secrecy profile as a refresh
    // token — anyone holding it is the family.
    "cire_session",
    // Guest names — cire `guests.first_name` / `last_name` columns and the
    // RSVP request bodies. Drizzle surfaces camelCase, raw D1 columns are
    // snake_case; both spellings guarded.
    "firstName",
    "first_name",
    "lastName",
    "last_name",
    // `families.family_name` — guest household name.
    "familyName",
    "family_name",
    // `families.public_id` — the family claim CODE (e.g. SHARMA-IVY-QM42).
    // It is a credential, not a public identifier: exchanged at
    // POST /api/claim for a session. Must never appear in operator logs.
    "publicId",
    "public_id",
    // `rsvps.dietary` — free-text dietary requirements. Art. 9
    // special-category: reveals religion (halal/kosher) and health
    // (allergies/coeliac). Highest-sensitivity PII in cire.
    "dietary",
    // `guest_account_links.osn_account_id` — the OSN account principal a cire
    // guest optionally links to (resolved S2S over ARC, never sent to clients).
    // Same secrecy profile as `accountId`: pairing it with a cire household
    // (`family_name`, `public_id`) in a log line is a new cross-system privacy
    // linkage. The plain `accountId` entry above does NOT cover this — matching
    // is exact-key, not substring. `osnProfileId` is intentionally absent:
    // policy treats profile ids as loggable (see the PII note above).
    "osnAccountId",
    "osn_account_id",
  ].map((k) => k.toLowerCase()),
);

/**
 * A scrubbed log payload — what {@link redact} hands back.
 *
 * The walk below is total, so this enumerates every shape that can come out of
 * it rather than shrugging with `unknown`:
 *
 * - scalars and functions pass through untouched (`typeof !== "object"`),
 * - `Date` is preserved by identity so serializers keep its fidelity,
 * - arrays become arrays of scrubbed values,
 * - everything else — plain objects and `Error`s alike — becomes a plain
 *   record whose denied keys hold {@link REDACTION_PLACEHOLDER}.
 *
 * `RedactedFunction` is here because a function reaching a log annotation is
 * returned as-is; it is not a shape worth encouraging, just one the walk does
 * not alter.
 */
export type RedactedFunction = (...args: never[]) => void;

export type RedactedValue =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | RedactedFunction
  | readonly RedactedValue[]
  | { readonly [key: string]: RedactedValue };

/**
 * Narrow a non-object log value to the scalar half of {@link RedactedValue}.
 *
 * `typeof value !== "object"` leaves TypeScript holding `unknown`, so the
 * branches have to be spelled out. Every `typeof` result is covered, so the
 * final `return` is only reached for a value JavaScript has no type name for —
 * i.e. never.
 */
const isFunction = (value: unknown): value is RedactedFunction => typeof value === "function";

const asScalar = (value: unknown): RedactedValue => {
  // A predicate rather than a `case "function"` arm: `typeof` narrows to the
  // bare `Function` type, which carries no call signature to match on.
  if (isFunction(value)) return value;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
    case "undefined": {
      return value;
    }
    default: {
      return String(value);
    }
  }
};

/**
 * Returns a deep-copy of `value` with any keys matching the deny-list
 * replaced by `REDACTION_PLACEHOLDER`. Handles nested objects and arrays.
 * Primitives and non-object values pass through unchanged.
 *
 * Intentionally does not follow cycles — throws on cyclic input. Log
 * entries should never contain cycles; if one shows up, that's a bug.
 *
 * Fast path (P-I1): primitives return immediately without allocating
 * a new WeakSet or walking anything. Hot log paths (per-request,
 * per-metric) stay allocation-free for the common case of scalar
 * messages and annotations.
 */
export const redact = (value: unknown): RedactedValue => {
  // Primitive fast path — no allocation, no walk.
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== "object") return asScalar(value);
  if (value instanceof Date) return value;
  return redactInner(value, new WeakSet());
};

const redactInner = (value: unknown, seen: WeakSet<object>): RedactedValue => {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== "object") return asScalar(value);

  if (seen.has(value as object)) {
    throw new Error("redact: cyclic value");
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, seen));
  }

  // Preserve certain well-known objects as-is (they don't have secrets and
  // deep-copying them would lose fidelity).
  if (value instanceof Date) return value;
  if (value instanceof Error) {
    // Errors get their `message` preserved but any custom fields are
    // redacted. This covers Effect tagged errors with { _tag, cause }.
    const out: Record<string, RedactedValue> = {
      name: value.name,
      message: value.message,
    };
    // `Object.entries` reads the same own enumerable keys the old `Object.keys`
    // + index-read did; `name`/`message`/`stack` are non-enumerable, so they
    // stay out of the walk and only the two copied above survive.
    for (const [k, v] of Object.entries(value)) {
      if (REDACT_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTION_PLACEHOLDER;
      } else {
        out[k] = redactInner(v, seen);
      }
    }
    return out;
  }

  const out: Record<string, RedactedValue> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTION_PLACEHOLDER;
    } else {
      out[key] = redactInner(val, seen);
    }
  }
  return out;
};

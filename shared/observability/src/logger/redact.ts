/**
 * Deny-list based redaction for log annotations and error causes.
 *
 * Security invariant: these keys must NEVER appear in any log output.
 * Add new keys as new secret-bearing fields are introduced; never remove.
 *
 * Matching is case-insensitive on the key name only. Values are replaced
 * with a fixed string so the shape of the log entry is preserved (handy
 * when debugging why a field is empty: "oh right, we redact that").
 */

export const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Case-insensitive deny-list of object keys. Keep sorted and grouped by
 * theme. Do NOT use regex — key names must match exactly (case-insensitive)
 * to avoid accidentally matching innocent fields.
 */
export const REDACT_KEYS: ReadonlySet<string> = new Set(
  [
    // --- auth / credentials ---
    "password",
    "passwordHash",
    "password_hash",
    "otp",
    "otpCode",
    "otp_code",
    "token",
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "sessionToken",
    "session_token",
    "idToken",
    "id_token",
    "jwt",
    "authorization",
    "cookie",
    "set-cookie",
    "setCookie",
    "passkey",
    "credential",
    "assertion",

    // --- crypto keys ---
    "privateKey",
    "private_key",
    "secretKey",
    "secret_key",
    "apiKey",
    "api_key",

    // --- PII ---
    "email",
    "emailAddress",
    "email_address",
    "phone",
    "phoneNumber",
    "phone_number",
    "handle", // borderline but safer to redact in logs; use userId instead
    // User-chosen free-text name fields (S-M2) — often contain the
    // user's real name, which is PII.
    "displayName",
    "display_name",
    "firstName",
    "first_name",
    "lastName",
    "last_name",
    "fullName",
    "full_name",
    "legalName",
    "legal_name",
    "dob",
    "dateOfBirth",
    "date_of_birth",
    "address",
    "streetAddress",
    "street_address",
    "postalCode",
    "postal_code",
    "ssn",
    "taxId",
    "tax_id",

    // --- E2E encryption (Zap / Signal) ---
    "ciphertext",
    "plaintext",
    "messageBody",
    "message_body",
    "signalEnvelope",
    "signal_envelope",
    "ratchetKey",
    "ratchet_key",
    "identityKey",
    "identity_key",
    "prekey",
    "preKey",
    "senderKey",
    "sender_key",
  ].map((k) => k.toLowerCase()),
);

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
export const redact = (value: unknown): unknown => {
  // Primitive fast path — no allocation, no walk.
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value;
  return redactInner(value, new WeakSet());
};

const redactInner = (value: unknown, seen: WeakSet<object>): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

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
    const asRecord = value as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };
    for (const k of Object.keys(asRecord)) {
      if (REDACT_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTION_PLACEHOLDER;
      } else {
        out[k] = redactInner(asRecord[k], seen);
      }
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTION_PLACEHOLDER;
    } else {
      out[key] = redactInner(val, seen);
    }
  }
  return out;
};

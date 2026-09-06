# The rest of the security checklist

The sections here are the ones this repository's own review scenarios do not
exercise, so they are kept out of `SKILL.md` to hold it under the token budget
a skill is read at. They are not less important — several cover defects that
would be critical if they appeared — they are simply not the ones a diff in
this repo usually contains.

**Open this file when Step 1's routing table sends you here.** Work the section
it names one bullet at a time, exactly as you would a section in `SKILL.md`:
find the code that would carry the property, check whether it does, and record
the verdict under `## Sections checked` with the file and line you looked at.

## Password & MFA Flows

- Passwords stored with fast hashes (MD5, SHA-1, SHA-256, etc.) rather than Argon2id / Scrypt / Bcrypt
- Hash or token equality checks using `===` / `==` / string equality instead of constant-time comparison
- Login, register, password-change, or MFA-verify endpoints missing rate limiting (password hashing is a DoS vector as well as a brute-force target)
- Auth error messages that distinguish "user not found" from "wrong password", or registration/password-reset responses that reveal whether an email is registered, unless this is an intentional product decision
- TOTP/OTP verify endpoints lacking their own throttle (lockout after N failed attempts), independent of IP-based rate limiting

## WebAuthn

- Challenges that are not single-use and server-bound (accepted more than once, or not tied to server state)
- Verification code that skips checking the RP ID hash, the user-present flag, or the user-verified flag when user verification is required
- Registration flows that don't pass `excludeCredentials`, allowing the same authenticator to be registered twice

## Injection (OWASP A03)

- Raw SQL string construction outside of Drizzle ORM parameterisation
- Unsanitised user input passed to `Bun.spawn`, `exec`, or any shell-equivalent
- Template literals used to build queries or dynamic `eval`-style constructs

## Cryptography (OWASP A02)

- Use of weak algorithms: MD5, SHA-1, DES — anywhere in `@shared/crypto` or elsewhere
- SHA-256 is acceptable for hashing long random server-side tokens, but NOT for passwords — passwords must use Argon2id / Scrypt / Bcrypt
- Hardcoded secrets, API keys, or credentials committed to source files (not `.env`)
- `Math.random()` used for security-sensitive purposes (tokens, nonces, IDs)
- Modulo bias when deriving a bounded integer from random bytes (e.g. `bytes[i] % N` in verification-code or token generators) without rejection sampling or a sufficiently large source
- Message payloads that should be E2E encrypted per project spec but are stored or transmitted in plaintext

## Sensitive Data Exposure (OWASP A04)

- API responses that leak internal fields (password hashes, full user records, internal IDs beyond what the caller needs)
- A request body that reaches a service or a Drizzle call without passing a boundary schema. This repo validates twice and never mixes the two: Elysia TypeBox at the HTTP boundary, Effect Schema inside services (`wiki/architecture/schema-layers.md`). A route handler that hands `body` straight to the database is the finding
- Personally identifiable information written to logs

## Redirects

- User-controlled redirect parameters (`redirect_to`, `next`, `return_url`, etc.) reflected verbatim rather than validated against an allowlist of internal paths or known origins

## Post-Quantum Exposure

- New code that encrypts data with long-term relevance (E2E message payloads, encrypted backups, archived key material, sealed long-lived credentials) using a classical-only KEM or key agreement (X25519, ECDH, plain RSA-OAEP) without a post-quantum hybrid (e.g. ML-KEM-768 + X25519). Harvest-now-decrypt-later makes durable ciphertext the one place this matters — short-lived primitives (JWTs with minute-scale TTLs, TLS session keys, WebAuthn challenges) are explicitly out of scope

## Dependency & Supply Chain (OWASP A06)

- Dependencies that appear unusual or out of place for this codebase (flag for manual review)
- **DO NOT flag caret (`^`) or tilde (`~`) version ranges** — this project uses caret ranges for normal dependencies and tilde ranges for dependencies that don't follow semver or are known to be unstable. The lockfile pins exact versions. This is an intentional convention, not a security concern.

## Configuration

- CORS policy changes that widen allowed origins beyond what is necessary
- Secrets or API keys present in any non-`.env` file

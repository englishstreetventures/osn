Analyse the current branch diff for security concerns. $ARGUMENTS may contain a list of changed workspaces and a branch name; if not provided, derive them from `git diff --name-only main...HEAD`.

Read all changed source files in the affected workspaces and examine them for the following issues:

---

## Authentication & Authorisation (OWASP A01, A07)

- New Elysia routes missing auth middleware or guards
- Endpoints that allow a user to read/mutate another user's resources without ownership checks

## Tokens & Sessions (OWASP A07)

- New server-side tokens (session IDs, verification codes, password-reset tokens, recovery codes, CSRF tokens) generated with fewer than 112 bits of entropy from a CSPRNG — flag `Math.random`, short `randomBytes` calls, and weak encodings
- Sensitive server-side tokens (session, password-reset, recovery) stored as plaintext rather than SHA-256 hashes at rest — OSN convention is hashed storage
- Single-use tokens (email verification, password reset, recovery code, OTP step-up) where the delete is not atomic with the validation read
- New sign-in flows that reuse a pre-auth session instead of rotating to a fresh one (session fixation)
- Flows that verify/change email, change password, enrol or remove MFA, or escalate a role without revoking the user's other sessions
- Session or access tokens accepted from URL query strings or form fields (should only come from cookies or `Authorization` headers)
- New routes that embed a token in the URL path/query without setting `Referrer-Policy: strict-origin`

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
- Missing Valibot `parse()` before DB operations on user-supplied data
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
- Changes to Tauri capabilities (`src-tauri/capabilities/`) that grant broader OS permissions than needed

---

---

## Finding format

Number each finding with a short ID: `S-C1`, `S-C2`, … for Critical; `S-H1`, `S-H2`, … for High; `S-M1`, … for Medium; `S-L1`, … for Low. Increment the counter within each tier across the full report. This lets findings be referenced unambiguously (e.g. "fix S-H2 before merging").

Each finding must use this exact structure:

```
**S-H1** — <short title>
**Issue:** What the problem is, stated concisely.
**Why:** Why this is a security concern — the threat, the attack vector, or the OWASP category it falls under.
**Solution:** What was changed or what needs to be done.
**Rationale:** Why this solution correctly addresses the risk.
```

Tier definitions:
- **Critical (S-C)** — exploitable vulnerability; must be fixed before merging
- **High (S-H)** — significant risk; requires a fix or an explicit documented exception
- **Medium (S-M)** — notable concern; should be addressed soon
- **Low (S-L)** — minor issue or hardening suggestion

If no concerns are found, state that explicitly: "No security concerns found."

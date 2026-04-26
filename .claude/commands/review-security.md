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

## Compliance (GDPR, CCPA, SOC 2, DSA, COPPA, EAA, ePrivacy)

The compliance checks below are blocking concerns just like security findings. Use the `C-` prefix for compliance findings (`C-C1`, `C-H1`, `C-M1`, `C-L1`) and report them in their own section after the security findings. See `wiki/compliance/index.md` for the full programme.

### GDPR / privacy (lawful basis, minimisation, transparency)

- New columns / tables / request bodies / response payloads that capture personal data without a corresponding row in `wiki/compliance/data-map.md`. Adding a new field implies declaring purpose, lawful basis, retention, and recipients.
- New API endpoints that introduce a new processing purpose without naming the lawful basis (Art. 6(1) letter; for special-category data, Art. 9(2) letter) — flag and require documentation in the same PR.
- New code that collects data falling under GDPR Art. 9 (health, race, religion, politics, sex life or orientation, biometric, genetic, trade-union membership) without explicit consent capture or a documented Art. 9(2) basis. Pulse events whose category implies a special-category attribute count.
- New columns / data classes without an entry in `wiki/compliance/retention.md` (storage limitation — Art. 5(1)(e)).
- Code paths that prevent the user from exercising rectification (Art. 16), erasure (Art. 17), or portability (Art. 20) — e.g. data written to an immutable store with no overwrite path, or fields that the planned `GET /account/export` / `DELETE /account` endpoints cannot reach.
- New cross-DB writes (Pulse → OSN, Zap → OSN, etc.) that would orphan personal data on profile / account deletion. Either fan out the deletion via ARC or document the orphan-tolerance rationale.
- PII (email, handle, phone, IP, free-text user content) added to log annotations, span attributes, metric attributes, or error `cause` payloads without going through the redaction deny-list at `shared/observability/src/logger/redact.ts`. Reading the deny-list only catches names already on the list; verify the new field name is added to the deny-list **and** to the `redact.test.ts` assertion.
- `accountId` (or `account_id`) leaking through any new wire surface (response payload, JWT claim, log line, span attribute, metric attribute) — privacy invariant from the multi-account audit (P6).

### Subprocessors / international transfers

- New third-party SDK, npm package making outbound network calls, hosted CDN, image proxy, OAuth provider, analytics tag, geocoder, or any processor that receives personal data on our behalf — must add a row to `wiki/compliance/subprocessors.md` and confirm DPA + SCC status before merge.
- New outbound `fetch` calls to a non-OSN origin from `@pulse/api`, `@osn/api`, `@zap/api`, or any frontend — flag and require justification (vendor row + lawful basis).
- Any change that routes user data outside the EU/EEA without an SCC, adequacy decision, or DTIA on file. Cloudflare (US), Grafana Labs (US), and planned Supabase US-region all need this — flag any new feature that increases the volume of user data flowing to them without revisiting [[subprocessors]].
- New CDN script tags / SRI-less external scripts (also covered under WebAuthn S-L10 pattern). ePrivacy-relevant — third-party scripts on the landing site flip us into "consent required".

### CCPA / state privacy

- New "selling" or "sharing" surface (advertising network, cross-context behavioural ad pixel, third-party data partner) that inverts our current "no sell, no share" declaration. Even a single integration requires the "Do Not Sell or Share" link and rebuild of the privacy notice.
- New code paths that ignore the `Sec-GPC: 1` header / planned consent middleware. Once GPC recognition lands (C-L7), every CCPA-scoped data flow must consult it.

### COPPA

- New registration / onboarding surface that does not check the age gate. Currently the gate is planned (C-H8); until it lands, every new field collected at registration must be gated behind it once shipped.
- New marketing copy, illustration, mascot, advertising, or feature whose tone reads as targeted at under-13 users — flag immediately. We rely on the "general audience" defense.
- Code that ingests data from a user we have actual knowledge is under 13 — terminate flow, do not persist.

### DSA (UGC moderation)

- New user-generated-content surface (Pulse event titles / descriptions / images, Zap message bodies, organisation profile bios, custom event categories) without a corresponding `POST /reports` Art. 16 notice path AND a `moderation_actions` audit row when content is restricted. Statement of reasons (Art. 17) is mandatory for every restriction.
- Moderation actions (post removal, account suspension, demotion, RSVP rejection by host, organisation handle revocation) executed without writing a `moderation_actions` audit row + emailing the affected user a structured statement of reasons.
- New algorithmic-ranking code (Pulse discovery, friend recommendation, event "for you", Zap inbox sort) without an updated recommender-transparency disclosure in the ToS draft (`wiki/compliance/legal-drafts/tos.md`).
- New trader-facing surface (Zap M3 organisation chats, organisation creation in `@osn/api`) that does not capture Art. 30 trader-traceability fields (name, address, phone, email, registration ID, self-declaration of compliance) before allowing consumer interaction.

### SOC 2 (CC6 access, CC7 ops, CC8 change, CC9 mitigation)

- New production-touching code path that logs an admin action (operator querying / modifying user data) without writing an `admin_actions` audit row (planned C-M16). All operator data access must be attributable, logged, and reviewable.
- New service that does not carry the `@shared/observability/elysia` plugin (RED metrics, request ID, `/health`, `/ready`, redacted logs) — CC4 monitoring + CC7 system operations.
- New third-party dependency added without a documented decision (changeset note acceptable). Surfaces SCA / supply-chain risk that the planned CI dep-scan (C-M7) will catch.
- Changes to GitHub branch protection, codeowners, required status checks, or CI hooks — change-management evidence (CC8). Flag and require named reviewer.
- Changes to access mechanisms — new role, new bearer-token type, new step-up gate, new ARC scope, new admin endpoint — without a corresponding update to `wiki/compliance/access-control.md` or the planned quarterly matrix.
- Changes to backup, restore, or DR-relevant code (database connection pooling, batch jobs, sweepers) — A1 availability evidence; flag for [[backup-dr]] cross-reference.

### EAA / accessibility

- New interactive UI without keyboard reachability (no `tabIndex` story, custom `<div onClick>` instead of `<button>`, missing focus visibility).
- Form inputs without programmatic labels (placeholder-only, missing `<label htmlFor>` or `aria-label`).
- Colour as the only state cue — Pulse event status, Zap unread badge, error vs warning copy.
- Missing alt text on images (event covers, avatars, attachment thumbnails).
- New media (video, audio, voice note) without caption / transcript track.
- Custom ARIA where a Kobalte primitive would do — Kobalte is the accessible default; bespoke ARIA usually means we have invented an inaccessible widget.

### Pre-merge compliance gates

When the PR introduces any of the following, the compliance checklist must be explicit in the review:

- [ ] New personal-data field → `wiki/compliance/data-map.md` row added
- [ ] New retention-relevant field → `wiki/compliance/retention.md` row added
- [ ] New third-party processor → `wiki/compliance/subprocessors.md` row added; DPA / SCC noted
- [ ] New consent-based processing → consent-record table updated (or scaffold task filed if first one)
- [ ] New UGC surface → notice-and-action endpoint coverage confirmed; statement-of-reasons path confirmed
- [ ] New algorithmic-ranking surface → recommender disclosure updated in ToS draft
- [ ] New age-gate-bypassing data collection → flagged explicitly
- [ ] New high-risk processing (special-category, large-scale, vulnerable groups, novel tech) → DPIA filed under `wiki/compliance/dpia/`
- [ ] New outbound `fetch` to non-OSN origin → vendor row + lawful basis confirmed

---

## Finding format

Number each finding with a short ID: `S-C1`, `S-C2`, … for Critical; `S-H1`, `S-H2`, … for High; `S-M1`, … for Medium; `S-L1`, … for Low. Compliance findings use the `C-` prefix (`C-C1`, `C-H1`, `C-M1`, `C-L1`) and are reported in their own section after security findings. Increment the counter within each tier across the full report. This lets findings be referenced unambiguously (e.g. "fix S-H2 before merging" or "address C-M3 before deploying").

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

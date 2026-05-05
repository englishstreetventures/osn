Analyse the current branch diff for security concerns. $ARGUMENTS may contain affected paths and a branch name; if not provided, derive from `git diff --name-only main...HEAD`.

Read all changed source files in the affected areas and examine for:

---

## Authentication & Authorisation (OWASP A01)

- New Hono routes missing auth middleware
- Endpoints that allow a guest to access another guest's records (missing ownership checks on RSVP, invite data, session)
- Admin endpoints accessible with guest-level sessions
- Passkey credential not scoped to the correct guest record
- Magic link tokens that are not single-use or that don't expire (max 15 min)
- Session/token leakage in logs or error response bodies
- Claim code endpoint not rate-limited (brute force risk)

---

## Cryptography (OWASP A02)

- Weak algorithms in use: MD5, SHA1, DES
- Hardcoded secrets, API keys, or Cloudflare binding values (should be in wrangler secrets or `.dev.vars`, never committed)
- Claim codes or magic link tokens generated with `Math.random()` instead of `crypto.getRandomValues()`
- WebAuthn challenge generation not using cryptographically secure randomness
- Insecure random number generation where cryptographic randomness is required

---

## Injection (OWASP A03)

- Raw SQL string construction outside of Drizzle parameterisation
- Template literals or string interpolation used to build D1 queries
- Unsanitised user input passed to Cloudflare bindings or Worker environment

---

## Sensitive Data Exposure (OWASP A04)

- API responses returning guest list data to unauthenticated requests
- Invite endpoint exposing other guests' names, RSVPs, email addresses, or claim codes
- Guest PII (name, email, mobile) written to logs
- Missing input validation before D1 operations on user-supplied data
- API error responses leaking internal details (stack traces, DB schema, binding names)

---

## Dependencies (OWASP A06)

- Unpinned dependencies with no lockfile entry
- Unusual or suspicious dependency additions
- Note: caret/tilde ranges are intentional convention — do not flag range style

---

## Logging & Observability (OWASP A09)

- PII fields (email, tokens, passwords) written to logs without redaction
- `console.*` calls in backend code (bypasses structured logger)
- Missing error logging on failure paths (silent failures)
- Secret values (API keys, claim codes, session tokens) in log context

---

## Configuration

- CORS policy changes that allow arbitrary origins to call the Hono API
- Secrets present in non-wrangler-secrets files (e.g. committed `.env`, hardcoded in `wrangler.toml`)
- Cloudflare Worker route patterns that expose unintended paths
- Cloudflare binding values committed in non-secrets locations

---

Report findings with these labels:

- **Critical** — exploitable vulnerability; must fix before pushing
- **High** — significant risk requiring fix or explicit exception
- **Medium** — notable concern to address soon
- **Low** — minor issue or hardening suggestion

If no concerns are found, state: "No security concerns found."

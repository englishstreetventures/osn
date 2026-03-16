Analyse the current branch diff for security concerns. $ARGUMENTS may contain a list of changed workspaces and a branch name; if not provided, derive them from `git diff --name-only main...HEAD`.

Read all changed source files in the affected workspaces and examine them for the following issues:

---

## Authentication & Authorisation (OWASP A01, A07)

- New Elysia routes missing auth middleware or guards
- Endpoints that allow a user to read/mutate another user's resources without ownership checks
- JWT or session token handling issues (missing expiry, insecure storage, token leakage in logs)

## Injection (OWASP A03)

- Raw SQL string construction outside of Drizzle ORM parameterisation
- Unsanitised user input passed to `Bun.spawn`, `exec`, or any shell-equivalent
- Template literals used to build queries or dynamic `eval`-style constructs

## Cryptography (OWASP A02)

- Use of weak algorithms: MD5, SHA1, DES — anywhere in `packages/crypto` or elsewhere
- Hardcoded secrets, API keys, or credentials committed to source files (not `.env`)
- `Math.random()` used for security-sensitive purposes (tokens, nonces, IDs)
- Message payloads that should be E2E encrypted per project spec but are stored or transmitted in plaintext

## Sensitive Data Exposure (OWASP A04)

- API responses that leak internal fields (password hashes, full user records, internal IDs beyond what the caller needs)
- Missing Valibot `parse()` before DB operations on user-supplied data
- Personally identifiable information written to logs

## Dependency & Supply Chain (OWASP A06)

- New dependencies added without pinned versions (prefer exact versions or locked ranges)
- Dependencies that appear unusual or out of place for this codebase (flag for manual review)

## Configuration

- CORS policy changes that widen allowed origins beyond what is necessary
- Secrets or API keys present in any non-`.env` file
- Changes to Tauri capabilities (`src-tauri/capabilities/`) that grant broader OS permissions than needed

---

Report findings as a prioritised list using these labels:

- **Critical** — exploitable vulnerability that must be fixed before merging
- **High** — significant risk requiring a fix or explicit documented exception
- **Medium** — notable concern that should be addressed soon
- **Low** — minor issue or hardening suggestion

If no concerns are found, state that explicitly: "No security concerns found."

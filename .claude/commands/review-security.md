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

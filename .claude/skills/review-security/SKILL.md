---
name: review-security
description: Use when reviewing a branch diff for security concerns — auth, tokens and sessions, injection, secrets, cookies, CSP and third-party content — and reporting findings with S-C/H/M/L IDs in the four-field format.
---

Review the current branch diff for security and compliance defects.

`$ARGUMENTS` may name the changed workspaces and the branch. Whether or not it does, start from the diff.

## Step 0 — Write the report skeleton before you review anything

Do this before the diff, before reading a line of source. The file is the
deliverable: a run that leaves a differently-shaped file has produced nothing,
however good the analysis inside it. Writing the shape now means the rest of the
run only fills it in. Leaving it until the end is how a section goes missing.

Copy this verbatim. The report file is `SECURITY-REVIEW.md` unless the task
named another:

```bash
cat > SECURITY-REVIEW.md <<'EOF'
## Security findings

None

## Compliance findings

None

## Coverage

None

## Sections checked

None
EOF
```

Those four `##` headings are the whole permitted set, and that is their order.
Each keeps its name exactly — `## Findings` is not `## Security findings`.
Replace a `None` as you fill its section in; leave it where the section really
is empty. Never add a fifth `##`. The ones that get invented are `## Summary`,
`## Verified strengths`, `## Scope and method`, `## Verdict` and `## Bottom
line`, and none of them is allowed: a summary sentence goes at the top of
`## Security findings`, a control you checked and found sound goes on its line
in `## Coverage` or `## Sections checked`, and an environment caveat goes at the
end of `## Sections checked`.

**From here on this file is only ever edited, never rewritten.** Every later
change replaces a `None`, or inserts text under a heading that already exists.
Do not compose the report in your head and write it out whole at the end — a
single write to `SECURITY-REVIEW.md` discards the shape this step just
established, and that is the one way this run fails outright however good the
analysis is. If you find yourself about to write the whole file, you have lost
the skeleton: read it back first and edit what is there.

**A finding is a bold label, not a heading.** ``S-H1`` goes on its own line as
bold text inside `## Security findings`, exactly as **Finding format** shows below.
Promoting it to `## S-H1` adds a top-level section, and a run whose findings
each became a heading fails the shape check with four correct sections still
sitting in the file. The same goes for `## Summary`, `## Filing notes` and
anything else the analysis suggests along the way.

What each section holds is under **Report shape** at the end of this file.

## Step 1 — Route the diff

Resolve the base branch first. A stacked branch does not merge into `main`, and diffing against `main` reports the parent branch's files as this branch's:

```bash
BASE=$(git config --get branch.$(git branch --show-current).gh-merge-base || echo main)
git diff --name-only "$BASE"...HEAD
```

Keep that file list. Every file on it gets a verdict in the report, including the ones you clear.

Now grep the diff for the strings below. **A hit makes the named section mandatory**: work every bullet in it against the whole changed file the hit landed in, not the matched line, and record the verdict under `## Sections checked`. A section nothing matched is optional.

Routing widens attention; it never narrows it. **A grep hit is a reason to open a section, never a reason to stop reading.** Some patterns fire on ordinary code — `${` on any template literal, `consent` on this repo's social-graph gate. When every hit in a section is that kind, write one line under `## Sections checked` naming what matched and why it does not apply. Never satisfy a bullet with code the branch did not touch.

```bash
git diff "$BASE"...HEAD | grep -nE '<pattern>'
```

| Grep the diff for | Sections that become mandatory |
|---|---|
| `document.cookie`, `Set-Cookie`, `setCookie`, `cookie.set`, `__Host-`, `SameSite`, `max-age` (grep `-i`, the header spells it `Max-Age=` and the option `maxAge`) | Cookies |
| `consent`, `revoke`, `withdraw`, `optOut`, `denied`, `granted` | Cookies, Compliance → subprocessors |
| `<script`, `<iframe`, `src="https://`, `googletagmanager`, `maps.googleapis`, `pinterest` | Cookies, Compliance → subprocessors, Configuration (references) |
| `randomBytes`, `Math.random`, `crypto.getRandomValues`, `.toString(36)`, `%` (a modulo applied to random bytes biases the output) | Tokens & Sessions, Cryptography (references) |
| `` sql` ``, `${`, `Bun.spawn`, `exec(`, `LIKE` | Injection (references) |
| `redirect`, `return_url`, `next=`, `location.href =` | Redirects (references) |
| a new `Dialog`, `onClick`, `role=`, `aria-`, `<img` | Compliance → EAA / accessibility |
| `new Elysia(`, `.derive(`, `onBeforeHandle`, `session`, `jwt`, `verify`, `requireAuth`, `ownership` | Auth & Authorisation, Tokens & Sessions |
| two or more exported handlers over the same resource in one file — `send`/`list`, `create`/`delete`, `add`/`remove`, or a name and the same name with a suffix (`sendMessage` beside `sendC2bMessage`) | Auth & Authorisation — the sibling-verb comparison below is mandatory |

## Step 2 — Work the mandatory sections

Read every changed source file in full, then take each mandatory section one bullet at a time. A bullet names a property the code is supposed to have: find the code that would carry that property, and check whether it does. A bullet you cannot tie to any line of the diff is cleared. A bullet whose code you found and whose property is missing is a finding — write it up before moving to the next bullet, or you will lose it.

**Check the shape once, as soon as the first finding is in the file.** Not at the
end — by then a clobbered skeleton has cost the whole run, and the same two
counts that catch it later catch it here for one command:

```bash
grep -c '^## \(Security findings\|Compliance findings\|Coverage\|Sections checked\)$' SECURITY-REVIEW.md
```

It must print `4`. If it prints less, the skeleton from Step 0 was overwritten
rather than edited: restore the 4 headings, put the finding back under the right
one, and edit from then on.

The sections below are the checklists. Sections nothing routed to are still worth a skim, but the routed ones are not optional.

**A comment is a claim, not a control.** A block explaining why a cookie is safe,
why a token is single-use, or why an input needs no validation is the author's
intent. The control is the code. Read the code the comment describes and decide
from that — a reassuring comment over a missing check is the worst case in this
file, and a `TODO` beside a control that is present is not a finding at all.
The same applies in reverse: **do not report a name.** `CONSENT_COOKIE_NAME`
existing is not proof it is the name that gets written; follow it to the write.

---

## Authentication & Authorisation (OWASP A01, A07)

- New Elysia routes missing auth middleware or guards
- Endpoints that allow a user to read/mutate another user's resources without ownership checks
- **A predicate enforced on one verb and not on its sibling on the same resource.** This is not found by reading a handler; it is found by comparing handlers. Do it as a step, not as a glance:

  1. List every exported function in each changed service and route file — `grep -n '^export const\|^export function' <file>`.
  2. Group them by the resource they read or write: every function that touches `messages`, every function that touches `chat_members`.
  3. For each group, write down what each member checks before it touches the row — the membership check, the ownership check, and **every read of a discriminator column**: `class`, `role`, `status`, `kind`, `visibility`, `state`.
  4. A check that appears in some members of a group and not in others is a finding, and the defect is the **absence**, not the presence. Name the sibling that enforces it: that sibling is the proof the check was meant to apply, and a reviewer who reads only the unguarded handler cannot see it.

  Where exactly one member of a group runs a check nobody else runs, ask what that column is for and which of the group's other members the answer implicates. An asymmetry the code explains — a public read beside an owner-only write — is not a finding; say so on its line rather than reporting it. Put the group table in `## Sections checked`.

## Tokens & Sessions (OWASP A07)

- New server-side tokens (session IDs, verification codes, password-reset tokens, recovery codes, CSRF tokens) generated with fewer than 112 bits of entropy from a CSPRNG — flag `Math.random`, short `randomBytes` calls, and weak encodings
- Sensitive server-side tokens (session, password-reset, recovery) stored as plaintext rather than SHA-256 hashes at rest — OSN convention is hashed storage
- Single-use tokens (email verification, password reset, recovery code, OTP step-up) where the delete is not atomic with the validation read
- New sign-in flows that reuse a pre-auth session instead of rotating to a fresh one (session fixation)
- Flows that verify/change email, change password, enrol or remove MFA, or escalate a role without revoking the user's other sessions
- Session or access tokens accepted from URL query strings or form fields (should only come from cookies or `Authorization` headers)
- New routes that embed a token in the URL path/query without setting `Referrer-Policy: strict-origin`
### Every JWT verification call: tabulate its options

Do this as a step, not as a glance. `jose` and every library like it validate
what you name and silently skip what you do not, so a verifier's security is
decided entirely by the options object — and the options object is the one part
a reviewer reading the wrapper never sees.

For each `jwtVerify`, `verify(` or equivalent in the diff, open the call, read
the literal options object, and write a row per claim into `## Sections
checked`: the claim, whether it is **required to be present**, and whether its
**value is pinned**. Then apply these three:

1. **`exp` absent from `requiredClaims` is a finding.** `jose` checks `exp` only
   when the token carries one. A token minted with no `exp` therefore verifies
   for as long as the signing key lives, and nothing downstream looks at age.
   Passing `clockTolerance`, `maxTokenAge` on some other path, or a short TTL at
   the *issuer* does not close it — the verifier is the control. The remedy is
   `requiredClaims: ["exp"]` on this call.
2. **A claim applied conditionally is a claim not enforced.** `if (issuer)
   options.issuer = issuer`, `...(aud && { audience: aud })`, a default of `""`
   or `undefined` — each turns a missing or empty config value into "no check"
   instead of a startup failure. With `iss` off, any token signed by a key the
   configured JWKS serves is accepted whoever minted it, which is the only thing
   separating one deployment tier's tokens from another's. Report the
   conditional itself, and say that an empty string must be a configuration
   error rather than a silent opt-out.
3. **A comment arguing for the gap does not close it.** These files carry
   rollout-safety notes explaining why a check is optional today. That is
   context for the tier, not enforcement; see the rule at the top of Step 2.

## Cookies

- **Every cookie the diff sets: check the prefix.** Find each `Set-Cookie`, `setCookie`, or `cookie.set` call. A cookie that stores a user's decision or identity (consent record, session, preference) must have a name starting `__Host-`. Without that prefix, a script on any sibling origin under the same registrable domain can set a `Domain`-scoped cookie of the same name that shadows the one this app wrote, and the guest's stored refusal silently becomes someone else's value. `Secure`, `HttpOnly` and `SameSite` do not close this — a shadowing cookie satisfies all three. `__Host-` implies `Secure`, host-only and `Path=/`, so the shadow cannot be written at all
- **Then check its dev fallback.** The `__Host-` prefix is rejected over plain `http`, so a hardcoded `__Host-` name drops the cookie entirely on `http://localhost`. The name must fall back to the unprefixed form when the origin is not HTTPS
- Missing `SameSite`, `Secure`, or `HttpOnly` on a cookie that carries authentication or a stored decision
- **Every grant the diff honours: find its teardown.** For each place a granted category causes something to load — an embed, a script tag, an iframe, an observer, a listener — find the code that runs when that grant is withdrawn. Search `revoke`, `withdraw`, `denied`, `onCleanup`, and the falsy branch of the same condition that mounted it. Code that only prevents *further* loading is not teardown: whatever an earlier grant already mounted keeps its network access and its cookies until the next reload, so the withdrawal does not take effect. No unmount path is a finding

## The rest of the checklist

Nine more sections live in `references/checklists.md`: **Password & MFA Flows**,
**WebAuthn**, **Injection**, **Cryptography**, **Sensitive Data Exposure**,
**Redirects**, **Post-Quantum Exposure**, **Dependency & Supply Chain**, and
**Configuration**. They are there rather than here because no scenario in this
repository's eval suite exercises them, not because they matter less — open the
file whenever Step 1 routes to one of them, and work it exactly as you would a
section on this page.

Two of those bullets are worth carrying in your head, because they are the ones
most often got wrong in this repo. **Do not report a caret (`^`) or tilde (`~`)
version range as a finding** — the lockfile pins exact versions and
`minimumReleaseAge` in `bunfig.toml` is the real control against a hostile
publish; the ranges are convention. And **a request body reaching a service or
a Drizzle call without passing a boundary schema is a finding**: this repo
validates twice and never mixes the two, Elysia TypeBox at the HTTP boundary and
Effect Schema inside services.

---

## Compliance (GDPR, CCPA, SOC 2, DSA, COPPA, EAA, ePrivacy)

Compliance defects block a merge exactly as security defects do. Use the `C-` prefix (`C-C1`, `C-H1`, `C-M1`, `C-L1`) and report them in their own section after the security findings. See `wiki/compliance/index.md` for the full programme.

The two classes below are checked on every review, because the Step 1 routing sends third-party content and new UI straight to them. GDPR data-mapping, CCPA, COPPA, DSA and SOC 2 live in `references/compliance.md` — read that file when the diff adds a column, a table, a request body, an endpoint, a moderation action, a ranking surface, or an operator-facing code path.

### Subprocessors / international transfers

- New third-party SDK, npm package making outbound network calls, hosted CDN, image proxy, OAuth provider, analytics tag, geocoder, or any processor that receives personal data on our behalf — needs a row in `wiki/compliance/subprocessors.md`, with a DPA on file and a transfer basis named, before merge.

  **Open the file and look the vendor up; do not assume the row is missing.** A vendor this repo already uses usually has one, and the finding is then not "add a row" — it is which of the row's cells are still open. The DPA and SCC columns carry `TODO` markers for vendors nobody has signed with yet, and a `TODO` there against a third party the branch causes to load for real users is the compliance finding, stated as that. Reporting a row as absent when it is present is a false positive and costs the review its credibility on the ones that are genuinely missing.
- New outbound `fetch` calls to a non-OSN origin from `@pulse/api`, `@osn/api`, `@zap/api`, or any frontend — flag and require justification (vendor row + lawful basis).
- Any change that routes user data outside the EU/EEA without an SCC, adequacy decision, or DTIA on file. Cloudflare (US), Grafana Labs (US), and planned Supabase US-region all need this — flag any new feature that increases the volume of user data flowing to them without revisiting [[subprocessors]].
- New CDN script tags / SRI-less external scripts. ePrivacy-relevant — third-party scripts on the landing site flip us into "consent required".

### EAA / accessibility

Every piece of new interactive UI in the diff gets three checks and a line in
the report saying which it passed: **a keyboard path** (reachable and visibly
focused, not a `<div onClick>` where a `<button>` belongs), **a programmatic
label** (`<label htmlFor>` or `aria-label`, never placeholder-only), and **a
state cue that is not colour alone**. Images need alt text, media needs
captions, and a bespoke ARIA widget where a Kobalte primitive exists is usually
an inaccessible widget we invented. File gaps as `C-`.

Whichever of those applies, **say so explicitly in the report**: a gate nobody
mentions reads as a gate nobody ran. A new personal-data field also wants a row
in `wiki/compliance/data-map.md`, and in `wiki/compliance/retention.md` if it is
retention-relevant.

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

Tiers: **S-C** exploitable now and blocks the merge, **S-H** significant risk
wanting a fix or a documented exception, **S-M** notable, **S-L** minor or
hardening.

If no concerns are found, state that explicitly: "No security concerns found."

**A control that is absent is a finding.** Do not downgrade one to a note, an observation, or a "consideration" because exploiting it needs a precondition — an attacker on a sibling origin, a shared machine, a user who revokes mid-session. The precondition is the threat model, not a reason the defect is not there. Rate it `S-L` if the precondition is expensive to reach; do not omit it, and do not describe a missing control as acceptable because the rest of the code is careful.

---

## Report shape

The file already exists — Step 0 wrote it, with the four sections in order.
Keep that. This section says what goes in each one.

`## Security findings` and `## Compliance findings` hold the findings in the
format above, `S-` IDs in the first and `C-` IDs in the second, most severe
first.

`## Coverage` lists **every file** from the Step 1 diff, one line each, with a verdict — a finding ID, `clear`, or `not source` (lockfiles, generated output, fixtures). A file you did not open is not clear; say so and why.

`## Sections checked` lists each mandatory section and, under it, each bullet with the code you looked at and the verdict. This is what catches a skim: a bullet with no file and line beside it was not checked.

### Check the file before you finish

The same two counts as Step 2's mid-run check, run once more on the finished
file:

```bash
grep -c '^## \(Security findings\|Compliance findings\|Coverage\|Sections checked\)$' <report-file>
grep -c '^## ' <report-file>
```

Both must print `4`. Under 4 means a heading was renamed or demoted; over 4
means a section of your own crept in — a summary sentence belongs at the top of
`## Security findings`, a sound control on its line in `## Coverage`, an
environment caveat at the end of `## Sections checked`.

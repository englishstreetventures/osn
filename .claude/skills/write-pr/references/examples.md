# A pull-request body, before and after

Reference for the `write-pr` skill. Copy the shape, not the words. The branch is made up, and so are its issue numbers; tracker numbers are left as `<n>`.

The branch: `fix/cire-api-claim-hardening`. Three commits — guest sessions cut from 30 days to 14 (`a1b2c3d`), organisers can resend an invite to a household that has not replied (`b2c3d4e`), and a review fix putting the resend route under the existing invite limiter (`e4f5a6b`). The resend link is signed with a new secret that production needs before it deploys. It fixes public issue #9101 and one tracker finding, is one of five children of epic #9001, and its review filed a second finding it does not fix. The owner was not around to ask whether to split it.

## Before

What an agent wrote from `prep-pr`'s old Step 8, cut to the parts that went wrong:

```markdown
## Summary

This branch makes two unrelated changes to the cire API. Organisers can now resend an invite to a household that has not replied, and a guest session now lasts 14 days after a claim, not 30. The resend link is signed with a new secret, `INVITE_RESEND_KEY`, which production needs before it deploys.

- **Set the secret before you approve the production deploy.** Run `bunx wrangler secret put INVITE_RESEND_KEY --env production` for the `cire-api` Worker. Until it is set, every resend returns 500.

## Issues

**Closes**

| Issue | What |
|---|---|
| #9101 | Cire: let organisers resend an invite to households that have not replied |
| englishstventures/osn-tracker#<n> | `S-M2` |

Closes #9101
Closes englishstventures/osn-tracker#<n>

**Opened**

| Issue | What |
|---|---|
| englishstventures/osn#9102 | Cire: show organisers when a resent invite was opened |
| englishstventures/osn-tracker#<n> | `S-M1` |

## Decisions

### Guest sessions last 14 days — `S-M2`

- **Issue** — A guest session lasted 30 days from the claim.
- **Why** — A session that outlasts its use stays open on any shared or lost device.

### A claim code from another wedding is not accepted — dismissed

- **Issue** — Review asked whether the claim route could accept a code issued for a different wedding.
- **Why** — If it could, a guest of one wedding could claim a place in another.

**Out of scope**

- englishstventures/osn-tracker#<n> — S-M1
- englishstventures/osn#9102

## Test plan

| Gate | Command | Result |
|---|---|---|
| Tests | `bun run --cwd cire/api test` | 414 pass, 0 fail, run on the last commit, `e4f5a6b` |
| D1 tier | `bun run test:d1` | not run |
```

## After

The same branch under `write-pr`. Title: `Cire API: organisers resend invites to households yet to reply`.

```markdown
**At deploy** — set `INVITE_RESEND_KEY` on the `cire-api` Worker before approving the production deploy: `bunx wrangler secret put INVITE_RESEND_KEY --env production`. Until it is set, every resend returns 500.

## Summary

Organisers can resend an invite to a household that has not replied. The resend link is signed with a new secret and runs under the limiter every other invite route uses. Guest sessions now last 14 days after a claim.

## Workspaces affected

`@cire/api`, patch, in `.changeset/quiet-owls-sing.md`. `scripts/changeset-required.sh` printed `required`, and `scripts/validate-changesets.sh` printed `ok`.

## Issues

Closes #9101
Closes englishstreetventures/osn-tracker#<n>

Part of #9001

**Raised against this branch**

- #9102 — Cire: show organisers when a resent invite was opened
- englishstreetventures/osn-tracker#<n>

## Decisions

### One pull request for two unrelated changes — owner's call

- **Issue** — The session change and the resend feature share a package and nothing else.
- **Why** — Unrelated changes in one pull request are harder to review and to revert.
- **Solution** — Both stay here; the owner was not there to ask.
- **Rationale** — The session change is its own commit, `a1b2c3d`. To split, move that commit to its own branch; this one keeps the resend work and nothing else changes.

### Resend runs under the existing invite limiter

- **Issue** — The new resend route sent mail with no cap.
- **Why** — Without one, a household can be mailed again and again.
- **Solution** — The route uses the invite limiter the other invite routes use (`e4f5a6b`).
- **Rationale** — One limiter for every invite route; a second would be one more setting to keep in step.

**Out of scope** — None.

## Test plan

| Gate | Command | Commit | Result |
|---|---|---|---|
| cire-api tests | `bun run --cwd cire/api test` | `e4f5a6b` | 414 pass, 0 fail |
| Lint | `bun run lint` | `b2c3d4e` | 0 errors, 3 warnings (existing, `tools/lab`); not re-run after `e4f5a6b`, which changes `cire/api/src/routes/invites.ts` |
| Type check | `bun run check` | — | NOT RUN — lefthook runs it on push |
| D1 tier | `bun run test:d1` | — | NOT RUN — no reason was recorded; run it before merging if the resend route writes to D1 |

Unverified: nobody has sent a resend on the dev tier. Once this merges, resend an invite there and check the email arrives and its link opens.
```

What changed:

- **The secret moved above `## Summary`.** It was a bullet under the prose, where the owner reads it after deciding the pull request looks fine.
- **The tracker finding is a bare reference everywhere.** No `S-M2` or `S-M1`, no decision headed by a finding ID, and the Summary says what the code now does ("Guest sessions now last 14 days") without saying what was wrong with 30.
- **The dismissed concern left the body.** Naming a cross-wedding claim the review thought of, even to say it is safe, tells a reader where to look. `prep-pr` Step 7 files it in the tracker and closes it as not planned.
- **Each close appears once**, under the right organisation name, with the epic as `Part of` so the merge leaves it open.
- **The issue raised against this branch is listed once**, not under Opened and again under Out of scope.
- **The test plan has a `Commit` column**, and the lint row says what the later commit left unproven. The D1 row says why it did not run — here, that nobody recorded a reason, which is itself the honest answer.

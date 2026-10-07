# Issue bodies, good and rewritten

Reference for the `write-issue` skill. Copy the shape, not the words.

## A bug

Filed as `--type Bug`, `product:osn-core`, rated through `rate-complexity`, added to the Project.

```markdown
**What** — `osn/api/tests/services/recovery-session.test.ts`, the test "a rotation late in the window mints a token that dies with the row" (around line 514), fails now and then.

**Evidence** — `AssertionError: expected 29 to be 30`, on CI run 37626054251 for PR #1417, which does not touch `osn/api`.

**Why** — `auth.issueRecoverySession(...)` stamps the session's deadline from the real clock. The test then switches to fake timers and reads `Date.now()` a few milliseconds later. When those milliseconds cross a whole-second boundary, the remaining lifetime in whole seconds is 29, not 30. Every unrelated pull request that hits it pays for a re-run.

**Fix** — freeze the clock before issuing: `vi.useFakeTimers({ toFake: ["Date"] })` and `vi.setSystemTime(base)` before `issueRecoverySession`, then `vi.setSystemTime(base + (RECOVERY_SESSION_TTL_SEC - remaining) * 1000)` before `refreshTokens`. Check the neighbouring test for the same pattern.

**Done when** — the test reads the clock only under fake timers, and `bun run --cwd osn/api test:run -- -t "rotation late in the window"` passes 200 runs in a row.
```

What makes it work: the error is quoted, the cause is explained down to the second boundary, the fix names the calls, and **Done when** is a check that fails today.

## A feature body, rewritten

Before — one of thirty bodies in the same batch, most of them sharing the last two paragraphs word for word:

```markdown
## What

Let hosts define meal options per event and attending guests choose one independently of restrictions.

## Why

Caterers need meal counts as well as allergy and dietary notes.

## Done when

- Meal choices reference stable event option ids and stay distinct from dietary consent/answers.
- Selections work for named plus-ones and organiser-recorded replies.

## Dependencies and related work

No new subsystem dependency.

## Constraints and documentation

For database changes, keep migrations, `cire/db/src/schema.ts` and `cire/api/src/db/setup.ts` aligned. Update the relevant wiki page …

## Sequencing

Planned wave: 2. This is backlog order, not a delivery estimate.
```

After:

```markdown
**What** — Let an organiser set meal options for each event, and let each attending guest pick one when they reply. Meal choice is stored apart from dietary requirements, which `cire/db/src/schema.ts:1002` already holds. Part of #1385.

**Why** — Organisers have no way to ask "chicken or fish". Today they ask in the free-text dietary note, read every reply, and count by hand before sending the caterer a number. A guest who changes their reply leaves that count wrong with no warning.

**Done when**
- An organiser adds, renames and removes meal options on an event in the host portal.
- A guest replying "attending", including a named plus-one and a reply the organiser records by phone, picks exactly one option.
- The catering export lists event, guest, meal choice and the dietary note the guest consented to share; declined guests are not counted.
- Removing an option that guests already chose lists those guests for the organiser to follow up; nobody is moved to another meal silently.

**Notes** — Dietary data sits behind the consent rules in `wiki/cire/cire-consent.md`; meal choice gets its own fields so that it neither leaks through them nor is blocked by them. No pricing per meal, and no orders sent to caterers. #1404 builds per-event custom questions and may share storage with this.
```

What changed: the boilerplate went to the parent epic, the empty sections went, **Why** names who does what by hand, the slash shorthand became words, and each **Done when** line is something a reviewer can try and see fail.

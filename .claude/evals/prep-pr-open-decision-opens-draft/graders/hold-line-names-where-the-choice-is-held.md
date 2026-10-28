---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is the pull-request body. The branch `feat/rsvp-digest-subject-count` makes the RSVP change digest's subject in `shared/email/src/templates/rsvp-digest.ts` lead with the household count (`4 households changed their RSVP for Ama & Jonah` in place of `RSVP changes for Ama & Jonah`), with matching test assertions and a correct `@shared/email` patch changeset. It was cut for public issue #9131, which is open, carries `needs:decision`, and puts two options to the owner: (A) lead the subject with the count, recommended, which the branch builds; (B) keep the subject and put the count in the email's preview text. Nobody has answered and there is no one to ask, and the answer decides what merges, so the pull request waits on the owner and opens as a draft.

PASS if the `**Do not merge until**` line in `## Impact` names where the choice is held: issue #9131, or the `— open, for the owner` decision below, or both.

FAIL if there is no such line in Impact, or it does not say where the choice is held.

FAIL also if the file is missing or empty.

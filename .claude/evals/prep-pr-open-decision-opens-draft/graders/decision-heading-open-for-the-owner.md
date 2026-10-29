---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is the pull-request body. The branch `feat/rsvp-digest-subject-count` makes the RSVP change digest's subject in `shared/email/src/templates/rsvp-digest.ts` lead with the household count (`4 households changed their RSVP for Ama & Jonah` in place of `RSVP changes for Ama & Jonah`), with matching test assertions and a correct `@shared/email` patch changeset. It was cut for public issue #9131, which is open, carries `needs:decision`, and puts two options to the owner: (A) lead the subject with the count, recommended, which the branch builds; (B) keep the subject and put the count in the email's preview text. Nobody has answered and there is no one to ask, and the answer decides what merges, so the pull request waits on the owner and opens as a draft. A heading ending `— owner's call` is for a default the run took and the owner can overrule; it does not fit a choice the issue put to the owner.

PASS if the subject choice sits under a `###` heading in `## Decisions` ending `— open, for the owner` (a plain hyphen for the dash is fine).

FAIL if the heading ends `— owner's call`, has neither ending, or the choice has no heading.

FAIL also if the file is missing or empty.

---
type: llm
weight: 2
focus: { source: file, path: PREP-PR-REPORT.md }
---

The file is the pre-PR report. The branch `feat/rsvp-digest-subject-count` makes the RSVP change digest's subject in `shared/email/src/templates/rsvp-digest.ts` lead with the household count (`4 households changed their RSVP for Ama & Jonah` in place of `RSVP changes for Ama & Jonah`), with matching test assertions and a correct `@shared/email` patch changeset. It was cut for public issue #9131, which is open, carries `needs:decision`, and puts two options to the owner: (A) lead the subject with the count, recommended, which the branch builds; (B) keep the subject and put the count in the email's preview text. Nobody has answered and there is no one to ask, and the answer decides what merges, so the pull request waits on the owner and opens as a draft.

PASS if the report says the pull request would open as a draft and gives the reason: the `needs:decision` proposal on #9131 is unanswered and the owner's choice decides what merges.

FAIL if it would open ready for review, says nothing about draft or ready, claims the pull request was opened, gives no reason, or gives only a reason prep-pr rules out (a CODEOWNERS path, an `— owner's call` default, unfinished work).

FAIL also if the file is missing or empty.

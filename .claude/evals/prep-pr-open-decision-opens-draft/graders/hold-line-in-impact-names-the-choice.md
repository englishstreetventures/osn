---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is the pull-request body. The branch `feat/rsvp-digest-subject-count` makes the RSVP change digest's subject in `shared/email/src/templates/rsvp-digest.ts` lead with the household count (`4 households changed their RSVP for Ama & Jonah` in place of `RSVP changes for Ama & Jonah`), with matching test assertions and a correct `@shared/email` patch changeset. It was cut for public issue #9131, which is open, carries `needs:decision`, and puts two options to the owner: (A) lead the subject with the count, recommended, which the branch builds; (B) keep the subject and put the count in the email's preview text. Nobody has answered and there is no one to ask, and the answer decides what merges, so the pull request waits on the owner and opens as a draft.

PASS if `## Impact` holds a line that starts `**Do not merge until**` and names what the owner has to choose (the digest's subject), and no `**Do not merge until**` line anywhere names, points at or describes a tracker issue (`osn-tracker`) or a finding.

FAIL if there is no such line in Impact, the bold lead-in does not start its line, the line does not name the choice, or any such line names a tracker issue or a finding.

FAIL also if the file is missing or empty.

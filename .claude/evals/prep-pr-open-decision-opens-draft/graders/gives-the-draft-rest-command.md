---
type: llm
weight: 1
focus: { source: file, path: PREP-PR-REPORT.md }
---

The file is the pre-PR report. The branch `feat/rsvp-digest-subject-count` makes the RSVP change digest's subject in `shared/email/src/templates/rsvp-digest.ts` lead with the household count (`4 households changed their RSVP for Ama & Jonah` in place of `RSVP changes for Ama & Jonah`), with matching test assertions and a correct `@shared/email` patch changeset. It was cut for public issue #9131, which is open, carries `needs:decision`, and puts two options to the owner: (A) lead the subject with the count, recommended, which the branch builds; (B) keep the subject and put the count in the email's preview text. Nobody has answered and there is no one to ask, and the answer decides what merges, so the pull request waits on the owner and opens as a draft. The command that opens it is `write-pr`'s REST call, `gh api repos/englishstreetventures/osn/pulls` with `-f title`, `-f head`, `-f base=main`, `-F body=@PR-BODY.md` and `-F draft=true`.

PASS if the report gives that REST command with `-F draft=true`, as the command that would open the pull request, and does not claim it was run.

FAIL if the command is `gh pr create --draft`, lacks `-F draft=true`, is missing, or is reported as run.

FAIL also if the file is missing or empty.

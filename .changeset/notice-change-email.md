---
"@shared/email": minor
"@osn/db": minor
"@osn/api": minor
"@shared/infra": patch
"@musubi/infra": patch
---

osn-api can mail a change notice — a privacy notice or the terms are changing, what changes, the day it takes effect, a link to the page — to every account that can still sign in or restore, when the operator runs `send-change-notice` in the production operator workflow.

`@shared/email` adds the `change-notice` template, a legal notice with no unsubscribe link or header, and `sendKeyedBatch`: one batch of at most 100 in one Resend call, under an idempotency key and in permissive validation, answering how many addresses Resend accepted and refused. `EmailError` carries Resend's HTTP status and error name when Resend answered.

`@osn/db` adds `change_notice_runs`: per notice, a cursor and the batch in hand, so a run that stops half way resumes without skipping or repeating anyone. It stores no address.

`@osn/api` adds `POST /internal/change-notices/:noticeId/send`, behind its own optional secret, `OSN_CHANGE_NOTICE_SECRET` (off while unset or under 32 characters). It sends only notices in the reviewed registry `services/change-notices.json`, which ships empty, refuses unless the notice's words match the digest the approver saw, and answers counts only. Metrics `osn.change_notice.batches` and `osn.change_notice.emails`.

`@shared/infra` lists `OSN_CHANGE_NOTICE_SECRET` as an optional osn-api production secret; `@musubi/infra`'s parity and read checks name it, and `OSN_CHANGE_NOTICES_FILE`, as unset on dev.

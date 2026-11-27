---
title: Change notices
tags: [systems, runbook, email, compliance]
related:
  - "[[email]]"
  - "[[identity-model]]"
  - "[[account-deletion]]"
  - "[[data-map]]"
  - "[[subprocessors]]"
  - "[[production-deploy]]"
  - "[[free-tier-limits]]"
  - "[[dsar]]"
last-reviewed: 2026-11-27
---

# Change notices

A change notice tells every account holder that a page they agreed to — the
privacy notice or the terms — is changing: what changes, the day it takes
effect, and where to read it. osn-api sends it, one batch at a time, when the
operator runs the `send-change-notice` action of the production operator
workflow. Nothing else sends it, and nothing sends it on its own.

| Piece | Where |
|---|---|
| The email | `change-notice` in `@shared/email` ([`change-notice.ts`](../../shared/email/src/templates/change-notice.ts)) |
| The notices it may send | [`change-notices.json`](../../osn/api/src/services/change-notices.json), parsed by [`change-notice-registry.ts`](../../osn/api/src/services/change-notice-registry.ts) |
| The run | `POST /internal/change-notices/:noticeId/send` ([`routes/change-notices.ts`](../../osn/api/src/routes/change-notices.ts), [`services/change-notices.ts`](../../osn/api/src/services/change-notices.ts)) |
| Its state | `change_notice_runs`, one row per notice ([`schema`](../../osn/db/src/schema/index.ts)) |
| The operator's side | `check-notice` and `send-change-notice` in [`production-operator.ts`](../../scripts/production-operator.ts), run by [`production-operator.yml`](../../.github/workflows/production-operator.yml) |

## A legal notice, not marketing

The email carries the notice and nothing else, and it has no unsubscribe link
and no `List-Unsubscribe` header. A controller must tell the people whose data
it holds about a fundamental change to how it uses it, in a way they will
notice (GDPR Art. 12 and 13), and a change to consumer terms may not bind
someone who was never told. The rules on marketing email (ePrivacy, PECR) cover
marketing, which this is not. An unsubscribe would let a person opt out of
being told how their data is used, which the law does not allow for. A notice
that also promoted something would be marketing, and would need the consent
those rules ask for: keep it to the notice.

## Who gets it

Every account created a minute or more before the run started, except those
under a processing restriction:

| Account | Mailed? | Why |
|---|---|---|
| Active | Yes, once | |
| Inside its 7-day deletion window (`accounts.deleted_at` set) | Yes, once | It can still restore |
| Under a processing restriction (`accounts.processing_restricted_at` set) | No; counted `skipped` | Art. 18(2) allows little beyond storage. Nothing sets the column today |
| Erased | Never | Its row is gone; one erased during a run, before its batch, is never mailed |
| Created less than a minute before the run started, or after | No | It signed up under the page already live: release the page change before the run. The minute keeps a sign-up that took its time before it committed out of a batch already claimed |
| An address that hard-bounced or complained before | Accepted, never delivered | osn keeps no bounce record. Resend puts such an address on its team-wide suppression list and drops later sends to it; the run counts it sent |
| An address Resend refuses on its own | No; counted `failed` | The batch goes in permissive validation, so Resend refuses that one address and sends the rest |

One account is one address and one message, however many profiles it holds.

People cire holds who have no osn account are not reached: guests, whose
addresses organisers import, and the contacts of unclaimed directory listings.
A notice is sent from osn-api's address (`Musubi <hello@musubi.social>`) to
every osn account, so a notice about Cire alone would also reach people who
only use Musubi.

A notice is also written for Musubi. Its subject reads "Changes to the Musubi
`<document>`", it says it goes to everyone with a Musubi account, its way out is
deleting the Musubi account, and its link is the notice's `path` on Musubi's
app origin ([`routes/change-notices.ts`](../../osn/api/src/routes/change-notices.ts),
[`change-notice.ts`](../../shared/email/src/templates/change-notice.ts)). So a
notice about Cire's terms cannot link to cireweddings.com, name Cire as the
service, or point to "Remove my Cire data", and one about Pulse's terms cannot
link to Pulse or name it.

## What the pages promise

Four pages say that a change that matters is emailed to the reader's Musubi
account before it takes effect, saying what changes and from what day, and that
the page's date changes:

| Page | Section |
|---|---|
| Musubi's privacy notice ([`PrivacyPage.tsx`](../../musubi/social/src/pages/PrivacyPage.tsx)) | "Changes" |
| Musubi's terms ([`TermsPage.tsx`](../../musubi/social/src/pages/TermsPage.tsx)) | "Changes to these terms" |
| Cire's terms ([`terms.astro`](../../cire/landing/src/pages/terms.astro)) | "Changes to these terms", for those who use Cire with a Musubi account |
| Pulse's terms ([`terms.tsx`](../../pulse/web/src/routes/terms.tsx)) | "Changes", for those who use Pulse with a Musubi account |

Cire's guest notice ([`guest-privacy-notice.astro`](../../cire/ui/src/guest-privacy-notice.astro))
promises no email: guests hold no account. It says only that the page and its
date change. Cire's hosts' and vendors' notices and Pulse's privacy notice have
no section on changes. `musubi/social/tests/legal-pages.test.ts`,
`cire/landing/tests/legal-pages.test.ts`, `cire/ui/tests/guest-privacy-notice.test.ts`
and `pulse/web/tests/routes/legal-pages.test.ts` pin these sentences.

The promise is kept by the operator, not by the code: nothing sends on its own,
and only the check job reads the day, when the action is dispatched. A change
that matters is sent, and the run finished, before the day it takes effect
([[#Sending a change notice]]).

## Resuming without skipping or repeating

A run walks `accounts` in id order. Its row holds a cursor, the last account a
confirmed batch covered, and the batch in hand: an idempotency key, the highest
account id the batch covers, and how many sends under the key were begun and
how many were refused. Resend sends nothing twice under one key for 24 hours.

- The cursor passes an account only after Resend accepted a batch holding it,
  or refused its address on its own.
- A key is dropped without that only when every send under it was refused,
  which sends nothing. A send that timed out, failed in transit, got a 5xx or
  was cut off never counts as refused, so the next call sends the same batch
  under the same key and Resend delivers it once.
- What the route cannot know it will not guess: Resend answering 409
  `invalid_idempotent_request` (the key carried another payload — an address
  changed, an account was erased, or a release changed the wording since an
  unconfirmed send), a key older than 23 hours with a send not refused, or a
  batch that holds more accounts when retried than when it was claimed. The
  batch becomes `unconfirmed`, and the route answers 409 `unconfirmed_batch`
  with its count until the operator dispatches with `resend_unconfirmed`, which
  sends it again under a new key. Some in it may then get the notice twice.
- Each write that moves the run names the state it read, so two calls at once
  cannot both claim a batch, both send a retry or both move the cursor.

The finished row keeps the notice id, the start and finish and the counts, as
the record that the notice went out. `cursor` and the batch columns hold an
account id only while a run lasts, a stalled one included, and are cleared when
it finishes. No address is stored.

## Limits

Per call: one Resend request, under 10 D1 statements, one render of the email
for the whole batch, and at most 100 addresses. Workers Free allows 50
external subrequests and 50 D1 queries an invocation, so a call fits the dev
tier; production runs Workers Paid ([[free-tier-limits]]). The operator waits a
second between accepted batches: one request a second of Resend's 10 a second
per team, which every email shares (resend.com/docs/api-reference/rate-limit).

Resend's quota is shared too, with every sign-in, recovery and step-up email:
on the Free plan, 100 a day and 3,000 a month (resend.com/pricing). `max_sends`
caps the addresses one run sends; choose it inside the quota left after a
day's sign-in mail, and dispatch again on later days to go on.

A whole run reads each account about once. A dry run reads every account
once more: `accounts` has no index on `created_at` or on the restriction, and
it counts the skipped ones over the whole audience.

*Unverified — the per-call CPU time has not been measured on a Worker.*

## Sending a change notice

1. **Change the page, and add the notice, in one pull request.** Add an entry
   to `osn/api/src/services/change-notices.json`:

   ```json
   {
     "privacy-2027-01": {
       "document": "privacy notice",
       "path": "/privacy",
       "takesEffect": "2027-01-01",
       "changes": ["We now keep sign-in records for 12 months, not 6."]
     }
   }
   ```

   `document` is what the page is called, lower case; `path` is the page on
   Musubi's app origin; `takesEffect` is the day, in UTC; `changes` holds 1 to
   8 lines of plain words. The owner reads the words in the pull request. A new
   purpose needs the notice before the processing starts (Art. 13(3)), so leave
   time between the send and `takesEffect`; the check job warns under 30 days.
   The page's own date shows only when it changed, so the changed page also
   says the day its changes take effect.
2. **Release osn-api** with the page and the notice. The check job reads the
   notice at the commit production osn-api runs, so a notice only on `main`
   is refused.
3. **Set the secret, once.** The route answers 501 until
   `OSN_CHANGE_NOTICE_SECRET`, at least 32 characters, is on the production
   osn-api Worker. Set the same value as a `production` Environment secret
   (`gh secret set OSN_CHANGE_NOTICE_SECRET --repo englishstreetventures/osn --env production`,
   from `openssl rand -base64 32`), then dispatch `set-osn-api-secret.yml` with
   that name. Only the Worker and that Environment hold it.
4. **Dry run.**

   ```fish
   gh workflow run production-operator.yml --repo englishstreetventures/osn --ref main -f action=send-change-notice -f notice_id=privacy-2027-01 -f dry_run=true -f max_sends=1
   ```

   The check job shows the notice in full and its digest; approve the
   `production` Environment, and the run prints how many accounts it would
   reach, how many it skips, and how many were sent so far. Nothing is sent.
5. **Send.** Dispatch again with `-f dry_run=false -f max_sends=<n>`, read the
   check job's notice, and approve. Each batch prints its counts. The run stops
   when the notice has reached everyone, at `max_sends`, or on a refusal it
   cannot wait out; dispatch again to go on from where it stopped.

   Finish before the day the notice takes effect, which the pages promise
   ([[#What the pages promise]]). Only the check job reads the day: it refuses
   a notice whose day has passed, so a run still unfinished then cannot go on,
   and the accounts it has not reached are never mailed. The send job and the
   route do not read it, so approve each dispatch before that day too, or the
   email announces a change already made. Plan `max_sends` and the days of
   quota left ([[#Limits]]) against `takesEffect`.

| The run stops with | What to do |
|---|---|
| `max_sends reached` | Dispatch again, the next day if the quota is the reason |
| 429 four times | Resend's rate limit or quota. Dispatch again after it resets |
| `unconfirmed_batch` and a count | Resend cannot say whether that batch went. Dispatch with `-f resend_unconfirmed=true` to send it again, accepting that some in it may get the notice twice |
| `pending_exceeds_limit` | The batch in hand is larger than `max_sends` allows: dispatch with `max_sends` at least that large |
| `notice_changed`, or the commit moved | A release changed what production holds since the check job read it. Dispatch again and read the new notice |
| 503 or `busy` three times | Dispatch again within 23 hours: the batch in hand is retried under its key |
| 501 | `OSN_CHANGE_NOTICE_SECRET` is unset on the Worker, or shorter than 32 characters |
| 401 | The Environment's secret is not the Worker's |
| 502 `refused` | Resend refused the batch outright. osn-api's log line `change notice batch not sent` holds the status |

Two cautions. Do not rotate `RESEND_API_KEY` during a run: whether an
idempotency key survives a new API key is not documented. And a burst to every
account goes from the address that carries sign-in codes, so a high bounce or
complaint rate could make Resend pause the team; a separate sending address is
the owner's choice to make before a large send.

Locally, `bun run dev` mails through the in-memory recorder, which has no keyed
batches, so the route answers 501. The E2E suite runs the route against its
mail stand-in with a registry of its own (`OSN_CHANGE_NOTICES_FILE`, which only
osn-api's Bun entry reads, and only while `OSN_ENV` is local): see
`tools/e2e/tests/flows/musubi-change-notice.flow.ts`.

## Observability

The run logs `change notice batch sent`, `change notice batch not sent`,
`change notice batch unconfirmed` and `change notice run finished`, with the
notice id, counts and Resend's status; never an address or an account id.
Metrics: `osn.change_notice.batches` by `result` (`sent`, `rate_limited`,
`refused`, `unknown`, `busy`, `unconfirmed`), and `osn.change_notice.emails` by
`outcome` (`accepted`, `refused`). Spans: `change_notice.send` and
`change_notice.dry_run`, with Resend's `email.send_keyed_batch` inside.

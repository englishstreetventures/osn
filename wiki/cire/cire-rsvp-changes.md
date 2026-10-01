---
title: Cire RSVP changes — change log, daily digest, unseen feed
tags: [systems, cire, rsvp, email, organiser]
related:
  - "[[cire]]"
  - "[[cire-auth]]"
  - "[[cire-organiser]]"
  - "[[cire-rsvp-deadline]]"
  - "[[email]]"
  - "[[retention]]"
  - "[[free-tier-limits]]"
last-reviewed: 2026-10-01
---
# RSVP changes

Organisers hear when guests change their RSVPs in three ways, all fed by one table:

| Surface | Who sees it | What it shows |
|---|---|---|
| **Overview card** "RSVP changes since your last visit" | Every role that reads RSVPs: owner, editor, viewer (not helper) | How many households changed a reply since this organiser last opened the RSVP table, the latest five by name, a link to the table |
| **"New" badge** in the RSVP table | Same | The rows the guest changed since this organiser last opened the table |
| **Daily digest email** | The owner and every editor co-host (a hired planner included), unless they turned it off for that wedding | Counts per kind of change since their last digest, and a link to the RSVP page. No names |

Read state and the email switch are **per organiser, per wedding**: one co-host opening the table never clears another's badges.

## What counts as a change

Only guest-side writes. `POST /api/rsvp` compares each guest×event pair with its stored reply and writes one row per pair that is:

| Kind | Meaning |
|---|---|
| `reply_new` | The pair had no stored reply |
| `reply_edited` | Its status, dietary text or dietary picks differ (picks compared in stored, canonical order) |
| `plus_one_added`, `plus_one_renamed`, `plus_one_removed` | Written by the guest's own plus-one writes, with no event. **Nothing writes these yet** — see below |

An identical re-submit writes nothing, and a pair named twice in one body is judged once, from its last entry. `POST /api/rsvp` sits behind the same per-IP limiter as the other guest writes (20 a minute, `defaultRsvpLimiter` in `cire/api/src/app.ts`), since each submit can add up to 200 rows to the log. A reply an organiser records (`PUT …/guests/:guestId/rsvps/:eventId`) is never logged. The log stores ids, the kind and the time; dietary content is compared in the route and never stored.

The change row rides the reply's own batch, after the upserts and before the read-back (`rsvpService.submitRsvpsAndList`). Up to 49 pairs that is one atomic batch. Past that the upserts fill earlier batches of 50 and the change row rides the last, so a failure there loses the log entry but never invents one for a reply that did not land.

### Plus-ones

A plus-one is a `guests` row once the plus-one work lands. Its own replies go through `POST /api/rsvp` and are logged like anyone's. The three `plus_one_*` kinds need one call in the guest plus-one write — `buildRecordStatement` from `cire/api/src/services/rsvp-changes.ts`, with `eventId: null` and the inviter's guest id — which is englishstventures/osn#1258. The feed, badges and email already word all three kinds.

## Storage — migration 0068

`rsvp_changes`: `seq INTEGER PRIMARY KEY AUTOINCREMENT`, `wedding_id` and `family_id` (both cascade), `guest_id`, `event_id` (both plain text, no foreign key), `kind`, `created_at`.

- `seq` is the cursor every reader keeps. It is **AUTOINCREMENT** so a number is never reused after the newest rows are cascaded away — a reused number would sit at or below a cursor and read as seen. The DDL lockstep test cannot see AUTOINCREMENT (it reads `PRAGMA table_info`), so `cire/api/tests/db/rsvp-changes-seq.test.ts` pins it on the migration and the test DDL.
- `guest_id` has no foreign key on purpose: a removed guest's change stays under their household until the row ages out, and `plus_one_removed` names a row that is gone by design.
- Indexes: `(wedding_id)` — every index entry ends in the rowid, so `wedding_id = ? AND seq > ?` is a range on it (pinned by an `EXPLAIN QUERY PLAN` test); `(created_at)` for the digest look-back and the purge; `(family_id)` for the cascade.
- The whole change set is **one** `INSERT … SELECT … FROM json_each(?)` statement with one bound parameter, so a 200-pair RSVP stays under D1's 100-parameter cap ([[d1-limits]]).

`host_rsvp_notices`: primary key `(wedding_id, osn_profile_id)`; `seen_seq` (the feed cursor), `digest_seq` (the last change mailed), `digest_enabled` (default on), `updated_at`. No row reads as "nothing seen, digest on". Removing a co-host deletes their row in the same batch as the seat.

## API

| Route | Gate | Does |
|---|---|---|
| `GET /api/organiser/weddings/:weddingId/rsvp-changes` | `weddingMember` | The caller's unseen changes (newest first, at most 500 rows read, `truncated` past that), the latest five households, the changed rows for badges, and `digest: { available, enabled }`. `no-store` |
| `POST …/rsvp-changes/seen` `{ seq }` | `weddingMember` | Moves the caller's `seen_seq` to `seq`, clamped to the wedding's newest change and never backwards |
| `PUT …/rsvp-changes/digest` `{ enabled }` | `weddingEditor` | The caller's own digest switch. Turning it back on moves `digest_seq` to the newest change, so the next email covers what happens from then |

`digest.available` is `decideCapability(role, "editor")` — the portal shows the switch without deciding anything from a role itself. The seen POST sits behind the read gate because it writes only the caller's own row. The read and write routes are sibling Elysia instances so the two gates never share a chain.

## The portal

The Overview card (`cire/host/src/components/RsvpChangesCard.tsx`) fetches on its own and renders nothing when it cannot, so a failed read never holds up the Overview. Reading the card does not mark anything seen; **opening the RSVP table does**. `RsvpView` reads the feed beside `/rsvps`, badges the rows, and once both have loaded posts `seen` with the newest change it was shown. The badges stay for that visit. A change with no event (the plus-one kinds) badges every row of that guest.

## The daily digest

Runs in the 04:00 UTC cron (`scheduled` in `cire/api/src/index.ts`), only when osn-api can be asked for addresses (the ARC key) and Resend is configured — the same rule as the gift summary, because a log stand-in would move markers past changes nobody was told about. From `hello@cireweddings.com`, template `rsvp-change-digest` ([[email]]).

1. Weddings with a change in the last 7 days, with each one's newest `seq` and time. The query groups on `+wedding_id` so SQLite ranges over `rsvp_changes_created_at_idx` instead of walking the whole 90-day log through the wedding index (pinned by an `EXPLAIN QUERY PLAN` test).
2. The owner and co-hosts of those weddings, and their notice rows. A recipient is anyone whose role has the `editor` capability, whose digest is on, and whose `digest_seq` is behind. A co-host with no notice row yet is owed only what changed after their seat was created, so a seat removed and added again does not start over with the whole window.
3. Up to 100 recipients are chosen **one wedding at a time, round the weddings** — weddings in order of their longest-waiting recipient, each wedding's recipients oldest marker first. No wedding can fill a run while another waits. The rest are `deferred` and go first next run.
4. The changes past the chosen recipients' markers, grouped by household and kind.
5. One osn-api lookup (`POST /internal/accounts/emails`, scope `account:email-read`, through `createOrganiserEmailLookupFromEnv`). The lookup says whether osn-api **answered**: if any call failed, nobody is mailed, no marker moves, and the next run asks again. An id missing from an answer has no address, and that recipient's marker moves.
6. One Resend batch call for every email (`EmailService.sendBatch`, `POST /emails/batch`, up to 100), all or nothing. A sent batch moves each recipient's marker to the newest change it covered; a failed one moves none, so the next run includes them.
7. One upsert moves every marker (never backwards, never touching the switch), and writes a row only for someone who still owns the wedding or holds a seat on it.

**Stopping it without signing in.** When cire-api has both `CIRE_API_ORIGIN` and `CIRE_OIDC_CLIENT_SECRET`, each email links `GET /api/rsvp-digest/stop?t=<token>` and names the same URL in `List-Unsubscribe` / `List-Unsubscribe-Post` (RFC 8058), so a mail client can offer one-click unsubscribe. Without either, the email carries neither and the route answers 503.

- The token (`cire/api/src/lib/digest-stop.ts`) is the wedding id and the recipient's profile id with an HMAC-SHA256 over them. Its key is derived by HKDF from `CIRE_OIDC_CLIENT_SECRET` under its own `info`, derived once per cron run. It does not expire; rotating the client secret voids every link already sent.
- `GET` only shows a page asking to confirm, because mail scanners fetch every link. Its button, and a mail client's one-click call, `POST` to the same URL, which turns that person's digest off (`rsvpChangeService.setDigest`) — only while they hold a seat with the `editor` capability, so a link from before a seat was removed writes nothing. The page reads the same either way.
- Mounted before the origin guard (a one-click POST has no `Origin`), behind its own per-IP limiter (30/min). Pages are fixed HTML with `no-store`, `no-referrer` and a CSP that allows no script.
- Anyone who holds the token can do exactly one thing: turn that one digest off. It sits in the email at Resend, and in Workers request logs (7 days) once used. Each use logs `rsvp digest stop` with `outcome` (`stopped`, `no_seat`, `invalid`) and never the token.

A run ends with one `rsvp digest run complete` log line carrying the counts — the only signal that reaches production, since cire metrics are a no-op on workerd ([[cire-workerd]]).

**Budget.** The cron is one invocation shared by every sweep, on Workers Free: 10 ms CPU, 50 external subrequests, 50 D1 queries ([[free-tier-limits]]). The digest costs six D1 queries whatever the recipient count, and two external subrequests (one lookup, one batch) for up to 100 organisers. The retention sweep's gift-summary emails share the same 50.

*Unverified — the digest's CPU time on workerd has not been measured; no deployed run exists yet.*

The portal link is the tier's organiser origin (`organiserOriginFrom` in `cire/api/src/lib/organiser-origin.ts`: the second entry of `WEB_ORIGIN`) plus `#/w/<weddingId>/guests/rsvps`. The top-level local config lists one origin, so a local cron run would link to production; it never mails locally, because local dev has no Resend key.

**What the email says.** Counts only — "4 households changed their RSVPs for Ama & Jonah since our last email", then "3 households replied", "1 household changed their reply" — the link, and how to turn it off. One household can make more than one kind of change, so the lead count is not the sum of the lines. No household or guest name, no attendance, no dietary data: those stay in the portal, on Cloudflare. Naming households is an open decision (englishstventures/osn#1259) that first needs the guest privacy notice, the guest-data DPIA and the Resend DPA to cover it.

**The cursor is one counter for every wedding.** `seq` is a single AUTOINCREMENT, so the `markSeq` and `seenSeq` a member reads rise with RSVP changes on every wedding, and an organiser could estimate how busy cire is. That is accepted: it says nothing about any other wedding, its guests or its organisers, and a per-wedding cursor would need a second counter kept in step with every insert.

## Retention

The guest privacy notice (`cire/invites/src/pages/privacy.astro`) names the record and its window. Change rows are deleted **90 days** after they are written (`rsvpChangeService.sweepExpired`, daily cron), and go with their household or wedding before that — so the 1-year guest-data sweep reaches them. Notice rows go with the seat or the wedding. An OSN account deletion does not reach `wedding_hosts`, so a deleted account's notice row lasts as long as its seat. See [[retention]] and [[data-map]].

## Related

- [[cire-auth]] — the roles matrix the three routes sit in
- [[cire-rsvp-deadline]] — after the deadline guests cannot write, so no new changes are logged
- [[email]] — the template catalogue

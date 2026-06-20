---
"@cire/api": patch
"@cire/db": patch
"@cire/organiser": patch
---

Host-customisable invite copy message (per wedding): a host can OPTIONALLY
override the first line of the message an organiser copies from the Guests tab to
send a household. The copied message now uses a consistent THREE-LINE shape
(cleaner pasted into WhatsApp/SMS) for both the default and the override:

```
{message}
{guestSiteUrl}
{familyCode}
```

Line 1 is the host's custom message if set, else the built-in default prose; line
2 is the path-routed guest-site URL (always carrying the wedding slug); line 3 is
the family's claim code.

- `@cire/db`: new nullable `wedding_invite_customisations.invite_message` text
  column + forward-only D1 migration `0023_invite_message.sql`
  (`ALTER TABLE … ADD invite_message text`). NULL ⇒ the default message;
  additive + self-backfilling. LOCKSTEP mirror updated in
  `cire/api/src/db/setup.ts` (the `db/schema.test.ts` mini-mirror doesn't include
  this table, so it's unchanged).
- `@cire/api`: `inviteMessage` threaded through the invite-customisation GET
  (organiser read only — never exposed on the guest public read) and the
  `PUT …/invite/text` save. Validated in `schemas/invite.ts` as an optional,
  nullable free-text string capped at 600 chars; trimmed and empty/whitespace
  collapsed to NULL by the service. Copied as plain text, never rendered as HTML.
- `@cire/organiser`: an optional multi-line "Invite message" field in the Invite
  builder (saved via the existing text PUT), and `buildInviteMessage` now emits
  the 3-line shape, with `GuestTable` reading the wedding's override to seed
  line 1.

---
"@osn/api": minor
"@osn/db": minor
"@osn/client": minor
"@shared/email": minor
"@shared/observability": patch
"@tools/lab": patch
"@osn/auth-ui": minor
"@shared/design-tokens": minor
"@shared/ui": minor
---

Account deletion gets its emails and the calls its screens need.

- `@shared/email`: five templates — `account-deletion-scheduled`, `account-deletion-cancelled`, `account-deleted`, `organisation-ownership-received` and `account-data-link`. Text another party wrote is escaped and never in a subject; every one names an organisation by its handle only. Every template draws its button through one helper, `emailButton`: the recovery, step-up and email-change links' buttons take 6px corners at the text's own weight, as every other button already did.
- `@osn/api`: `DELETE /account` mails the scheduled notice (the date, how to keep the account and download the data, and what each answer does, from the request's own preview); `POST /account/restore` mails the cancelled one. The hard delete reads the address, the held handles and what each app kept before its batch, and once the batch has removed the account mails the old address and each organisation's new owner, side by side, each send giving up after 10 seconds (at most 10 ownership notices one by one on a transport with no batch send); a pass whose batch removed nothing mails nothing. The cron and the local sweeper provide the email transport to it; local sweeps run on the app's runtime and skip a tick while a pass runs. New `POST /account/data-link` mails the account a link to its download page (per IP, then three a day per account). New `POST /organisations/:handle/decline-ownership`: a member who received an organisation by succession may hand it back within 30 days; it passes on as the hard delete would pass it, or is deleted, and the decliner leaves it in the same batch, the next owner mailed. `GET` on the same path answers whether the caller may decline it, and until when, with the same refusals, and writes nothing. `removeMember` and `deleteOrganisation` write only while the caller still owns the organisation. The deletion preview's organisation actions carry `candidates`, the members a successor answer may name, read beside the organisations at most 50 an organisation. CORS exposes `Content-Disposition` and `Retry-After`. The local Bun server keys its per-address limiters on a sent `cf-connecting-ip` when `OSN_E2E_CLIENT_ADDRESS=1`, which only the E2E stack sets.
- `@osn/db`: `organisations.owner_inherited_at` (migration `20261116094005_organisation_owner_inherited_at`), NULL for every existing row.
- `@osn/client`: a 401 after a renewal that minted a pending-deletion token reaches the caller and ends nothing; `onSessionChange` gains `pending-deletion`; `isPendingDeletionToken`. The Solid provider gains `pendingDeletion` and `renewSession`, and lists no profiles for a pending-deletion session. `deleteAccount` throws `AccountDeletionRefusedError` with the open actions, fresh preview or refused action; new `exportAccount`, `sendDataLink`, `declineOwnership` and `declineOwnershipStatus`.
- `@shared/observability`: `OrgAction` gains `decline_ownership`; the auth rate-limit endpoint union gains `account_data_link`.
- `@tools/lab`: the auth-ui stories' hand-built auth contexts carry `pendingDeletion` and `renewSession`.
- `@shared/design-tokens`: a contract colour, `--ui-choice-edge`, for the edge of an unchosen radio, checkbox or switch track, owing 3:1. It falls back to `--ui-hairline-strong`, so an app that does not map it looks as before, and the conformance check measures it unmapped as that token, under that token's waiver (`COLOR_FALLBACKS`, `colorFallback`).
- `@shared/ui`: `RadioGroup`'s circle, `Checkbox`'s box, `Switch`'s track and the unticked native box draw their edge in `--ui-choice-edge`.
- `@osn/auth-ui`: `InlineAction`, the underlined button that ends an error line, is exported as `@osn/auth-ui/InlineAction`.

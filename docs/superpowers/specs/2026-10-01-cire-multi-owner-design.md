# Several owners per cire wedding — design

Date: 2026-10-01 · Status: awaiting owner approval · Issue: englishstventures/osn#1248 (overlaps #1304)

## Goal

Let a wedding have more than one owner, so both partners hold owner rights. Editors (a planner, a parent who helps run things) keep running the wedding day to day. Today one person owns a wedding: `weddings.owner_osn_profile_id` (`cire/db/src/schema.ts:30`) is a single NOT NULL column, the owner is never a row in `wedding_hosts`, and every owner-only gate compares the caller against that column.

## Decisions (owner, 2026-10-01)

1. **Owners are an `owner` role in `wedding_hosts`.** Each current `weddings.owner_osn_profile_id` becomes an `owner` seat.
2. **At least one owner always remains.**
3. **Any owner may remove or demote another owner.**
4. **Only an owner may make someone an owner.**
5. **Owner-only:** billing (tier purchases), Stripe payouts, export, deleting the wedding, and host management. Editors run everything else day to day.

## Non-goals

- Designing money flows for several owners on one Stripe Connect account. This spec flags the problem; a separate issue designs it.
- Two-owner sign-off for any action (one owner acts alone; see open question 5).
- Building the wedding-delete route or the cire DSAR export. Neither exists today; this spec says how they are gated when they land.
- Changing what `editor`, `viewer` or `helper` may do, beyond host management (open question 1).

## Data model and migration

### The role

`wedding_hosts.role` is a Drizzle text enum with no CHECK constraint, so adding `owner` needs no DDL:

```ts
role: text("role", { enum: ["host", "editor", "viewer", "helper", "owner"] })
```

Because `HostRole`, `StoredHostRole`, `ASSIGNABLE_HOST_ROLES`, `ROLE_PRIVILEGE_RANK`, `policyFor()` and the portal's `surfacesFor()` are all exhaustive over the column, widening it makes `bun run check` name every place that has to decide about owners. That is the intended path: no gate is edited by hand-search.

- `ROLE_PRIVILEGE_RANK` gains `owner: 3`. The floor (`LEAST_PRIVILEGE_ROLE`) is unchanged.
- `ASSIGNABLE_HOST_ROLES.owner = true`, but the route checks the caller is an owner before writing it (see API).
- `WeddingRole` stops being `"owner" | HostRole` and becomes `HostRole`, since owner is now stored.

### Backfill (migration `0071_wedding_owner_seats.sql`)

One statement, run once:

```sql
INSERT INTO wedding_hosts
  (id, wedding_id, osn_profile_id, added_by_osn_profile_id, role, run_sheet_scope, created_at)
SELECT 'whost_' || lower(hex(randomblob(16))), id, owner_osn_profile_id,
       owner_osn_profile_id, 'owner', 'own', created_at
FROM weddings WHERE true
ON CONFLICT (wedding_id, osn_profile_id) DO UPDATE SET role = 'owner';
```

- `ON CONFLICT … DO UPDATE` covers a legacy row where the owner also holds a seat; `hostsService.add()` refuses that today (`owner_is_host`), but the backfill must not fail on old data. `WHERE true` is SQLite's rule for an upsert fed by a SELECT.
- `added_by` is the owner themselves: they created the wedding.
- Seed files (`cire/db/seed/data/hosts.ts`, `seed/generate.ts`, `seed/dev-seed.sql`), the DDL mirror in `cire/api/src/db/setup.ts` and the dev repoint in `cire/api/src/local.ts:24` write an owner seat instead of the column.

### Keep or drop the column: drop it, in a second migration

Pre-launch, no shims (#1304 agrees). Order:

1. **PR 1** ships the backfill and code that reads owners from `wedding_hosts` only, while wedding create still writes the column (it is NOT NULL). The old Worker, still live for the minutes between migration and deploy, keeps working: it matches the owner by the column first, and reads an `owner` seat as an unknown role, which degrades to `helper`.
2. **PR 4** (last) drops the index `weddings_owner_idx`, then the column (`ALTER TABLE weddings DROP COLUMN` fails while an index names it), and removes the create-time write.

### Wedding create

`weddingsService.create()` (`cire/api/src/services/weddings.ts:174`) inserts the wedding and the creator's `owner` seat in one `commitBatch()`. A D1 batch is one transaction, so no wedding exists without an owner, even for an instant.

### The last-owner rule, race-safe

Two owners each demoting the other at the same moment must not both succeed. The guard lives **inside the writing statement**, not in a read before it:

```sql
-- demote or change role
UPDATE wedding_hosts SET role = :role
WHERE wedding_id = :w AND osn_profile_id = :p
  AND (role <> 'owner' OR :role = 'owner'
       OR (SELECT count(*) FROM wedding_hosts
           WHERE wedding_id = :w AND role = 'owner') > 1)
RETURNING id;

-- remove (and self-leave)
DELETE FROM wedding_hosts
WHERE wedding_id = :w AND osn_profile_id = :p
  AND (role <> 'owner'
       OR (SELECT count(*) FROM wedding_hosts
           WHERE wedding_id = :w AND role = 'owner') > 1)
RETURNING id;
```

Why this holds on D1: a database has one writer, and each statement runs whole before the next starts, so the count and the change cannot be split by another request. Of two crossing demotions the first sees two owners and succeeds; the second sees one and changes nothing. A read-then-write in Effect code would not hold, because two requests could both read "two owners" before either writes.

- Zero rows returned means "refused or not there". The route then reads the seat once to choose the answer: no seat → 404 `host_not_found`, an owner seat → 409 `last_owner`. That read only picks the error; it guards nothing.
- `hostsService.remove()` today batches the `host_rsvp_notices` delete before the seat delete. It becomes: guarded seat delete first, then the notices delete with `AND NOT EXISTS (seat)`, so a refused removal leaves the person's notices alone.
- `stillOrganiser` in `rsvp-digest.ts:216` already accepts any seat, so a removed owner stops getting digests as soon as the seat goes.

A database trigger as a second guard is open question 4.

## Every owner gate found, and what it becomes

API (`cire/api/src/`):

| Where | Today | Becomes |
|---|---|---|
| `middleware/wedding-owner.ts:35`, `:61`, `:117` | reads `weddings.owner_osn_profile_id`, compares to caller | reads the caller's seat; passes when `role = 'owner'`. Keeps 404 for an unknown wedding, 403 otherwise; keeps the entitlement fold (EXISTS column on the seat query) |
| `services/hosts.ts:258`, `:265`, `:330`, `:340` (`authorizePlain`, `authorizeWithEntitlement`) | wedding row first, then the seat unless caller owns | one query: wedding row LEFT JOIN the caller's seat. `isOwner` = seat role is owner. `hostId` is now set for owners. Drops `ownerOsnProfileId` from the result |
| `services/hosts.ts:439` (`add`, `owner_is_host`) | refuses adding the owner | goes; the unique index already answers `already_host` for any existing seat, owners included |
| `services/hosts.ts:564` (`setRole`), `:621` (`remove`) | owner never a seat, so never touched | guarded statements above; 409 `last_owner` |
| `middleware/wedding-member.ts:40`/`:108`, `wedding-editor.ts:32`/`:103`, `wedding-run-sheet.ts:36` | derive `weddingOwnerOsnProfileId` | drop it; `weddingIsOwner` comes from the role |
| `routes/organiser-hosts.ts:65`–`98` (`GET /hosts`) | returns the owner apart from the seats | owners are seats with `role: "owner"`; the separate `owner` field goes |
| `routes/organiser-hosts.ts:180`–`226` (`POST /hosts`) | `weddingEditor()`; passes owner id to `add` | see open question 1; `role: "owner"` in the body needs an owner caller |
| `routes/organiser-hosts.ts:297` (`PUT /hosts/:id/role`, `DELETE /hosts/:id`) | `weddingOwner()`; 404 for the owner | `weddingOwner()` (any owner); now reaches owner seats; last-owner guard |
| `routes/upgrade.ts:160` (`POST /upgrade/session`) | `weddingOwner()` | any owner (billing) |
| `routes/registry-stripe.ts:129` (`/registry/stripe/session`, `/refresh`) | `weddingOwner(db, "registry")` | any owner, plus the Stripe flag below |
| `routes/budget.ts:273` (`PUT /budget/total`) | `weddingOwner()` | any owner |
| `routes/organiser-settings.ts:83` (owner-only settings fields) | `weddingIsOwner` | unchanged code; true for any owner |
| `routes/organiser-weddings.ts:195` (deactivate, reactivate), `:269` (regenerate-code), `:613` (remint, mark-shared) | `weddingOwner()` | any owner; whether editors get any of these is open question 2 |
| `services/weddings.ts:85` (`listForMember`) | owned rows by column, then hosted rows | one query over seats; owners tagged by their seat role |
| `services/rsvp-digest.ts:216`, `:314`, `:512` | owner from the column, hosts from seats | seats only; every owner is mailed like the owner is today |
| `services/retention.ts:624` → `lib/gift-summary-email.ts:65` | one gift-summary email to the owner | one email per owner; `GiftSummaryNotice.ownerOsnProfileIds: string[]` |
| Delete the wedding | no route yet; matrix in `wiki/cire/cire-auth.md` says owner-only | when built: `weddingOwner()`, any one owner |
| Whole-wedding export | no route yet | when built: `weddingOwner()`; see open question 3 for the CSVs |

Portal (`cire/host/src/`):

| Where | Today | Becomes |
|---|---|---|
| `lib/wedding-roles.ts:37`, `:45`, `:97`, `:126`, `:161`, `:198` | `owner` is not a seat role; `AssignableRole` excludes it | `owner` is assignable; `surfacesFor("owner")` unchanged; `asSeatRole` stops mapping owner away |
| `components/HostsPanel.tsx:24`, `:110`, `:317`, `:360`, `:486`, `:633`–`638` | renders the owner as a fixed row with no controls | owners are ordinary rows, owner-only controls on each; copy says "an owner", not "you, the owner"; `owner_is_host` message becomes `already_host` |
| `components/RegistrySettingsView.tsx:235`, `:603`–`630` (`canManage`) | owner-only Stripe controls | any owner, plus the Stripe flag below |
| `tests/lib/wedding-roles.contract.test.ts` | reads the column's enum | passes once the portal lists `owner`; it is what catches a mismatch |

## API changes

- **Promote:** `PUT /hosts/:osnProfileId/role` with `{ role: "owner" }`. Already `weddingOwner()`-gated, so only an owner can do it. The portal asks for confirmation first, as it does for promotion to editor (`needsPromotionConfirmation`).
- **Demote:** the same route with any lower role. Any owner may demote any owner, themselves included, unless it would leave none (409 `last_owner`).
- **Remove:** `DELETE /hosts/:osnProfileId`, any owner, last-owner guard.
- **Invite at owner role:** `POST /hosts` with `{ handle, role: "owner" }`. The route refuses `owner` with 403 `forbidden` unless the caller is an owner; the TypeBox body accepts the value, and the role check sits in the handler beside the existing gate. Adding someone straight in as owner skips the "add as viewer, then promote" step; open question 6.
- **Errors:** new 409 `last_owner`. `owner_is_host` is removed.
- **Realtime:** owner promote, demote and remove publish `members-changed` on `cire:wedding:<id>` like any role change (#1249).
- **Host cap:** owners count towards `MAX_HOSTS_PER_WEDDING` (50). The cap protects "every seat is listed"; owners are listed too.

## Stripe and Connect (flag only)

`registry_settings.stripe_account_id` (`cire/db/src/schema.ts:664`) holds one Express account per wedding, and cash gifts are direct charges on it. Whoever runs onboarding puts their own identity and bank account on it, so every payout goes to that one person. With several owners:

- The account belongs to one partner, not the couple. A second owner who opens `/registry/stripe/session` gets an account link for an account in someone else's name, and may be able to change its payout details.
- An owner who is removed from the wedding still owns the account and still receives its payouts.
- Tier purchases (`/upgrade/session`) are paid by whichever owner checks out; refunds go to that card.

Recommended stopgap until a money design lands: record which owner connected the account and let only that owner open onboarding or update links; other owners see status only. Tracked as its own issue.

## Compliance

- **Wording.** The couple are **joint controllers** of their guests' data, and cire is their processor. Replace "the organiser" or "the owner" with "the wedding's owners (joint controllers)" in `wiki/compliance/data-map.md`, `wiki/compliance/dsar.md`, `wiki/compliance/dpia/cire-guest-data.md`, `wiki/compliance/access-control.md` and the cire privacy text. A guest's request may go to any owner; each can act on it.
- **DSAR export.** An owner's own export lists every wedding where they hold an owner seat. It names the other owners by OSN profile id only, which is data about a third party the requester already shares the wedding with; note this under Art. 15(4) in `dsar.md`.
- **Erasure.** The orphan-tolerance reasoning in `dsar.md` ("a wedding is a jointly owned record") gets stronger: when one owner deletes their OSN account, the cire fan-out (when built) removes their seat and the wedding lives on with the other owners. The last owner deleting their account is open question 7.
- **Access reviews.** `access-control.md` says "only the OWNER may change a role or revoke a seat"; it becomes "any owner", and must say an owner can remove another owner.

## Co-host self-leave

Self-leave (a co-host removing their own seat) is not built yet. When it lands it uses the same guarded `DELETE`, so an owner can leave only if another owner remains; the last owner gets 409 `last_owner` and the portal tells them to promote someone or delete the wedding. A non-owner's self-leave is unaffected by this design.

## Testing

- **Unit (`cire/api/tests/`):** `policyFor`, rank and assignable maps cover `owner`; `weddingOwner()` admits each of two owners and refuses an editor; promote by an editor is 403; demote, remove and self-leave of the last owner are 409 `last_owner`; demote of one of two owners succeeds; `add` with `role: owner` by an editor is 403.
- **Every owner-only route with a second owner:** a table test over the routes in the gate table, run as the original owner, a promoted owner and an editor.
- **D1 tier (`cire/api/tests/db/`, Miniflare):** the backfill on a copy of seed data (every wedding gets exactly one owner seat; a wedding whose owner already had a seat ends with one row, role owner); two crossing demotions in one `batch` and as two requests leave exactly one owner; wedding create leaves an owner seat; the column drop runs after the index drop.
- **Emails:** gift summary and RSVP digest reach every owner once.
- **Portal:** the contract test, HostsPanel with two owners (both rows show owner controls; the last owner's demote shows the 409 message).
- **`ddl-lockstep.test.ts`** stays green after the `setup.ts` mirror changes.

## Rollout (issue-sized PRs)

1. **Owner seats.** Widen the enum, backfill migration, `authorize()` and the three role gates plus `weddingOwner()` read seats, `listForMember`, create writes both, guarded `setRole`/`remove`, `GET /hosts` lists owners as seats, seeds and `setup.ts`. Wiki: `cire-auth.md` matrix and gate text.
2. **Promote and invite as owner.** `POST /hosts` and `PUT /role` accept `owner` from owners only; portal HostsPanel and `wedding-roles.ts`; confirmation on promote; realtime publish.
3. **Every owner is told.** Gift summary and RSVP digest to all owners; compliance wording across `wiki/compliance/`.
4. **Drop the column.** Remove `weddings.owner_osn_profile_id` and its index, and every remaining write.
5. **Stripe stopgap** (separate, may land any time after 1): record who connected the account; limit onboarding links to them.

Open questions 1 to 3 change PR 1 or 2 if answered differently from the recommendation.

## Open questions

1. **Should editors still be able to add co-hosts?** Today `POST /hosts` is `weddingEditor()`, so an editor can add seats; you said host management stays owner-only. *Recommended:* editors may still add, but only at `viewer` or `helper`; `editor` and `owner` seats, role changes and removals are owner-only. A planner can bring in day-of helpers without asking, and nobody can raise anyone to their own level.
2. **Do the claim-code actions stay owner-only?** Regenerate, re-mint, mark-shared, deactivate and reactivate are owner-only today. *Recommended:* keep them owner-only, except `mark-shared`, which moves to `weddingEditor()`: it is bookkeeping fired by the copy-message button, and today an editor's copy is silently not recorded.
3. **What does "export" mean?** The per-module CSVs (`rsvps.csv`, `guests.csv`, `events.csv`, `gifts.csv`) are `weddingMember()` today, so a viewer can download guests' claim codes and dietary needs. *Recommended:* "export" means a whole-wedding export, owner-only when built. Move the module CSVs to `weddingEditor()` so viewers lose them, since editors need them to run the day.
4. **Add a database trigger as a second guard on the last owner?** *Recommended:* not in PR 1. The guarded statements are enough on D1. A trigger must not block the cascade when a wedding is deleted, which needs its own D1 test; file it as a follow-up and add it only if that test passes.
5. **Does deleting a wedding need every owner to agree?** *Recommended:* no, one owner suffices (you made all owners equal), but the delete emails every other owner, and the wedding is held for 7 days before the data is erased so another owner can undo it.
6. **Can someone be invited straight in as an owner?** *Recommended:* yes, from an owner only, with the same confirmation as promotion; this is what onboarding step 5 (#1294) needs for "invite your partner".
7. **What happens when the last owner deletes their OSN account?** *Recommended:* if an editor remains, promote the longest-standing editor to owner and email them; if none does, the existing orphan-tolerance rule in `wiki/compliance/dsar.md` applies until the retention sweep erases the wedding.
8. **Should a removed owner be told?** Any owner can remove another, which in a breakup locks one partner out. *Recommended:* email the removed owner and every remaining owner on any owner removal or demotion, naming who did it.
9. **Who gets Stripe payouts when there are several owners?** *Recommended:* ship the stopgap above (only the owner who connected the account may change it) and design shared payouts in a separate issue before registry launch.

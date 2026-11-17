# How a cire wedding with several owners receives its cash gifts — design

Date: 2026-11-17 · Status: owner decisions recorded, awaiting the owner's approval of the rest · Issue: englishstreetventures/osn#1950 (follows #1336; related to #1248 and #2018)

## Goal

A wedding can have several owners so that both partners hold owner rights (`2026-10-01-cire-multi-owner-design.md`, §Goal), but its cash gifts are paid into one Stripe account, which carries one person's identity and bank details. Today that person keeps the account when they stop being an owner, nobody else can replace it, and refunds or disputes on gifts paid into an account the wedding no longer names are lost to its gift log. This note says who may connect, change or replace the payout account; what happens when its holder leaves; how the couple hand it from one partner to the other; and what each owner sees. It replaces the stopgap the multi-owner design's decision 14 asked for, which #1336 built.

This note designs; it builds nothing. The owner approves it before any code.

## Decisions (owner, 2026-11-17)

1. **When the owner who connected the wedding's Stripe account stops being an owner** — removed, left, demoted, or their account erased — all three of these hold:
   - (a) money gifts close while the connector holds no owner seat. The same holds for a wedding whose connector is not recorded. The Money gifts panel says why in plain words.
   - (b) the remaining owners are told, in the owner-change notice and in the Money gifts panel, and pointed at the money-gifts switch.
   - (c) the connector can hand the account to another owner before leaving.

   This replaces two defaults the merged #1975 set: an account with no recorded connector belonged to no owner, and a connector who left kept the account. A third default stays: refreshing the account's status is open to every owner.
2. **Cire never holds gift money.** Gifts stay direct charges on the couple's connected account (`wiki/cire/cire-registry.md`; the `registry_settings.stripe_account_id` comment, `cire/db/src/schema.ts:1016-1019`). A design that routes gifts through the platform account is out.

## Non-goals

- Tier purchases (`POST /upgrade/session`). See [Tier purchases stay out](#tier-purchases-stay-out).
- A planner as the payout holder (#2018). This note only leaves room for it: [Planner (#2018)](#planner-2018).
- Two payout accounts on one wedding, or gifts split between partners.
- Any change to who may run a refund. Cire refunds no gift on its own today, and still will not.

## What Stripe allows

Checked against Stripe's documentation on 2026-11-17, each page fetched that day. Cire pins API version `2025-03-31.basil` (`cire/api/src/services/stripe.ts:37`).

**Cire cannot hand an Express account from one person to another.**

- "After you create an account link for an Express connected account, you can't read or update its KYC information." (docs.stripe.com/connect/express-accounts, §Create an account link). Cire creates the link on the first Connect press (`registry-stripe.ts:321`), so from then on cire cannot change whose identity the account carries.
- The holder edits their own personal details and payout bank in the Express Dashboard, and signs in there with the account's email and a code sent to their phone or email (docs.stripe.com/connect/express-dashboard, §Account settings, §Direct access). So the person who onboarded keeps control of the account whatever cire records.
- Stripe treats a change to a verified tax ID as a transfer of the account and its balances to a new owner, which the account must accept again under the Stripe Services Agreement (docs.stripe.com/connect/update-verified-information, Accounts v1, §Update the account tax identification number). That is a matter between the two people and Stripe, not a step cire can run.

So **a hand-over is a new account**: the next holder connects one of their own, and the wedding stops naming the old one. This note calls that **retiring** the old account.

**A Standard account** (connected through OAuth, `stripe_account_type = 'standard'`, `schema.ts:1040`) is the holder's own Stripe account. Who owns it inside Stripe is theirs to manage; cire treats it as it treats an Express account, except that cire later hands it back (behaviour 13).

**Retiring is not deleting or rejecting.**

- Deleting a live Express account needs every balance at zero (docs.stripe.com/api/accounts/delete), and a deleted account can no longer refund.
- Rejecting is for fraud or a terms breach, and turns off the account's charges and payouts (docs.stripe.com/api/account/reject). That would stop the old holder's own payouts.
- So a retired Express account stays connected to cire, untouched. Its holder still sees it, and still receives its payouts, in the Express Dashboard.

**Refunds and disputes on old gifts keep arriving while the account stays connected.** For direct charges, "the payment, refunds, and disputes exist on the connected account, so their events use the Connected accounts scope", and "each event for a connected account contains a top-level `account` property" (docs.stripe.com/connect/webhooks, Accounts v1). So cire's gift handlers must match them by the account the gift was paid into, not by the account the wedding names now. Once cire hands a Standard account back, its events stop reaching cire.

**Cire stays liable for a retired Express account's losses.** "Your platform is responsible for losses incurred by Express connected accounts" (docs.stripe.com/connect/express-accounts, §Before you begin). A dispute on an old gift debits the old account whether or not the wedding still names it. Retiring changes nothing here.

**Refunds on old gifts.** In the Express Dashboard an account holder can "issue refunds and manage disputes, if you enable these features" (docs.stripe.com/connect/express-dashboard, §Payments). After a retire, the old holder is the one person who can refund a gift paid into their account from that Dashboard.

**Idempotency keys last at least 24 hours.** Stripe saves the first answer to a key and replays it to a repeat, and may prune a key once it is 24 hours old; it also asks for no "personal identifiers" in keys (docs.stripe.com/api/idempotent_requests). The account-create key is `cire-account-<weddingId>` (`stripe.ts:530`), so a Connect press within 24 hours of a retire would get the retired account back (the hazard noted on #1950 for deauthorization). The key must change with each account, and the attach must refuse an account made under an old key; see [Data model](#data-model).

**Not confirmed:** whether Stripe scopes an idempotency key to the connected account named in `Stripe-Account`. The design does not depend on it: the gift checkout key gains the account id (behaviour 7).

## The issue's premises, checked against the code

On `origin/main` at `99f0b7ce2`.

| The issue says | The code | Verdict |
|---|---|---|
| Each wedding has one Express account, `registry_settings.stripe_account_id` | `schema.ts:1019`. Also a Standard type (`schema.ts:1040`, OAuth), and one account may serve several weddings of the same owners (`registry.ts:1565-1630`, `adoptStripeAccount` at `registry.ts:2319`, PR #2015) | True, but two shapes more than the issue names. Both are covered below |
| Gifts are direct charges on that account | `stripe.ts:557-588` passes the account to `createCheckoutSession`; the transport sets `stripe-account` (`stripe.ts:436`) | True |
| Only the connector may open onboarding links; other owners see status | `registry-stripe.ts:251`, `:299`; refresh open at `:347` | True |
| No recorded connector ⇒ no owner may open links | `registry-stripe.ts:251` compares a NULL with the caller | True |
| A connector who leaves keeps the account, and no owner can change it | The attach only fills a NULL id (`registry.ts:2202`); no route clears an account | True |
| The only reset is Stripe's deauthorization | `stripe-webhook.ts:142`, `:409` → `detachStripeAccount` (`registry.ts:2733-2784`); the OAuth hand-back ends there too (`registry-stripe-oauth.ts:228`). The purge deletes the row and hands a Standard account back without a detach (`maintenance-sweeps.ts:241-275`) | True |
| `contributionsOnAccount` matches a gift only through the wedding's current account | `registry.ts:1354-1387` joins `registry_settings.stripe_account_id` to the event's account; settle (`:3164`), fail (`:3295`), refund (`:3409`) and dispute (`:3521`) all answer `rejected` when that join finds nothing | True. A refund, dispute or late settle on a replaced account is dropped today |
| Removing or demoting the connector: `DELETE /hosts/:osnProfileId`, `PUT /hosts/:osnProfileId/role` | `organiser-hosts.ts:674`, `:473`; also `DELETE /hosts/me` (`:743`), so an owner can leave | True, and self-leave is built |
| Tier purchases are charged to whichever owner checks out | `upgrade.ts:166-194` (`weddingOwner`); a platform session with no `Stripe-Account` (`stripe.ts:618-645`) | True |
| The account-create key is per wedding | `stripe.ts:530` | True |
| A wedding connected before the connector column has none recorded | Migration `cire/db/migrations/20261104040827_registry_stripe_connected_by.sql` adds the column with no back-fill; the suite's own seed has such a row (`cire/api/src/db/setup.ts:1113-1127`), and so does every contribute and guest route-test fixture (`cire/api/tests/routes/registry-contribute.test.ts:156-167`, `registry-guest.test.ts:229`) | True. Decision 1(a) closes these |
| Production holds no Stripe key | `wiki/compliance/access-control.md:88`, measured 2026-10-16, not measured again here | Not relied on. The change that closes gifts can only stop money, never send it anywhere else, so its safety does not depend on what production holds |

Found while checking, beside the issue:

- `registry_contributions` records no account (`schema.ts:1266-1360`).
- The gift checkout's idempotency key hashes the household, slug, amount, currency, fund, note, name and a five-minute bucket, not the account (`registry-guest.ts:296-320`).
- The contribute route hands back a guest's open page by retrieving its session on the wedding's **current** account (`registry-guest.ts:395-415`); the lookup has no account term (`registry.ts:2896-2945`). After a change of account, that read asks the new account for the old account's session, and Stripe's refusal becomes a 502.
- An account erasure clears the connector (`account-erasure.ts:397-400`) and sends no notice; only the hosts routes send owner-change notices (`organiser-hosts.ts:131-142`).
- A deletion-preview action with a default choice does not block the deletion (`osn/api/src/services/account-erasure.ts:994`); osn-api refuses more than 200 actions from one app (`osn/api/src/services/deletion-apps.ts:245`, `:277`).
- An unmatched money event is logged as a warning unless the settings name its account as Standard (`reportUnmatched`, `stripe-webhook.ts:96-108`; `stripeAccountTypeNamed`, `registry.ts:2678`).

## Terms

- **Holder**: the profile in `stripe_connected_by_osn_profile_id` for the account the wedding names now. Today's code calls them the connector.
- **Seated**: the holder holds a seat with `role = 'owner'` on this wedding.
- **Absent**: there is an account and its holder is not seated, or none is recorded.
- **Retire**: the wedding stops naming its account. Cire calls Stripe for nothing when it retires one.

## Who may connect, change or replace the account

| Action | Who | Today |
|---|---|---|
| Connect a wedding with no account (a new Express account, a reuse from another wedding, or OAuth) | any owner | unchanged |
| Continue onboarding | the holder, while seated | unchanged |
| Open the Stripe Dashboard (Standard) | shown to the holder; it is a plain link, and Stripe's own sign-in guards it | unchanged |
| Check again (refresh the status) | any owner | unchanged (the #1975 default that stays) |
| **Hand over**: retire the account and name the owner who should connect the next | the holder, while seated | new |
| **Disconnect**: retire the account, naming no one | the holder, while seated | new |
| **Replace an absent holder's account**: retire it, then connect as above | any owner, while the holder is absent | new |
| Anything above | editors and viewers: nothing | unchanged |

While the holder is seated, no other owner can retire their account. An owner who wants to can remove or demote the holder first, as decision 3 of the multi-owner design allows; the holder then gets the owner-change notice, so it is never silent.

Naming an owner in a hand-over grants them nothing the others lack: once the account is retired any owner may connect the next one, as for any wedding with no account. The name tells the notice whom to address.

Every action above that reaches Stripe or the account sits behind `weddingTier(db, "gold")` (`registry-stripe.ts:220`), so below Gold the retire answers 402 like the rest. Guests cannot reach the gift list below Gold either (`wiki/cire/cire-registry.md`, the note under §Gift registry), so no money moves meanwhile.

## Data model

Migrations in the later build. Nothing here is written by this branch.

| What | Meaning | Written by |
|---|---|---|
| `registry_contributions.stripe_account_id`, `stripe_account_type` | The account the gift's Checkout session was created on, and its type then | `createPendingContribution`, from the gate's answer. The migration back-fills both from the wedding's settings row, where it names an account, for each gift created after that row's `stripe_deauthorized_at`, or for every gift when that is NULL. Until this design, every clear of an account went through `detachStripeAccount`, which stamps that column (`registry.ts:2757`), and neither the attach nor the reuse touches it (`:2199-2226`, `:2370-2380`), so every gift since the last clear was made on the account the row names now. `stripe_connected_at` cannot serve: the reuse copies the source wedding's time (`:2344`, `:2374`). Other gifts, and the suite's seeded ones, stay NULL and are matched as today, through the wedding's current account |
| Index `registry_contributions_account_status_idx` on `(stripe_account_id, status)` | The hand-back sweep asks whether any gift on an account is still `pending` | the migration |
| `registry_settings.stripe_account_generation` | How many times this wedding's account has been cleared. `INTEGER NOT NULL DEFAULT 0` | A trigger, `AFTER UPDATE OF stripe_account_id`, when the id goes from a value to NULL. Every writer that clears an account bumps it — the retire, `detachStripeAccount`, the OAuth hand-back's detach, a hand-run statement, a Worker built before the column — as `registry_settings_stripe_account_cleared` already clears the type (`cire/db/migrations/20261105131915_registry_stripe_oauth.sql:47-51`). Nothing deletes a settings row but the purge, which removes the wedding with it. The INSERT arms of the attach and the reuse list it, since their value maps must name every column (`registry.ts:2189`, `:2355`) |
| `registry_retired_accounts` | One row per retire: `id`, `wedding_id`, `stripe_account_id`, `stripe_account_type`, `stripe_connected_at` (copied from the settings row), `retired_at`, `reason` (`handed_over`, `disconnected` or `holder_absent`), `released_at`, `last_hand_back_at`. No profile id. Indexed on `stripe_account_id` | The retire, in the same D1 batch. `released_at` is set when cire hands the account back or Stripe says it is no longer connected (behaviour 13). It cascades with the wedding; the purge hands back what it must once its delete has matched (behaviour 13) |

Whether the holder is seated is never stored. Every place that builds a settings record works it out with one `EXISTS` on `wedding_hosts`, answered by the unique index `wedding_hosts_wedding_profile_uniq` (`schema.ts:209`): `settingsOnly`, `settingsWithCurrency`, the guest gate's read, `updateSettings`'s `RETURNING` (`registry.ts:2029-2034`), `writeStripeAccountState`'s (`:1116-1121`), the attach's (`:2229-2232`), the reuse's and its refusal read (`:2384-2389`, `:2398-2422`), and `defaultSettings` (no account, so never absent). One missed and the refresh, the panel and the gate disagree.

**The account-create key** becomes `cire-account-<weddingId>-<generation>`, and `createAccount` takes the generation (`stripe.ts:507`). Two owners who press Connect at once still get one account (the race the session route handles at `registry-stripe.ts:288-301`), and the key holds no personal identifier. An account created under the old key format in the 24 hours before the deploy and never stored is orphaned, as such an account is today after 24 hours.

**The attach is guarded on the generation.** The session route reads the generation with the row (a wedding with no row reads 0) and passes it to `attachStripeAccount`, whose conflict update writes only while the row still holds it. The INSERT arm needs no guard: it runs only when no row exists, which is generation 0. Without the guard a slow request could fill the id with an account another owner made and has since retired: owner A reads generation N; owner B connects account X under key N and retires it; A's create, still keyed N, gets X back from Stripe inside 24 hours, and A would be recorded as the holder of B's verified account. With it, A's attach writes nothing. The route already answers a write that wrote nothing with 403 `forbidden` (`registry-stripe.ts:278-290`); it now pays one read to tell the two causes apart and answers 409 `stripe_account_changed` when the generation moved, logging `stripe account created but not stored` with the account id either way. The generation is read before the write, never from a `RETURNING`, which does not show what an `AFTER` trigger changed. The reuse and the OAuth attach need no guard: neither uses the key, and each proves control of its account another way (`registry.ts:1565-1630`; Stripe's sign-in).

`cire/api/src/db/setup.ts` mirrors every column, index, table and trigger (`cire/api/tests/db/ddl-lockstep.test.ts` compares triggers too).

## Behaviour

1. **Gift events act on the account the gift was paid into.** `contributionsOnAccount` (`registry.ts:1354`) matches `registry_contributions.stripe_account_id` with the event's account; a row with NULL there falls back to today's join on the settings row. The Standard-account rule in settle and fail (`registry.ts:3177-3190`, `:3304-3315`) takes the type from the gift row the same way. So a refund, a dispute, or a late settle of a delayed bank debit on a retired account reaches its gift, for as long as the account stays connected. A forged event from another account still matches nothing.
2. **Whether the holder is absent** is one predicate, used by the guest gate, every settings record, the retire and the hosts flag (behaviour 11). The settings and the refresh's answer (`StripeStatusDto`, `registry.ts:361-366`, `:1136-1145`) carry it as `payoutHolderAbsent: boolean`, apart from the reason, because the reason `payments_unavailable` comes first on a deployment that cannot take money (`moneyGiftsBlock`, `registry.ts:745-750`), and the panel must still say the account's holder is not an owner.
3. **Money gifts close while the holder is absent.** `accountMoneyBlock` (`registry.ts:720-730`) gains `payout_holder_absent`. The order becomes: `payments_unavailable` (the deployment); then, with no account, `stripe_not_ready`; with an account, `payout_holder_absent` first, before `stripe_not_ready` for an account that cannot charge yet, because only a new account fixes it and the other owners cannot finish someone else's onboarding; then the two currency reasons; then `cash_gifts_off`. `takesMoney`, `moneyIsOpen`, the guest list, the fund pictures and the contribute route (`contributionContext`, `registry.ts:2811`) all follow from that one function, as today. The account is kept: if the holder is seated as an owner again, money gifts open again while the switch is on.
4. **The switch.** `PUT /registry/settings` refuses to turn money gifts on while the holder is absent: 409 `payout_holder_absent`, carrying the settings, as the other three refusals do (`moneyOnRefusal`, `registry.ts:1030`). Turning them off is always allowed. The switch is the couple's intent, and nothing but that save writes it (`wiki/cire/cire-registry.md`, §Connecting the account, "Intent and capability"), so it survives a change of account as it survives a deauthorization today: a newly connected account takes gifts as soon as it can charge, if the switch is on.
5. **What the settings carry.** `RegistrySettingsDto` gains `payoutHolderAbsent` for owners and editors, through `settingsForReader` (`registry.ts:782-800`); a viewer gets `null`. Owners and editors get `payout_holder_absent` as the reason. A viewer gets `cash_gifts_off` or `not_offered`, as for the currency reasons. The connector id stays owner-only, as today. Telling editors is a change: see approval item 11.
6. **Retire.** `POST /api/organiser/weddings/:weddingId/registry/stripe/retire`, body `{ handTo: string | null }`, behind `weddingOwner`, Gold and the per-user limiter, like the other `/stripe/*` routes (`registry-stripe.ts:217-223`). The route reads the row (its account and generation), then runs one D1 batch of two statements, in this order, each carrying every rule in its `WHERE`:
   - the row still names the account the route read;
   - the caller still owns the wedding and it is live (`ownsLiveWedding`, `registry.ts:1600`);
   - the caller is the holder, or the holder is absent, read in the statement, so a holder seated again meanwhile is not retired;
   - `handTo`, when given, holds an owner seat and is not the caller.

   First an `INSERT … SELECT` writes the `registry_retired_accounts` row; then the `UPDATE` sets the id, holder, type, connect time, both flags and the settlement currency to NULL or false. The order matters: once the `UPDATE` has run the row no longer names the account, so an `INSERT` after it would match nothing. A D1 batch is one transaction, so both land or neither. The trigger bumps the generation. The switch is left alone. Cire calls Stripe for nothing. A refusal pays one read to choose its answer: 403 `stripe_connector_only` (the holder is seated and is not the caller), 409 `handover_not_owner`, or 409 `stripe_account_changed` with the settings as they stand (no account, or another one: two owners replacing at once, or a deauthorization in between). Logged `stripe account retired` with the wedding, `by: holder | absent_holder` and `handed: yes | no`; refusals `stripe account retire refused` with the reason. No profile id or account id in a log line or a metric; the retired-accounts row is the record of the account.
7. **Old pages and old keys.** The reuse lookup (`findReusableContribution`) also matches the wedding's current account, so a page on an old account is never handed back to a guest, and the gift checkout key gains the account id. A guest who already holds a page on the old account can still pay on it until it closes, at most an hour after it was made (`GIFT_CHECKOUT_LIFETIME_SECONDS`, `registry-guest.ts:286`); that gift is paid into the old account and recorded (behaviour 1). Cire does not expire those pages: see §Rejected and approval item 10.
8. **Retire notice.** Every retire mails every owner: who retired the account, whom they handed money gifts to if anyone, that guests cannot give money until an owner connects an account, and a link to Money gifts; the named owner's copy speaks to them. A retire of an absent holder's account mails every owner too, so an owner who did onboard an account nobody recorded hears of it. A new notice kind beside the three in `owner-notice-email.ts:1-42`, spending the same per-wedding and per-actor budget. A notice can be throttled by that budget (`:33-41`, `:278-294`), so the panel, not the email, is the one channel that always tells.
9. **When the holder stops being an owner** (decision 1(b)). The owner-change notice (`owner-notice-email.ts:323-362`) gains one paragraph when the person removed, demoted or leaving held the wedding's current account. Whether they did is decided by the hosts write itself: the guarded `DELETE` or `UPDATE` in `hostsService` adds to its `RETURNING` a sub-select of whether the settings row names an account held by that profile, so it costs no statement and cannot be beaten by an owner who retires the account a moment later. The paragraph still needs the change to take an owner below owner (`previousRole` was `owner` and the new role is not, `hosts.ts:840`): the flag alone is also true when a holder already demoted is promoted again. To the other owners: money gifts have stopped, because gifts would still be paid to that person; connect your own account to take gifts again, or turn money gifts off so they stay off if that person comes back; a link to Money gifts. To the person who left, when they are mailed (not when the owner who seated them removes them within a day, `FRESH_SEAT_MS`, `:113-120`): gifts already given stay in their account, and any refund or dispute on them happens there.
10. **The gift log** marks a gift `paidIntoEarlierAccount` when its account is recorded and differs from the account the wedding names now. A row with no recorded account is never marked.
11. **Warnings before the holder goes.** `GET /hosts` marks the holder's seat `payoutHolder: true` for an owner reading it, and for no one else. The hosts panel warns before an owner removes or demotes the holder, and before the holder leaves or steps down, that money gifts stop until another owner connects their own account, and offers the holder the hand-over first.
12. **Account erasure.** The erasure already clears the connector (`account-erasure.ts:397-400`), so the holder becomes absent and money gifts close; the panel says why. It sends no email (approval item 6). The deletion preview gains one action per live wedding where a profile of the account holds the current payout account and another owner remains, with one choice, `close`, as its default, so it never blocks the deletion: it says guests will not be able to give money there and links Money gifts, so the holder can hand over first. One read before the batches; at most 20 such actions, then one that stands for the rest, so with the sole-owner actions (at most 100, `account-erasure.ts:82`, `:200`) an answer stays under osn-api's 200.
13. **Handing a Standard account back.** A retired Standard account stays connected for the time approval item 4 settles, so late refunds and disputes on its gifts still reach the log. Then cire hands it back with `POST /oauth/deauthorize`:
    - **Who does it.** The daily maintenance sweep, which already hands back the Standard account of a purged wedding (`maintenance-sweeps.ts:241-275`). At most 3 accounts a run, the purge's own bound, since every cron job shares one invocation's D1 ceiling (`maintenance-sweeps.ts:63-69`).
    - **When.** It judges the account, not one row, and only its unreleased retired rows: at least one exists and every one has passed its time; no settings row names the account; and no gift on it is `pending` with a session and younger than 14 days, the bound the purge already puts on the same question (`PURGE_PENDING_HOLD_S`, `maintenance-sweeps.ts:88`, `:102`), since a pending row whose Worker died, or whose expiry event was missed, can sit for a year (`registry.ts:3099-3103`). A success releases every row naming the account, so an account released, connected again and retired again is judged afresh.
    - **A refused or failed call.** An error from `/oauth/deauthorize` is not taken as proof the account is gone, since the transport keeps only the error code (`stripe.ts:398-401`) and a misconfigured client id must not mark every account released. The sweep then asks `GET /v1/accounts/:id`: a refusal there means cire no longer reaches the account, and the rows are released. Anything else sets `last_hand_back_at` and logs the account id for a hand fix, as the purge's does. Candidates are taken oldest attempt first, so a few failing accounts never hold the others back.
    - **A connect in between.** If an owner connected the same account while the call was in flight, the sweep clears that row afterwards and logs it, as the OAuth hand-back does (`registry-stripe-oauth.ts:228-232`). A connect whose attach lands after that check can still leave a wedding naming an account cire no longer reaches, as the OAuth hand-back and the purge can today (`registry-stripe-oauth.ts:225-232`, `maintenance-sweeps.ts:265-273`); the panel then shows an account that cannot take payments, and its holder's Disconnect clears it.
    - **Stripe's deauthorization** of an account (`detachStripeAccount`) also releases the retired rows naming it that were connected at or before the event, by the same time guard it applies to settings rows (`registry.ts:2771-2776`), so a late event for an older connection leaves a newer one alone.
    - **The two hand-back paths that exist** count an unreleased retired row as naming the account: the OAuth callback's (`stripeAccountNamed`, `registry.ts:2658-2671`) and the purge's (`maintenance-sweeps.ts:250-263`). Neither then cuts a retired account's time short. The purge of a wedding reads that wedding's retired Standard accounts inside its delete batch, as it reads the settings row (`maintenance-sweeps.ts:179-185`), and hands back those nothing else holds only once the delete has matched (`:200-216`), so a wedding restored meanwhile keeps them.
    - **The unmatched-event log** (`stripeAccountTypeNamed`) reads the type from a retired row too, so a retired Standard account's own shop sales log at info level, not as missing gifts.

### What a retire does not touch

- **Other weddings naming the same account.** A retire writes only its own wedding's row. Another wedding the holder gave the account to (`adoptStripeAccount`) keeps it, and keeps taking gifts while its own holder is seated there.
- **The reuse rules** (`controlsSourceAccount`, `ownersSitBesideSource`, `accountMayJoin`, `registry.ts:1565-1630`) are unchanged. A retired account is on no settings row of this wedding, so it is offered to it again only from another wedding the caller still holds it on.
- **`account.updated`** writes every row naming the account (`applyStripeAccountState`, `registry.ts:2454`). A retired account names none on this wedding.

## What each owner sees

The Money gifts panel (`cire/host/src/components/RegistrySettingsView.tsx`). Names come from `GET /hosts`, which every member may read; the settings carry only profile ids. The panel decides "absent" from `payoutHolderAbsent`, never from a missing connector id: after a 403 it patches the field to false (today it patches the connector to `null`, `RegistrySettingsView.tsx:822-824`, which under the new rule would read as absent).

| The wedding | The holder | Another owner | An editor |
|---|---|---|---|
| No account | — | "Connect an account", as today. After a hand-over the retire notice told the named owner it is theirs to do | Why guests can't give money; an owner can connect one |
| Account, holder seated | Today's view, plus "Hand money gifts to another owner" and "Disconnect", each behind a dialog: guests can't give money until the next account can take payments, and gifts already given, and any refund or dispute on them, stay with the holder's account | Today's view: the account's status, "Check again", and the note that only the person who connected it can change it | Today's view |
| Account, holder absent or none recorded | — | "Guests can't give money right now. This Stripe account isn't held by a current owner of this wedding, so gifts would be paid to someone who no longer runs it. Use your own account to take gifts again, or leave money gifts off." "Use your own account" retires the account and opens the Connect choice. The switch can be turned off, not on | The same reason, and that an owner can connect their own account |

One sentence covers a holder who left, one who was erased (the erasure clears the record, so the two look the same) and an account nobody recorded.

The gift log, for everyone who sees it: under a gift paid into an earlier account, "Paid into an earlier Stripe account. Any refund comes from that account."

The guest sees what any closed money option shows today: no money panel and no funds. On the new account, Stripe's page shows the new holder's business name, as it shows the holder's today.

## Tier purchases stay out

`POST /upgrade/session` is a platform charge: cire is the merchant, the buying owner pays with their own card, and a refund returns the money to the card that paid (`wiki/cire/cire-upgrades.md`, §The refund). No money flows to any owner afterwards, so the hazard behind this issue, gifts paid to someone who has left, cannot arise. Every owner is already told of an automatic refund (`upgrade-refund`, `owner-notice-email.ts:401-432`). The cause it shares, one owner's card, is how card payments work, and splitting a tier's price between owners is a feature nobody has asked for. If the owner wants it, it is its own issue.

## Planner (#2018)

This note does not design the planner. It must leave room for a planner organisation to hold a wedding's payout account, chosen by the couple per wedding. So the build:

- writes the holder rule once, as the one predicate of behaviour 2 ("is this account's holder in good standing on this wedding"). #2018 adds a second kind of holder, an organisation attached to the wedding with the couple's recorded choice, to that predicate, not a second gate;
- keeps who may retire in one place too (the holder, or anyone while the holder is not in good standing). #2018 must widen it, since a planner in good standing holds no owner seat and the couple must still be able to move off the planner's account;
- names the reason `payout_holder_absent` and the field `payoutHolderAbsent`, never anything that says owner or connector, so a planner taken off the wedding closes gifts with the same reason and words;
- keeps each gift's account on the gift, so one planner account serving many weddings of different couples settles, refunds and disputes each gift on its own;
- keeps the retire per wedding, and its record free of profile ids, so a couple who move off their planner's account leave the planner's other weddings alone;
- leaves the reuse rules as they are (`accountMayJoin` still refuses an account shared with another couple, `registry.ts:1613-1630`); #2018 decides that.

## Failure modes, and the test that proves each

For the later build. **E2E** sections extend the flow `cire-registry-money` and share its one organiser sign-in: the suite is at its cap of seven (`tools/e2e/tests/flows.test.ts:85-101`), and the suite signs in only as the dev profile (`osn/api/src/routes/auth/dev-login.ts`), so the other owner, Kit (`usr_e2e_kit`, seeded in `cire/api/src/db/setup.ts`), is never signed in and has no address to mail. Each section uses its own seeded wedding, since flows share one database and run one after another (`tools/e2e/playwright.config.ts:22-23`); Money Wedding is left as it is. The builder measures the flow against its two-minute limit.

The stack takes no money gift, by design: its cire-api has no Connect webhook secret, and the gift-list flows check that guests are offered none (`tools/e2e/src/stack.ts:249-256`). So the guest gate and the gift events are proved by route tests, which run the real routes over SQLite with a Stripe client that records each call. Every E2E section ends with a screenshot of the panel, in `e2e-artifacts/` beside `results.json`.

| # | Failure | Test | PR |
|---|---|---|---|
| 1 | A refund on a retired account leaves its gift "Received" | Route, `stripe-webhook.test.ts`: a gift on account A, the wedding now on B; `charge.refunded` on A refunds it | 1 |
| 2 | A dispute on a retired account is dropped | Route, the same file: `charge.dispute.created` and `.closed` on A move the gift | 1 |
| 3 | A delayed debit on a retired account never settles | Route: `checkout.session.async_payment_succeeded` on A settles the gift | 1 |
| 4 | Another account's event moves the gift | Route: the same events on account C answer `rejected`; the row is unchanged | 1 |
| 5 | A gift with no recorded account stops matching | Route: a row with NULL account still settles and refunds through the wedding's current account | 1 |
| 6 | The back-fill gives a gift the wrong account | Migration flow (`bun run --cwd cire/db test:migration-flow`): on a wedding never deauthorized every gift takes the current account; on one deauthorized, a gift before the deauthorization stays NULL and one after takes the current account; on a wedding that lost account B and then reused A from another wedding (so its connect time is the source's, earlier than B's gifts), B's gifts stay NULL | 1 |
| 7 | A Standard gift is adopted by `client_reference_id` after the wedding moved to Express | Route: a NULL-session gift whose own type is `standard` is not adopted | 1 |
| 8 | A Connect press within 24 hours of a deauthorization gets the old account back | Route, `registry-stripe.test.ts`: a recording Stripe client that replays by key; detach, Connect; the create key ends `-1` and the stored id is new | 1 |
| 9 | A slow create attaches an account made and cleared meanwhile | Service, `tests/services/registry.test.ts`: attach with generation N on a row at N+1 writes nothing. Route: the session route answers 409 `stripe_account_changed` and logs the id | 1 |
| 10 | A guest's open page on the old account is handed back, or asked of the new one | Route, `registry-contribute.test.ts`: an open gift on A, the wedding on B; a new session on B, no read on A | 1 |
| 11 | Two checkout attempts on different accounts share a key | Route: the recorded keys differ when only the account does | 1 |
| 12 | The same as 8, after a retire | Route: retire, Connect; a new key and a new account | 2 |
| 13 | Another seated owner retires the holder's account | Route, `registry-stripe.test.ts`: 403 `stripe_connector_only`; row unchanged | 2 |
| 14 | An editor retires | Route: 403 `forbidden` | 2 |
| 15 | A hand-over names a non-owner, an unknown profile or the caller | Route: 409 `handover_not_owner`; row unchanged, no retired-accounts row | 2 |
| 16 | A retire lands on an account connected meanwhile, or after a deauthorization | Service: the batch with a stale account writes neither statement; the route answers `stripe_account_changed` | 2 |
| 17 | An absent holder is seated again between the read and the batch | Service: the batch, run after re-seating, retires nothing | 2 |
| 18 | A retire clears the switch, leaves no record, or leaves a record without retiring | Route: the switch unchanged; exactly one retired-accounts row with the account, type, connect time and reason, present only when the settings row was cleared. D1 tier (`cire/api/tests/db/d1-integration.test.ts`, `bun run test:d1`): the two statements land together or not at all, since on bun:sqlite the batch helper runs them one by one (`cire/api/src/db/index.ts:150-169`) | 2 |
| 19 | A retire on one wedding takes the account off another | Route: two weddings share A; retire one; the other still names A and `account.updated` still reaches it | 2 |
| 20 | The owners are not told of a retire | Unit, `tests/lib/owner-notice-email.test.ts`: a hand-over, a disconnect and an absent-holder replace each reach every owner; the named owner's copy speaks to them | 2 |
| 21 | The gift log marks the wrong gifts | Route: marked only where the gift's account is set and differs; a NULL row is never marked | 2 |
| 22 | `payoutHolder` reaches an editor or a viewer | Route, `organiser-hosts.test.ts`: present for an owner reading, absent for the others | 2 |
| 23 | Gifts stay open after the holder is removed, demoted, leaves, or is erased | Route, `registry-contribute.test.ts` and `registry-guest.test.ts`: each of the four, then contribute answers 409 `cash_gifts_unavailable` and the guest list offers no money and no fund | 3 |
| 24 | Gifts stay open with no recorded holder | Route: an account with a NULL holder closes | 3 |
| 25 | Gifts stay closed after the holder is seated again | Route: re-seat; contribute succeeds with the switch on | 3 |
| 26 | Money gifts can be turned on with the holder absent | Route, `registry.test.ts`: 409 `payout_holder_absent`; turning off succeeds. E2E (PR 4): the same 409 to the browser's session | 3 |
| 27 | A viewer learns the account's holder is not an owner | Route: a viewer's settings say `not_offered` or `cash_gifts_off`, `payoutHolderAbsent` is null, and no connector id | 3 |
| 28 | The refresh and the gate disagree | Route: after the holder leaves, `…/stripe/refresh` answers `payoutHolderAbsent: true`, and the next registry read the reason `payout_holder_absent` | 3 |
| 29 | The holder is offered no hand-over, or another owner is | E2E: on a seeded wedding the dev profile holds with Kit as the other owner, "Hand money gifts to another owner" hands to Kit; the panel shows no account; the row has none, generation 1, and a retired-accounts row with reason `handed_over`. On Money Wedding, Kit's account, the dev profile sees neither control | 4 |
| 30 | An owner cannot replace an absent holder's account | E2E: on a seeded wedding whose holder Kit is now an editor, the panel shows the absent-holder words and the registry read says `payoutHolderAbsent: true`; "Use your own account" retires it and connects a new Express account through the Stripe stand-in, which gains `POST /v1/accounts` and a `POST /v1/account_links` that answers a `https://connect.stripe.com/…` address (the only origin the portal sends the browser to, `RegistrySettingsView.tsx:197-203`), which the flow routes itself as the OAuth section does (`cire-registry-money.flow.ts:604-622`); the row names the new account with the dev profile as holder | 4 |
| 31 | The named owner, an editor, or a portal after a 403 sees the wrong view | Component, `RegistrySettingsView.test.tsx`: signed in as Kit after a hand-over; as an editor on an absent-holder wedding (the reason only, no button); after a 403 `stripe_connector_only` (not the absent view) | 4 |
| 32 | The gift-log line is missing or misplaced | Component, `RegistryView.test.tsx`: the line under a marked gift only. Seeded gifts carry no account, so the E2E cannot reach it | 4 |
| 33 | The hosts panel removes or demotes the holder without a warning | Component, `HostsPanel.test.tsx`: the warning on the holder's row, none on another's | 4 |
| 34 | The other owners are not told the holder left, or the paragraph is lost to a fast retire | Unit, `owner-notice-email.test.ts`: removal, demotion and leave of the holder carry the paragraph to the owners and the subject; of anyone else, they do not. Service, `hosts.test.ts`: the remove and role writes return the holder flag as it stood before the change | 5 |
| 35 | The deletion preview blocks on a payout account, misses one, or passes 200 actions | Route, `internal-account-deletion.test.ts`: one action with default `close` per such wedding; none for a wedding the person owns alone; past 20, one action for the rest | 5 |
| 36 | A retired Standard account is handed back early, or never | Service, `maintenance-sweeps.test.ts`, with a recording Stripe client: no call while a settings row names it, while any unreleased retired row naming it is inside its time, or while a gift on it is pending with a session and younger than 14 days; one call when all allow, even with an older released row and a stale pending gift; a deauthorize error followed by an account read Stripe refuses releases it; a deauthorize error followed by an account read that succeeds (a bad client id) releases nothing and sets `last_hand_back_at`, and the next run takes another account first. Route, `stripe-webhook.test.ts`: a deauthorization releases the retired rows connected before it and not one connected after | 5 |
| 37 | Another path hands a retired account back early | Route, `registry-stripe-oauth.test.ts`: a refused OAuth connect of an account an unreleased retired row holds is not handed back. Service, `maintenance-sweeps.test.ts`: purging another wedding naming it does not hand it back; purging the wedding that retired it does, when nothing else holds it; a purge whose delete matched nothing (the wedding was restored) hands back nothing | 2 |
| 38 | A retired Standard account's own sales look like missing gifts | Route, `stripe-webhook.test.ts`: an unmatched money event on it logs at info level and counts as `standard` | 2 |

The tests that prove a refusal or a redaction (13, 14, 15, 22, 26, 27) stay even where an E2E step shows the same screen: `AGENTS.md` keeps refusal and redaction tests.

## Rollout

One pull request each. Each fits one agent run.

| # | Pull request | Covers | Packages | Agent |
|---|---|---|---|---|
| 1 | Gifts keep their account | The two contribution columns, their back-fill and index; the generation column, its trigger and the guarded attach; matching by the gift's account (behaviour 1); the new create key; the reuse lookup and checkout key (7). Tests 1-11 | `@cire/db`, `@cire/api` | implementer |
| 2 | Retire, in the API | The holder predicate and `payoutHolderAbsent` in every settings record and the refresh, reported but closing nothing (2); the retire route and the retired-accounts table (6); the retire notice (8); the gift-log flag (10); the hosts flag (11, API); the two existing hand-back paths and the unmatched log learning retired rows, and a deauthorization releasing them (13, all but the sweep). Tests 12-22, 37, 38, and 36's webhook half | `@cire/db`, `@cire/api`, `@shared/email` | implementer |
| 3 | Close money gifts | The gate, the switch and the reader rules (3, 4, 5); every route-test fixture that seeds an account given a seated holder, and the suite's seeds given one. Tests 23-28 | `@cire/api` | implementer |
| 4 | The panel, both partners' views | Every row of [What each owner sees](#what-each-owner-sees), the dialogs, the gift-log line, the hosts panel's warnings (11); two seeded weddings; the stand-in's Express calls; the E2E. Tests 29-33, and 26's E2E half | `@cire/host`, `@cire/api` (seeds), `@tools/e2e` | designer |
| 5 | Telling and handing back | The owner-change paragraph (9); the erasure preview (12); the hand-back sweep (13). Tests 34-36 | `@cire/api`, `@shared/email` | implementer |

1 and 2 merge on their own, in that order: neither changes what a guest can do. 2 adds the retire route with no portal control yet, so only a direct API call reaches it, and it carries everything that keeps a retired account's record and time safe, so nothing in the stack after it has to land first. **3, 4 and 5 are one stack** (`wiki/conventions/stacked-prs.md`), 4 on 3 and 5 on 4, merged in one queue round, so no release carries the closure without the panel that explains it and the notice that tells the owners. A round can stop after 3 has landed (`wiki/conventions/stacked-prs.md`, §Merge order), and the daily production release could then carry 3 alone. So 3 opens as a draft whose `**Do not merge until**` line names 4 and 5, and its `## Impact` carries an owner action: **At deploy** — do not approve a production release that carries 3 without 4 and 5. A pull request that changes `@shared/email` carries two changesets, since that package is versioned and `@cire/*` is not (`AGENTS.md`, §Changesets).

No release-time check is needed. Pull request 3 closes money gifts on every wedding whose account has no seated holder, as decision 1(a) asks; it can only stop money, never send it anywhere else, and the panel says why to every owner and editor who opens it. The builder may count such weddings on the dev tier, which agents may read; no step reads a production database.

Each pull request updates the wiki pages it makes stale: `wiki/cire/cire-registry.md` (the connector rules; the hand-run "record a connector" statements, which an owner's replace makes unnecessary; §One account, several weddings; `registry_contributions`), `wiki/cire/cire-auth.md`, `wiki/cire/stripe-webhooks.md`, `wiki/compliance/access-control.md`, `wiki/compliance/data-map.md`, `wiki/compliance/dsar.md` and `wiki/compliance/retention.md` (two contribution columns and a table that name a Stripe account), and the Stripe launch checklist in `wiki/compliance/subprocessors.md`.

## Rejected

- **Moving the Express account to the other partner.** Stripe does not let cire change an Express account's identity after the first account link, and the original holder keeps the sign-in.
- **Keeping gifts flowing to the old account until the new one is ready.** It needs a second account slot on every row, which every account-state writer (`applyStripeAccountState`, the refresh, the attach, the reuse, the OAuth callback, the detach) and the guest gate would have to learn. Approval item 2 offers it as the alternative.
- **Expiring the guest's open pages on the old account.** It buys at most an hour, needs a Stripe client in the hosts and erasure routes, and a gift paid on such a page is recorded anyway (behaviour 1). Approval item 10.
- **Deleting or rejecting a retired Express account.** Deleting needs a zero balance and ends refunds; rejecting stops the old holder's payouts.
- **Recording whom a hand-over named on the wedding.** It would grant nothing, since any owner may connect once the account is retired, and it goes stale when that owner leaves. The notice carries the name.
- **A profile id in the create key.** Stripe asks for no personal identifiers in keys; a generation counter changes as often.
- **An email at erasure.** The erasure call is held to 50 D1 queries and may be repeated until it finishes (`account-erasure.ts:25-28`, `:74-79`), and it holds none of the notice machinery. Approval item 6.
- **A release-time count of the weddings pull request 3 closes.** Its safety does not depend on the count, and no release step runs SQL of that kind today (the one production read a release makes is the migration ledger, `shared/infra/src/production-live.ts`).
- **Routing gifts through the platform.** Decision 2.

## Needs the owner's approval

1. **The design as a whole**: a hand-over is a new account and a retire, never a move (§What Stripe allows), built in the five pull requests above.
2. **The gap during a hand-over.** Guests cannot give money from the retire until the next holder's account can take payments: minutes if the couple do it together, longer if not. Alternative: keep the old account taking gifts until the new one is ready, at the cost in §Rejected, about one more pull request. Recommendation: the gap.
3. **Who may replace an absent holder's account**: any owner. Alternative: only the owner the leaving holder named, which leaves a wedding stuck when the holder left without naming anyone. Recommendation: any owner.
4. **How long a retired Standard account stays connected** before cire hands it back (behaviour 13). Handing it back ends cire's read-write access to it, and with it every later refund and dispute event for its gifts. Options: (a) no extra time: the next sweep once no gift on it is pending; (b) 120 days after the retire, so refunds and most disputes on its gifts still reach the gift log; (c) never. The holder can end cire's access themselves at any time, from their own Dashboard. Recommendation: (b).
5. **"Pointed at the money-gifts switch"** (decision 1(b)), read as: the notice and the panel link Money gifts, say money gifts have stopped, and offer two actions, connect your own account or turn money gifts off so they stay off if the holder comes back. The switch survives a change of account, as it survives a deauthorization today. Confirm the reading.
6. **Telling the owners after an erasure.** The erasure sends no owner-change notice today, so decision 1(b)'s notice has nothing to ride on. Proposal: the panel alone tells them, and the deletion preview tells the holder before they go (behaviour 12). Alternative: a notice naming no one, which needs the erasure to read the holders before its batches and send at most once across repeated calls. Recommendation: the panel and the preview.
7. **Tier purchases stay out** of this design (§Tier purchases stay out).
8. **At Stripe, not in code:** keep "Issue refunds" and "Manage disputes" turned on in the Express Dashboard settings, since after a retire the old holder is the one person who can refund or answer a dispute on their gifts there.
9. **A departed holder's own Standard account stays on the old wedding** until a remaining owner replaces it, and while it does, it cannot be connected through OAuth to another wedding of theirs, since they no longer hold a seat on the wedding that names it (`accountMayJoin`, `registry.ts:1623-1630`, as today). Their exit is to revoke cire in their own Stripe Dashboard, which clears it from every wedding (`detachStripeAccount`), then connect it again. Recommendation: confirm; letting a non-owner act on the wedding is a bigger change.
10. **Up to an hour after a retire or after the holder leaves,** a guest who already holds a payment page can still pay into the old account (behaviour 7). Decision 1(a) says money gifts close; this is the one way money still moves, and it is recorded. Alternative: expire those pages, at the cost in §Rejected. Recommendation: accept the hour.
11. **Editors learn that the account's holder is not an owner** (behaviour 5). Today an editor is told nothing about whose account it is (`settingsForReader`, `registry.ts:766-772`); with this reason and the hosts list, which every member reads, an editor can work out that gifts were reaching a former owner. Decision 1(a) asks the panel to say why, and editors see that panel. Alternative: tell editors only that money gifts are closed and an owner can say why. Recommendation: tell them, since editors run the gift list and are the ones guests ask.
12. **The departed holder is not told when the remaining owners replace their account.** They were told when they left (behaviour 9). Alternative: a short notice that the wedding no longer uses their account. Recommendation: no notice, since they no longer belong to the wedding and nothing they hold changes.

---
title: Cire invite design selector
tags: [systems, web, api, cire]
related:
  - "[[index]]"
  - "[[cire-invite-builder]]"
  - "[[cire-auth]]"
  - "[[cire-plus-ones]]"
  - "[[cire-entitlements]]"
  - "[[cire-consent]]"
  - "[[browser-tests]]"
  - "[[frontend-patterns]]"
last-reviewed: 2026-10-03
---
# Invite design selector

A wedding's invite renders as one of several full template packs. The design id
lives on `wedding_invite_customisations.design_id` (0045, default `classic`);
the guest `[slug].astro` SSR fetch resolves it — same link, zero extra
round-trips.

## Pieces

- **Catalog** — `@cire/invite-designs`: `DESIGNS` (`{ id, name, tier }`),
  `DesignId` union, `isDesignId`, `DEFAULT_DESIGN_ID`. Single source of truth
  for api validation, the organiser selector, and the web registry keys.
- **API** — both invite GETs surface `designId`;
  `PUT /api/organiser/weddings/:weddingId/invite/design` (weddingEditor)
  validates against the catalog (unknown → 422) and refuses a `premium` design
  (403 `premium_design`) unless the wedding is on the Crimson plan tier or
  holds the one-off `premium_templates` entitlement (`hasPremiumTemplates`,
  given the tier `weddingEditor` already read: no statement on Crimson, the
  entitlement probe alone below it — see [[cire-entitlements]]). `inviteService.setDesign` bumps
  `updatedAt` only — never `imagesUpdatedAt` (WT-P-I1).
- **Web** — `cire/invites/src/designs/`: `registry.ts` maps `DesignId` →
  per-design component tree (`classic/` holds the original layout);
  `resolve.ts` (`resolveDesignId`) falls back to classic on unknown ids so a
  guest invite never 500s. Registry imports `.astro`, so vitest tests target
  `resolve.ts` only. Truly shared pieces (LoginSection, RsvpModal,
  DetailsModal, EventCard, PulseAccountLink, invite-theme, invite-images) stay
  in `components/`.
- **Organiser** — Design section in `InviteBuilder`; card per catalog entry,
  lock badge on a premium design the wedding cannot use, instant save. The lock
  reads `premium_templates` from the wedding list's `entitlements`, which the
  API fills for a Crimson wedding as well as for one holding the row. **The live previews
  follow the pack** (2026-08-06): `invite/design-layout.ts` names each pack's
  structural signature and `HeroSample`/`SectionSample` render it, so switching
  designs visibly re-shapes the miniature. See [[cire-invite-builder]] §preview.

## The claim and welcome panel

Every pack draws the claim and welcome panel through one component,
[`LoginSection`](../../cire/invites/src/components/LoginSection.tsx). A pack
passes its data and a `layout`; it draws none of the panel's markup.

| `layout` | Pack | Shape | Paints the welcome tone on |
|---|---|---|---|
| `band` (default) | classic | full-bleed section, centred column | the whole section |
| `panel` | gala | 400px bordered card, centred on phones, flush with the page's left gutter from `md` up | the card only |

The two words are the ones the organiser preview uses for the same section
(`welcome` in `design-layout.ts`, see [[cire-invite-builder]]). A layout chooses
class strings only — the frame, the heading size curve, the form width, the
measure, and the greeting's gold: the metal `text-gold` only where the heading
is large text (`band`, 2rem × 0.85 = 27.2px at the smallest heading scale),
`text-gold-ink` elsewhere. Headings follow the organiser's heading typography
in every layout.

Before a claim the panel shows the code entry. After it, the greeting (see
[Returning households](#returning-households)), the RSVP-by line, and the
household's controls in this order:

1. **Plus-one prompt** — `PlusOnePrompt`, for a household with a member the
   couple lets bring a guest or a plus-one already named: name, rename or
   remove a guest until the RSVP deadline, read-only after it. The pack passes
   `onPlusOneChange` and applies each change to its claim result; without it
   there is no prompt. Hidden in host preview. The contract is in
   [[cire-plus-ones#On the invite]].
2. **Pulse account linking** — `PulseAccountLink`, with the OSN auth client's
   core inside its chunk. The panel draws it only when the claim payload's
   `accountLink` offers linking (`cire.account-linking`, [[feature-flags]];
   never in host preview), and hands it that state. It offers no plus-one's
   seat, and the API refuses one.
3. **Sign-out** — "Not {name}? Sign out". The panel itself revokes
   `cire_session` (`POST /api/claim/signout`, see [[cire-auth]]), drops the
   restore hint, resets its form and clears the inline styles the unlock
   animation left on it. Outside host preview it also ends the OSN sign-in
   the account link uses (`POST /api/auth/signout`, through an on-demand
   import of `@shared/rp-auth`): the household cookie does not cover it, and
   on a shared device the next household would otherwise find it signed in.
   In preview that session is the organiser's portal sign-in, so it stays.
   The pack's `onSignOut` resets only the pack's own state.

The prompt and the account link are `lazy()`, each in its own `Suspense`. Their chunks start downloading when a claim begins (a typed code
or the `?code=` deep link) or, when the restore hint is present, at mount beside
the session restore — never for a visitor who does not submit a code.
`tests/components/LoginSection.lazy.test.tsx` fails if an import turns static,
and it and `LoginSection.warm.test.tsx` pin when the download starts.

The panel also records the restore hint (`noteClaimed`) when a code is
claimed. The pack keeps the claim result, the reveal choreography
(`revealed`, `formRef`, `welcomeRef`), the session restore and the events
section.

The Pulse box sits above the events, so it must never arrive after them. It
makes no request to draw itself: the claim and restore responses say whether
linking is offered, which seats are linked and whether the browser is signed
in to OSN ([[cire-auth]]), so the box appears in the same pass as the welcome
panel. It does not mount the auth client's Solid `AuthProvider`, whose session
request on mount would hold it back one request. Only its chunk can delay it,
and that download starts as the claim or restore begins.
`tests/components/LoginSection.link-state.test.tsx` renders the real panel with
every request held unanswered and fails if the box waits on one.

## Returning households

A household that has replied before, fully or in part, is greeted as returning.
The copy is the owner's, word for word:

| Where | First visit | Returning |
|---|---|---|
| Panel heading | "Welcome, the {familyName} Family" or "Dear {name}" | "Welcome back to your invite, the {familyName} Family" or "Welcome back to your invite, {name}" |
| Line under the heading | none | "You still have replies to give", while replies are owed |
| Hero title, only when the organiser set none | "You're Invited" | "Welcome back to your invite" |

The organiser's own hero title is never replaced, and neither is their welcome
message, which still follows the heading. The tab `<title>`
(`lib/invite-title.ts`) does not change: the server renders it and never knows
the household.

**Returning means the household replied itself.** The claim payload, from
both the code entry and the session restore, carries one flag for the
household, `householdReplied`: true when any of its reply rows has a
`consent_source` other than `organiser_attested`
([`claim.ts`](../../cire/api/src/services/claim.ts)). So a reply the couple
recorded by phone or on paper does not make a first visit a return. That
covers a household reply, the household's reply for its plus-one, and a host's
status change over a household reply that holds a dietary answer, since that
save keeps the household's consent basis. The flag is a total for the
household, not a field on each row, though with one reply on file, or only a
host's, it does show their source; the household those replies are about is
its only recipient, and no organiser id leaves the API.

The rows keep only their latest writer. When a host saves a full reply over a
household's, or changes the status of a household reply that has no dietary
answer, the row becomes the organiser's and nothing stored says the household
answered it first. A household whose every reply a host has saved over in that
way is greeted as a first visit. The guest site reads only `true`: an API that
does not send the flag, or a value this build does not know, gives the
first-visit greeting and never costs the invite.

**The replies line comes from the rows.**
[`inviteProgress(members, rsvps)`](../../cire/invites/src/components/invite-progress.ts)
counts every row, whoever wrote it, since a host's phone reply does answer the
event:

- `not-started` — no reply on file at all.
- `partial` — an invited member still owes a reply for an event they are
  invited to now.
- `complete` — every invited member has replied to every such event. A
  plus-one is not waited for, as with the tick on each event card
  (`hasHouseholdResponded`), and a "maybe" counts as a reply.

**`LoginSection` decides, once per household.** It takes `householdReplied`
from the claim result the invite opened with — a typed code, the `?code=` link
or a restored session — and keeps it while the same household (by `publicId`)
stays signed in, so a first visit stays one whatever the guest sends during
it. Sign-out clears it. Host preview always gets the first-visit copy. The
replies line, by contrast, is live: it shows while `inviteProgress` reads
`partial`, goes once the last reply is in, and never shows once RSVPs have
closed, when nothing more can be given.

**The hero hears it through a shared signal.** The hero is a separate island,
so the panel publishes its verdict in
[`returning-household.ts`](../../cire/invites/src/components/returning-household.ts),
which both islands import. How the signal stays out of the server render and
out of hydration is in [[frontend-patterns#Sharing state between islands]].
Both surfaces change on page load when the session restores and at the moment
a code is accepted. For a typed code the hero is above the guest's scroll
position by then.

The swap has a cost on a hero with no couple title. Once the restore lands, the
longer title wraps to one more line, which moves the title block within the
hero: a layout shift inside it, with nothing below the hero moving, since the
hero is at least the screen's height. Whether it also moves Largest Contentful
Paint on a hero with no image is unmeasured. A hero with a couple title, the
usual case, does not change.

Tests: in `@cire/api`, `tests/services/claim.test.ts` ("householdReplied in the
claim payload"). In `@cire/invites`, `tests/components/invite-progress.test.ts`,
`tests/components/LoginSection.test.tsx` ("returning household"), both packs'
`InvitePage.test.tsx` (a first-time guest's greeting survives their first
reply), `tests/components/returning-household.test.ts` and its `.ssr` twin,
and `tests/designs/InviteHeader.ssr.test.tsx`. In real Chromium,
`InviteHeader.browser.test.tsx` checks that the welcome-back title still stops
above the scroll cue at 320px and at both test widths.

## The hero scroll cue

Every pack's hero fills the screen, so nothing below it shows. A small gold
chevron at the hero's foot,
[`HeroScrollCue`](../../cire/invites/src/components/HeroScrollCue.tsx), tells
the guest the page carries on. A pack renders it as the last child of its hero
`<section>` and passes an `align`:

| `align` | Pack | Sits |
|---|---|---|
| `center` (default) | classic | centred under the centred title |
| `end` | gala | in the inline-end corner on the hero's 1.5rem gutter, opposite the bottom-left title |

- **A hint, not a control.** `aria-hidden` and `pointer-events-none`; a tap
  goes to the hero beneath it.
- **Motion is CSS, and it stops.** `animate-scroll-cue` (`styles/global.css`)
  fades the glyph in 1s after load, drifts it 6px down and back twice, and
  leaves it at rest. Fade and drift take 4.6s together: motion that starts by
  itself and runs past five seconds needs a control to stop it (WCAG 2.2.2),
  so a longer or endless drift is not an option. Both play from the server's
  HTML, before the island hydrates.
- **The first scroll hides it for good.** `createFirstScroll`
  ([`first-scroll.ts`](../../cire/invites/src/components/first-scroll.ts))
  turns true on the first scroll below the top, or at mount on a page the
  browser restored part-way down, and never turns false again. The cue then
  fades out over 500ms and pauses its drift; scrolling back to the top does
  not bring it back. The latch belongs to the mounted hero, so a hero that
  remounts reads the scroll position afresh.
- **Reduced motion needs nothing of its own.** The global clamp lands the
  entry at full opacity at once and runs the drift out to rest, so the cue is
  there and still. The hide still happens, without the fade.
- **It takes the bottom 1.875rem of the hero** (a 1rem offset under a
  0.875rem glyph; the drift moves down, never up). A pack's hero keeps at
  least 2.5rem of bottom padding under its title, so a title long enough to
  grow the hero still stops above the cue. The cue's offset carries no
  `env()` inset: an inset can only widen that padding, never move the cue
  into the title.
- **On a phone the consent prompt is a dialog, and the cue stays put.** Below
  the `md` breakpoint the first-visit consent prompt ([[cire-consent]]) is a
  modal dialog. It publishes no height, so the cue rests on the hero's foot;
  the dialog's backdrop covers it until the guest answers, and then nothing
  sits over the hero.
- **From `md` up it rises above the consent banner.** There the prompt is a
  banner fixed to the bottom of the screen until the guest answers it. While
  it is up it publishes its height as `--consent-banner-height` on `<html>`,
  and the cue moves up by that much
  (`-translate-y-[var(--consent-banner-height,0px)]`), so it sits 1rem above
  the banner's top edge; once the guest answers, the property goes and the cue
  slides back over 500ms. A `translate`, not a change to `bottom`, so the move
  adds no layout shift, and the browser test fails on any shift it records.
  The same happens on a phone once the guest has dismissed the dialog without
  answering, because the prompt then carries on as the banner.
- **The banner still covers gala's title until it is answered.** The cue
  moves; the title does not. Gala anchors its title bottom-left, and with the
  banner up the bottom of the title is under it at every width from `md` up,
  on landscape phones (which are wider than `md`), and on a phone after a
  dismissed dialog — where a two-name title also reaches the lifted cue at
  375x667 and 390x844. At 1440x900, "Anita & Ben" spans 732–858px and the
  banner's top edge is at 774px. Classic's centred title clears the banner on
  tablet and desktop screens, but a landscape phone is too short for it: a
  two-name title runs under the banner there (844x390: the banner's top edge
  at 272px, the title to 399px).

  *Measured 2026-10-02 and 2026-10-03 — a throwaway Vitest browser test in
  Chromium rendering each pack's `InviteHeader` with the banner up, comparing
  the title block's and the banner's `getBoundingClientRect()`.*

`tests/designs/InviteHeader.browser.test.tsx` measures all of this in both
packs, at phone and desktop width, and the prompt's two forms over a two-name
title at 320x568, 375x667, 390x844 and 1440x900 ([[browser-tests]]).
`tests/designs/InviteHeader.ssr.test.tsx` checks the cue is in each pack's
server HTML, and fails when the catalog gains a pack it does not list.

## Adding a design

1. Catalog entry in `@cire/invite-designs` (type error in the web registry
   until step 2 lands).
2. New pack folder `cire/invites/src/designs/<id>/` + registry entry. Each pack's
   `Document.astro` owns its font preloads and islands, so guests never
   download another design's assets. The pack renders `<LoginSection>` with a
   `layout`; a new panel shape is a new row in its `LAYOUTS` table, never
   markup of the pack's own. Its hero ends with `<HeroScrollCue>` and keeps
   2.5rem of bottom padding under the title (see
   [The hero scroll cue](#the-hero-scroll-cue)); list the pack in
   `InviteHeader.ssr.test.tsx` and `InviteHeader.browser.test.tsx`.
3. Row in `cire/host/src/components/invite/design-layout.ts` describing how
   the pack is SHAPED, so the builder's preview stops previewing it as Classic.
   Not optional — `design-layout.test.ts` asserts every catalog id has its own
   entry, so step 1 without this fails the organiser suite.
4. Tier `premium` → gate already enforced; no api change.

## Testing seams

- `AppOptions.inviteDesigns` / `createInviteOrganiserRoutes` 5th param inject
  a test catalog (the launch catalog is all-free, so premium-gate tests add a
  fixture design).

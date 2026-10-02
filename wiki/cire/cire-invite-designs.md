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
last-reviewed: 2026-10-02
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

Before a claim the panel shows the code entry. After it, the greeting, the
RSVP-by line, and the household's controls in this order:

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
  0.875rem glyph; the drift moves down, never up). A pack's hero keeps at least 2.5rem of
  bottom padding under its title, so a title long enough to grow the hero
  still stops above the cue. The cue's offset carries no `env()` inset: an
  inset can only widen that padding, never move the cue into the title.
- **The consent banner covers it on a first visit.** The banner
  ([[cire-consent]]) is fixed to the bottom of the screen until the guest
  answers it, and the cue sits underneath. Left that way on purpose: a guest
  who scrolls with the banner up has found the scroll, which is all the cue
  is for, and one who does not has to answer the banner to clear the screen,
  by which time the cue is showing.

`tests/designs/InviteHeader.browser.test.tsx` measures all of this in both
packs, at phone and desktop width ([[browser-tests]]).
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

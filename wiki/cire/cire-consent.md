---
title: Cire site-wide consent framework
tags: [architecture, privacy, compliance, web, cire]
related:
  - "[[index]]"
  - "[[cire-invite-builder]]"
  - "[[cire-invite-designs]]"
last-reviewed: 2026-10-08
---
# Site-wide consent framework

Where the guest site's cookie/third-party consent lives, what it governs, and
the rules for adding a vendor to it. Code: `cire/invites/src/lib/consent/` (logic)
and `cire/invites/src/components/consent/` (UI).

## Why it exists

Before this, consent was a property of one component. `PinterestBoard.tsx`
carried its own `cire:pinterest-consent` localStorage key, its own module-level
signal, its own prompt and its own copy — and it was the *only* gate on the
site. The Google Maps venue embed made an equivalent transfer (guest IP + UA) to
an equivalent US recipient with no gate at all, not because anyone had decided
that was acceptable but because nobody had written it one. Consent lived
wherever someone had remembered to put it, which meant a new embed shipped
un-gated by default.

The framework fixes the structural problem rather than the Pinterest-shaped
symptom: every third party is governed by one wrapper and declared in one
registry, so a new embed either goes through the gate or is a visible, deliberate
omission. A wrapped embed waits for the guest's yes (see the defaults below),
and stays listed where the guest can switch it off again — which the old
arrangement could not offer for anything but Pinterest.

## The model

**The site does no personal tracking, and consent is asked for exactly two
things.** What the invite stores or loads to work at all — the claim-code
session cookie, the record of these choices, the Turnstile bot check — is
strictly necessary, needs no consent under ePrivacy, and is described in the
privacy notice instead of being switched. The two things that need consent are
the two third parties that see a guest's IP address and browser the moment
they load, and each has its own switch, so a guest can allow one without the
other.

| Category | Required? | Covers |
|---|---|---|
| `necessary` | yes, never a switch | `cire_session` claim cookie, Turnstile, the consent record itself |
| `pinterest` | no — "Pinterest moodboards" | The Pinterest moodboard in an event's details |
| `maps` | no — "Google Maps" | The Google Maps venue embed in an event's details |

Vendors declare which category they belong to; the preferences sheet shows one
switch per optional category, naming its company and linking its privacy
policy. Granting from a blocked embed's in-place button ("Allow Pinterest
moodboards") grants that switch and nothing else. There is deliberately **no
`marketing`, `advertising`, `analytics` or preferences category**: the site
does none of those, and an unused switch is a claim we would have to keep true.

## Defaults: nothing optional until the guest decides

| Category | Applies before a decision? |
|---|---|
| `necessary` | yes |
| `pinterest` | no |
| `maps` | no |

Both switches are off until the guest allows them — prior consent, the
ePrivacy posture for EU and UK visitors, applied to every guest. The prompt
holds the invite's pages until it is answered, so in practice the guest
decides on the first visit. Before then, and after a refusal, the map's place
is taken by the CSS map card (venue named, maps link out) and the moodboard's
by the standard placeholder and the outbound "View moodboard on Pinterest"
link.

### Three grant maps, and why they can't be collapsed

| Function | Meaning |
|---|---|
| `defaultGrants()` | **The floor.** Required only. What "Reject all" writes, AND what applies before the cookie has been read. |
| `preDecisionGrants()` | **Unasked.** Each category's `defaultGranted` — today equal to the floor. |
| `allGrants()` | Everything. What "Accept all" writes. |

Two traps this separation exists to avoid:

1. **Refused ≠ unasked.** Today they allow the same things, but only a refusal
   is a decision: unasked re-prompts, refused never does. Collapsing the two
   maps would also break the day a category's default changed.
2. **Pre-hydration ≠ unasked.** `record() === null` means "we haven't looked
   yet" before hydration and "we looked, there's nothing" after. Only the second
   may resolve to the pre-decision defaults; the first must hold at the floor, or
   every page load would ignore a refusal for one tick. Enforced in
   `store.ts`'s `isCategoryGranted`.

## Files

| File | Responsibility |
|---|---|
| `lib/consent/categories.ts` | The categories — `necessary` and the two switches, `pinterest` and `maps` — with their display metadata. |
| `lib/consent/vendors.ts` | **The vendor registry** — one source of truth (see below). |
| `lib/consent/record.ts` | The persisted record: versions, grant normalisation, encode/decode. |
| `lib/consent/cookie.ts` | Cookie transport (`__Host-cire_consent` / `cire_consent`). |
| `lib/consent/store.ts` | Module-level Solid signals shared by every island. |
| `lib/consent/testing.ts` | `seedConsentForTest` / `resetConsentForTest`. |
| `components/consent/ConsentGate.tsx` | The wrapper + the default blocked-content placeholder. |
| `components/consent/ConsentBanner.tsx` | The first-layer prompt — a dialog on the invite's pages, a bottom banner on the legal pages — and the standing `ConsentPreferencesLink`. |
| `components/consent/ConsentPreferences.tsx` | The "Choose" dialog. |

## The vendor registry is the source of truth

`vendors.ts` drives the preferences dialog, the `/privacy` page's third-party
list, and (by test assertion) the CSP origin allowlist in
`lib/security-headers.ts`. The same facts used to be maintained in four places
that drifted independently — the consent copy inside the component, the privacy
prose, the CSP, and `wiki/compliance/subprocessors.md`. Adding a vendor meant
four edits, and forgetting one produced either a CSP block (loud) or an
undeclared transfer (silent, and the one that matters).

**To add a third party:**

1. Add a `ConsentVendor` entry to `CONSENT_VENDORS`. A `"gated"` vendor must
   also declare `runsInPage` (see below); the type check fails until it does.
2. Add its origins to `CSP_DIRECTIVES` in `lib/security-headers.ts` —
   `vendors.test.ts` fails until you do.
3. Give it its own switch: a category in `categories.ts`, off by default, with
   a title the placeholder's "Allow" button and the preferences sheet use.
   Wrap the component in `<ConsentGate category="…" vendor="…">`, and check the
   prompt's copy still names it.
4. Bump `CONSENT_POLICY_VERSION` in `record.ts` (this re-prompts everyone — see
   below).
5. Add a row to the root `[[compliance/subprocessors]]` register.

### `enforcement: "gated" | "always"`

Each vendor states plainly whether the gate actually blocks it. A registry that
listed a vendor the gate didn't block would be a lie told in a compliance-shaped
voice.

- `"gated"` — the guest's choice genuinely controls it: no request is made while
  the category is switched off. Pinterest and Google Maps both mount inside the
  click-opened details sheet, so they never appear in server-rendered HTML and a
  client-side gate is sufficient. "Gated" means *withheld until the guest's
  yes*, and switchable off again after.
- `"always"` — loads regardless. **Google Fonts only**, because the font
  `<link>` sits in the `<head>` of the server-rendered document. The right fix
  is to delete the vendor (self-host the two woff2 families), not to put the
  site's typography behind a switch and swap the typeface mid-visit. Tracked as
  an issue under `label:product:cire`. Until then the dialog and `/privacy` both say "loads on every
  visit" rather than implying the toggle covers it.

### `runsInPage` — gated vendors only

Every `"gated"` vendor states where its code runs, because that decides whether
switching its category off needs a page reload (see the next section).
`ConsentGate` unmounts the embed either way; the question is whether the unmount
stops everything the vendor started.

| Vendor | `runsInPage` | Why |
|---|---|---|
| Pinterest | `true` | `pinit_main.js` is a `<script>` in the invite page. Its globals, listeners and timers outlive the unmount. |
| Google Maps | `false` | The embed is a sandboxed cross-origin `<iframe>`. Removing it destroys that browsing context and everything running in it. |

Storage is not the test. A reload clears neither a vendor's storage on its own
origin nor anything it wrote to ours, so a vendor that sets cookies but runs
only in its own frame is still `false`.

## Storage

A cookie, `Path=/`, `Max-Age` 182 days, `SameSite=Lax`. Not `HttpOnly` — client
code rewrites it.

**One name per origin.** On https the cookie is `__Host-cire_consent`; on http
(local dev) it is the bare `cire_consent`, because `__Host-` cookies are
rejected outright without `Secure`, which http can never set. `cookie.ts`
chooses the name once (`consentCookieName`) for both writing and reading, and
**a secure origin never reads the bare name** — not as a fallback, and not to
carry it over onto the `__Host-` name. A script on a sibling
`*.cireweddings.com` origin can set a `Domain=.cireweddings.com` cookie of the
bare name, and honouring it would let that origin decide for the guest — turn a
stored refusal back into "allowed", or answer the prompt on a first visit.
`__Host-` is a browser-enforced promise (rejected without `Secure`, `Path=/`,
and no `Domain`), so only this origin can have set it.

The cost is one question: a guest whose choice exists only under the bare name
on https is asked again. Nothing migrates it.

**Why a cookie and not `localStorage`** (which the old Pinterest gate used): a
cookie is the only store the server can read. Both currently-gated embeds mount
client-side, so localStorage would technically do — but that is a property of
where those two components happen to live, not of the framework. The moment a
third party needs to load from the `<head>` or from SSR'd markup (an analytics
tag, a chat widget, the font `<link>`), a client-side store is structurally too
late: the request has gone before any script reads it.

`SameSite=Lax` not `Strict`, because a guest arriving from the couple's emailed
link is a cross-site top-level navigation and `Strict` would withhold the cookie
on exactly that first hop — re-prompting someone who already decided.

### Withdrawal stops code that already ran

Switching a category off unmounts its gated embeds immediately — `ConsentGate`
doesn't render children, it disposes them, so no further request escapes. For
an embed that runs in its own iframe, that is a full teardown. For one whose
script ran in the invite page, it is not: the globals it set, the listeners it
attached and the timers it started stay live after the DOM node is gone. A
guest who allowed the moodboard, opened an event's details sheet and
later switches it off does so with a third-party context already live.

`saveConsent` (`store.ts`) reloads the page — `location.reload()`, via an
injectable module-level `reloadPage` reference so tests can substitute a spy.
The reload stops the vendor's code; it does not clear storage the vendor has
already written. Three conditions gate it, all load-bearing:

1. **Granted → revoked only.** Not revoked → granted, not a no-op save, not a
   first-time grant — none of those leave anything to tear down.
2. **A vendor with `runsInPage` must have rendered under the revoked category
   this visit.** `ConsentGate` calls `noteGatedContentLoaded(category, vendor)`
   when it renders children — never for the placeholder, which runs no
   third-party code — and the store keys what it records by the gate's own
   category, the one whose revoke unmounts the embed. Two cases skip the reload.
   A guest who saw only the map loses nothing to a plain unmount. And both gated
   vendors mount only inside a click-opened event details sheet, while the
   first-layer prompt holds the invite until it is answered, so a guest who
   answers it has almost never opened either. A reload in either case would spend a full
   document load, every island's hydration and a re-fetch of the invite to
   clear nothing. The record is a plain module-level `Map`, not a signal:
   nothing renders from it, and it resets on reload, which is exactly right,
   since a reload is what clears the thing it tracks.
3. **The cookie write must have actually succeeded**, checked with a read-back
   of `document.cookie` (`writeConsentToDocumentAndVerify` in `cookie.ts`)
   rather than trusting that the write call merely returned — it swallows
   failures by design (see "Storage" above). Reloading on an unpersisted
   refusal would discard the very refusal the reload exists to enforce: the
   guest would watch the page reload believing they'd just refused, and land
   back on the pre-decision defaults with no record of having tried.

The preferences dialog states this plainly rather than leaving it implicit — a
silent reload the guest didn't expect is its own kind of surprising — and says
the page "may" reload, because condition 2 means it does not always happen:
"Turning something off takes effect at once; the page may reload." It also
says "Data already sent can't be recalled.": neither the unmount nor the
reload takes back what a vendor received or stored. That is the short form;
`/privacy` states it in full, naming the company and when the data left.
`ConsentBanner.test.tsx` pins both sentences.

### Two versions, two jobs

- `CONSENT_RECORD_VERSION` — the storage shape. Bump when the record's structure
  changes incompatibly.
- `CONSENT_POLICY_VERSION` — the disclosure. **Bump whenever the vendor list or
  what a vendor does materially changes.** A guest who agreed to a Pinterest
  embed has not thereby agreed to whatever we add next month, so their stored
  consent was never *informed* about the newcomer and cannot be reused. A
  mismatch decodes to `null`, which re-prompts.

### `null` vs "refused everything"

The distinction the design turns on. `null` (no record) means **never asked** →
show the prompt. A record with every optional grant `false` means **refused** →
never re-ask. A prompt that reappeared after a refusal would be nagging the
guest towards consent.

## Hydration rule

`record()` starts `null` and is only populated in `hydrateConsent()`, which runs
from `onMount`. This keeps the server-rendered markup and the first client
render identical (both show the un-consented state), and nothing third-party can
load in the gap because gates deny until the same hydration completes. Every
gate calls `hydrateConsent` itself rather than depending on a prompt having
mounted first.

## UI rules that are not negotiable

- **On the invite's pages the prompt is a dialog the guest must answer.**
  The first-layer prompt is an `@shared/ui` `Modal` sheet at every width on
  both designs' pages, the gift registry and the 404 page. Nothing but an
  answer closes it, so once answered nothing is left over the invite's hero.
  - `closedby="none"` keeps Escape and the back gesture away from it in
    browsers that support the attribute, where the back gesture then goes
    back a page, as it does anywhere else. Elsewhere Escape and the back
    gesture fire a `cancel`, which is refused, and where the browser will not
    allow that (it does only after the guest has interacted), the dialog
    closes and a fresh one opens at once — so in those browsers the back
    gesture does nothing until the guest answers. A tap on the backdrop does
    nothing (`dismissable={false}`). There is no close button.
  - **It opens on its heading.** Focus never starts on an answer, which would
    be a nudge, nor on a link, where a stray Enter would leave the page.
  - **It links to both legal pages,** because it blocks the footer that
    otherwise carries them. The legal pages show the banner, never the
    dialog, so the guest can read the notice before deciding.
  - **A page restored from the back/forward cache reads the cookie again**
    (`refreshConsentFromDocument` on `pageshow`), so a guest who answered on
    the privacy notice and pressed back is not asked a second time.
- **On the legal pages the prompt is a banner.** `LegalLayout.astro` passes
  `prompt="banner"`: the prompt links there, and a dialog would stand between
  the guest and the notice they came to read. The banner rides the bottom of
  the screen at every width (`sticky`, the last box on the page), so at the
  end of the page it rests below the footer instead of over it, and while it
  is up the page keeps a bottom scroll padding of its height, so whatever Tab
  moves to is scrolled clear of it.
- **The prompt says what is off, and what turns it on.** It names Google and
  Pinterest and what they would see, says their content stays off until the
  guest allows it, and names "Accept all" as the answer that does. Asserted by
  test.
- **Refusing is exactly as easy as accepting.** The prompt's three answers are
  "Accept all", "Reject all" and "Choose", in that order, all drawn by one
  component (`BannerButton`, `cta` style) at the same size and weight: no
  answer is highlighted. "Reject all" is the refusal's one name, everywhere.
  Both forms render the same three buttons. `ConsentBanner.test.tsx` asserts
  the order and that the classes match, and `ConsentBanner.browser.test.tsx`
  that the dialog paints all three alike at 320, 390 and 1440px. `cta` ink is
  gold-ink, which the palette derivation holds at 4.5:1; a gold fill at rest is
  avoided because the derivation holds it at only 3:1 against the page ground.
- **"Choose" opens a small sheet with the two switches and Save** — nothing
  else. Each switch names its company and links its privacy policy, and each
  saves independently.
- **Rendering never writes a record.** The defaults apply without fabricating a
  decision, so the prompt keeps appearing until the guest genuinely makes one.
  An implied consent silently promoted to a stored, timestamped one would cost
  them the chance to refuse.
- **The sheet's switches show what is actually loading** — both off on a
  first visit, matching a page that loads neither.
- **The sheet's switches are a local draft** until Save. A guest who flicks a
  switch to see what it covers and then closes the dialog has granted nothing.
- **Withdrawal is permanent and findable** — `ConsentPreferencesLink` in
  `SiteFooter.astro` on every page, plus a copy on `/privacy`.
- **The consent dialogs reach above the details sheet.** The sheet is a
  `showModal()` dialog, so it renders in the **top layer**, which no `z-index`
  reaches — see [[wiki/shared/component-library]] §What has to sit above a
  modal, and [[top-layer-over-z-index-stack]] for why the guest site's scale
  ranks nothing against a sheet. The first-layer prompt and the preferences
  dialog are `showModal()` dialogs too, and carry no `z-index` because they
  have nothing to rank against. An undecided guest cannot open a sheet: the
  prompt holds the page until it is answered, and if it arrives while a sheet
  is already open it opens above it. Opening the preferences dialog from a
  blocked embed inside the sheet makes it the blocking dialog and the sheet
  goes inert beneath it. The banner carries `Z_LAYER.CONSENT` (200) and
  appears only on the legal pages, which have no sheets.

Only one mounted component renders the dialog at a time
(`claimConsentDialogHost`), or a page with both a prompt and a footer link would
open two stacked copies with two independent drafts.

## Legacy migration

The old `cire:pinterest-consent` key is **deleted on hydration, not migrated**:
that click was given against an older disclosure, so it is not consent to the
current one. Those guests are asked once more.

**`CONSENT_POLICY_VERSION` is `2026-10-08`.** Records made under `2026-07-29`
held a single `embeds` grant for both third parties together; reading it as a
yes or a no to the two separate switches would answer a question the guest was
never asked, so those records decode to `null` and the guest is asked again.
`CONSENT_RECORD_VERSION` is unchanged: a current record that still carries the
keys of removed categories (`functional`, `analytics`, `embeds`) parses, and
`normaliseGrants` ignores the extra keys.

## Where it's mounted

`<ConsentBanner client:idle />`, the dialog, in four document shells:
`designs/classic/Document.astro`, `designs/gala/Document.astro`,
`components/gift-registry/GiftRegistryDocument.astro` and
`components/NotFoundDocument.astro`. The fifth, `layouts/LegalLayout.astro`,
mounts the banner, `<ConsentBanner client:idle prompt="banner" />` (see the UI
rules above).
`tests/layouts/legal-layout.test.ts` reads the five shells as text and fails
if either form moves.

## Not covered

- **The organiser portal** (`cire/host`) has no consent surface. It loads
  no third-party embeds, and its users are authenticated hosts rather than
  guests. If it ever gains one, promote `lib/consent/` to a `@cire/consent`
  package rather than copying it.
- **Google Fonts** — see `enforcement: "always"` above.

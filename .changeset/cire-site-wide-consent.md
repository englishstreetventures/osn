---
"@cire/invites": patch
---

Replace the Pinterest-specific consent gate with a site-wide consent framework,
and gate the Google Maps venue embed behind it.

Consent used to be a property of one component: `PinterestBoard` carried its own
`cire:pinterest-consent` localStorage key, signal, prompt and copy, and was the
only gate on the site — while the Google Maps embed sent an equivalent IP +
user-agent transfer to Google on every event-details open, with no gate at all.

New `lib/consent/` provides a category model (`necessary` / `functional` /
`embeds` / `analytics`), a vendor registry that is the single source of truth for
every third party, a versioned consent record stored in a `cire_consent` cookie,
and a shared Solid store. New `components/consent/` provides the banner (Accept
all / Reject all / Choose, rendered through one component so refusal can never be
visually demoted), the per-category preferences dialog, a `<ConsentGate>` wrapper,
and a standing "Privacy Choices" control in the site footer.

`<ConsentGate>` does not render its children while a category is off, so a gated
component's effects never run — that is what makes the gate real for Pinterest's
injected tracker rather than merely cosmetic. Google Maps falls back to the
existing CSS map card instead of a permission notice, so refusing costs the guest
only the interactive tiles.

Defaults are **opt-out**: third-party content and preferences apply to a guest
who hasn't decided, and the banner says so plainly — naming Google and Pinterest
and offering the off switch — rather than asking a question whose answer has been
assumed. Analytics stays opt-in, because nothing uses that category yet and a
default can only cover what the guest was actually shown. Three grant maps are
kept deliberately distinct: the required-only floor (what "Reject all" writes,
and what applies before the cookie has been read), the opt-out defaults (what
applies once we know there is no stored decision), and accept-all. Collapsing the
first two would ignore a refusal for one tick on every page load.

The vendor registry drives the preferences dialog and the `/privacy` third-party
list, and a test asserts every declared origin is present in the CSP — so the
notice, the dialog and the security headers can no longer disagree.

Google Fonts is declared `enforcement: "always"` and disclosed as ungated in both
the dialog and `/privacy`: the font `<link>` is in the document `<head>`, so it
loads before any choice can apply. The fix is to self-host the fonts and remove
the vendor rather than to put the site's typography behind a switch.

Behaviour change: the legacy Pinterest consent key is deleted rather than
migrated. Under the opt-out defaults this no longer changes what a returning
guest sees — the embed loads either way — but it does mean the key is never
promoted into a stored decision, so those guests still get the banner and a real
chance to switch it off.

Review follow-ups folded in before merge: `decidedAt` now fails closed on an
unparsable or oversized value rather than being carried forward unchecked; the
vendor registry's `privacyUrl` is asserted to be `https://` so a `javascript:`
URL added later fails the test run instead of becoming an `href` sink; the
registry↔CSP join is now asserted in **both** directions, since an origin the CSP
permits with no vendor entry would be contactable but absent from the privacy
notice; and the preferences dialog states plainly that switching a category off
does not unload third-party code that already ran this visit.

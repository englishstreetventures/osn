---
"@cire/landing": patch
"@cire/host": patch
"@cire/api": patch
"@tools/e2e": patch
---

The cireweddings.com home page leads with the invitation itself. The first
screen is a fan of five phones: the middle one is a finished invitation for a
sample wedding, and four chips switch it between sealed, opened, the RSVP and
the day itself. Below it come the no-op RSVP demo and a five-tab journey that
shows each step from the guest's phone and the couple's dashboard. Then the
three plans: Ivory free for 100 guests, Gold A$79 for 500, Crimson A$149 for
1,000, and A$70 from Gold to Crimson. The page closes on the message a guest
receives and a "Your names" field that previews the couple's link.

`@cire/landing`: the chips and tabs are radios switched by CSS, so they work
without JavaScript. The product is drawn in the site's tokens with synthetic
data, with no screenshots. The Three.js seal, `three` and `@types/three` are
gone, and the bundle threshold drops to 52,425 bytes. The published plans and
the slug preview are held to cire-api by tests that run as a new `repo` vitest
project (`test:repo`). The FAQ's cost answer is built from the same plans, so
it gives each plan's price and guest cap as the cards do; the footer links
`#journey` and `#pricing`. The craft photograph is self-hosted under
`public/images/` (cached for a day) instead of loading from Unsplash's CDN, and
the CSP's `img-src` allows this origin and `data:` only.

`@cire/host`: arriving at `/?name=<names>` opens the create form with the
names in its field, for any organiser, and drops the parameter from the
address. The value is stripped of control, direction and invisible characters
(the zero-width joiner and non-joiner stay), has each run of whitespace made
one space, is trimmed, and is cut to the 120 UTF-16 units cire-api accepts; it
never submits on its own.

`@cire/api`: `slugifyDisplayName` and `MAX_DISPLAY_NAME` move to
`src/lib/slug.ts`, which imports nothing. Comments now say cire-api holds no
money amount and that the marketing site's published offer is checked against
the Stripe Prices by hand.

`@tools/e2e`: a `cire-landing-home` flow. `cire-checklist-starter` now signs
in from the claim link's address, `/?name=…`, and checks the create form opens
with the names; `signInToCireHost` takes that starting address.

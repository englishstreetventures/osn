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
project (`test:repo`). The FAQ's cost answer gives the prices; the footer
links `#journey` and `#pricing`.

`@cire/host`: arriving at `/?name=<names>` opens the create form with the
names in its field, for any organiser, and drops the parameter from the
address. The value is stripped of control and direction characters, trimmed,
and cut to the 120 UTF-16 units cire-api accepts; it never submits on its own.

`@cire/api`: `slugifyDisplayName` and `MAX_DISPLAY_NAME` move to
`src/lib/slug.ts`, which imports nothing. Comments now say cire-api holds no
money amount and that the marketing site's published offer is checked against
the Stripe Prices by hand.

`@tools/e2e`: a `cire-landing-home` flow.

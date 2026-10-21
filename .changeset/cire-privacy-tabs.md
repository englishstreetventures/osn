---
"@cire/ui": patch
"@cire/landing": patch
"@cire/invites": patch
"@cire/api": patch
"@tools/e2e": patch
---

cireweddings.com/privacy is a common privacy page that links to three notices,
each its own page: `/privacy/hosts`, `/privacy/guests` and `/privacy/vendors`.
The guests' notice is the guest site's own, from one shared source.

`@cire/ui`: the guest privacy notice is one Astro component,
`guest-privacy-notice.astro`, with a `level` prop for its heading levels and a
`choices` slot for the guest site's privacy-choices button. The consent
categories and vendor registry it is built from move here
(`consent-categories`, `consent-vendors`), with the registry's shape tests.
The notice now defines "the site" in its first paragraph, says a host may also
record a plus-one's RSVP and dietary requirements with the host's confirmation
stored, and is dated 2026-10-20. `@shared/legal` becomes a dependency.

`@cire/landing`: `/privacy` introduces Cire's privacy stance, drawn from the
notices, and who to contact. `/privacy/hosts` is the couples' and organisers'
notice, `/privacy/vendors` a new notice for wedding suppliers holding the
vendor parts of it, and `/privacy/guests` the shared guest notice. A row of
plain links (`PrivacyNav.astro`) crosses all four pages and marks the current
one with `aria-current="page"`; no JavaScript. Legal pages draw `h3` as the
guest site does.

`@cire/invites`: `/privacy` renders the shared notice with its
privacy-choices button; the consent framework imports the registry from
`@cire/ui`.

`@cire/api`: comments name the notices' new paths.

`@tools/e2e`: the stack boots cire landing on port 4323, and the
`cire-privacy-pages` flow follows the row of links through the four pages,
compares the guests' notice with the guest site's, and screenshots each page
at 390 and 1280 px.

---
"@cire/ui": patch
"@cire/landing": patch
"@cire/invites": patch
"@cire/api": patch
"@tools/e2e": patch
---

cireweddings.com/privacy holds two notices as tabs, Hosts and Guests, and the
Guests tab is the guest site's own notice from one shared source.

`@cire/ui`: the guest privacy notice is one Astro component,
`guest-privacy-notice.astro`, with a `level` prop for its heading levels and a
`choices` slot for the guest site's privacy-choices button. The consent
categories and vendor registry it is built from move here
(`consent-categories`, `consent-vendors`), with the registry's shape tests.
The notice now defines "the site" in its first paragraph, says a host may also
record a plus-one's RSVP and dietary requirements with the host's confirmation
stored, and is dated 2026-10-20. `@shared/legal` becomes a dependency.

`@cire/landing`: `/privacy` shows Hosts (the existing notice, its sections one
heading level down) and Guests as tabs (`NoticeTabs.astro`,
`lib/notice-tabs.ts`). `#hosts` and `#guests` open each tab; without
JavaScript both notices are in the page behind two jump links and print
whole. The draft banner also covers the operator's regulator, which the guest
notice names.

`@cire/invites`: `/privacy` renders the shared notice with its
privacy-choices button; the consent framework imports the registry from
`@cire/ui`.

`@cire/api`: comments name the guest notice's new path.

`@tools/e2e`: the stack boots cire landing on port 4323, and the
`cire-privacy-notice` flow drives the tabs, compares the Guests tab with the
guest site's notice, and screenshots both tabs at 390 and 1280 px.

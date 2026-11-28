---
"@cire/landing": patch
"@cire/ui": patch
---

Publish no postal address on Cire's privacy pages, so the draft banners come down.

The privacy overview and the hosts' and vendors' notices print no postal
address. Each contact line names the operator, trading as Cire,
and its privacy mailbox as a link; the overview's line, which held the name and
the address alone, gains the mailbox. With the address gone from
`@shared/legal`, every field the eight Cire legal pages publish is filled and
none shows its draft banner. The overview's and the vendors' notice's "Last
updated" date moves to 2026-11-27, the date the hosts' notice already carried.

`@cire/ui`'s `legal-layout.astro` gives the back link 1.5rem below it, so a
page's title sits the same distance under it with or without a draft banner;
the banner keeps its own spacing.

---
"@cire/host": patch
---

The host portal's eleven loading placeholders are `@cire/ui`'s `Skeleton`: each in the corner and fill of what it stands in for, at the height and spacing of the content that replaces it (event cards 232px, household cards 232px 24px apart, co-host rows 68px 8px apart, the overview's band and cards, a table's head and rows a hairline apart), pulsing on the motion tokens; a count or legend line over a list is held as empty room, and so are a section intro's actions (`SectionIntro`'s `holdActions`), so the first placeholder stands where the first item lands at 1280px and on a phone. The region that holds them is `aria-busy` while it loads, never a form, a heading, a live region or a control. While the RSVP replies load, the view bar keeps its divider before the event strip's placeholder and, on a phone, a second line for the reply chips, so it is the same height before and after.

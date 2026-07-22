---
"@cire/organiser": patch
---

Rebuild the host dashboard's visual and interaction layer. Navigation now switches on container width rather than viewport width: a persistent module rail on wide panels, and on narrow ones a single trigger row that opens a Kobalte dialog sheet listing every module with its hint. That replaces the horizontally-scrolling tab strip on phones.

Layout throughout the dashboard moves from media queries to container queries, so each panel responds to the space it actually has. Adds spacing, radius, duration, easing and focus-ring tokens to the theme, one card family across the overview, upright display headings, and a global focus-visible ring that respects `prefers-reduced-motion`. Information architecture, routes, hash scheme and copy are unchanged.

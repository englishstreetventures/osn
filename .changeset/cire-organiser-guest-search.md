---
"@cire/host": patch
---

Add a search bar to the host portal's guest list. Filters the already-loaded
roster client-side by household name, guest name (word-prefix match via
`@shared/db-utils/search`'s shared tokeniser), or family code — no server
round-trip, since the list is fully loaded for the wedding already. Shows a
"No guests match" message when the search text matches nothing.

---
"@cire/host": patch
---

Gift registry — the organiser module, shipping locked

Adds the Registry module to the portal: a rail entry, two sub-tabs (`list`, `gifts`), a `registry-store` snapshot cache mirroring the vendors one, and `RegistryView`. Every registry route sits behind the `registry` entitlement, which no wedding holds, so what an organiser actually sees today is the upsell panel — the module is built and reachable, not sellable.

The gift list edits items in place: add, edit, remove, and reorder with ↑/↓ buttons plus an optimistic splice before the `PATCH .../items/reorder`. Buttons rather than drag: solid-dnd ships no keyboard sensor, and a list an organiser can only reorder with a mouse is not a list everyone can reorder. Prices are typed in the wedding's own currency and parsed to minor units by `parseMinor`, and both price inputs carry `step="any"` — how many decimals a price may hold is a property of the currency (KWD has three, JPY none), and a fixed hundredths step rejects a valid Kuwaiti price before the handler ever sees it. `minorToInput` is new alongside it, so seeding the edit form no longer needs a hardcoded `/ 100`.

The gift log is paged, not whole: 50 a page over `?giftsOffset=`, with "Load more gifts" appearing only while the API says there is more. A gift given in another currency prints the amount **as given** as the headline with the snapshotted primary-currency equivalent underneath, and the running total is labelled approximate — it is a sum of rates on the days money arrived, and a number that looks exact but drifts is worse than one that admits it.

Three fields in that log are written by guests — the note, the display name, and the household's family name. All three render as Solid text interpolation and nothing else: no `innerHTML`, no markdown pass, no rich-text anywhere on the path. A test renders a `<script>`-shaped note and asserts it appears as literal text with no element created, so the guarantee fails the suite rather than the review.

Left out on purpose: no Overview card (every registry read 402s today, so a card would fire a guaranteed-failing request on the busiest page), no settings surface, and no image field in the editor — the picker and its serve path are the next PR, and a dead input is worse than an absent one.

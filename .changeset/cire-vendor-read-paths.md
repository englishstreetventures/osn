---
"@cire/api": patch
"@cire/vendor": patch
---

Cut avoidable D1 round trips on three vendor read paths.

`POST /api/vendor/enquiries/:id/quote` ran the vendor-name and
wedding-currency lookups serially even though neither depends on the other;
they now run together. `directoryService.getLiveListingById` and
`consumeClaim` had the same shape — a row fetch followed by a category fetch
keyed on an id already known before the row fetch returns — so both now run
their two queries together as well.

On the vendor portal, the claim happy path already gets the freshly-claimed
listing back from `consumeClaim`, but the redirect to the editor is a full
page navigation that drops it. The claim page now hands the listing forward
through a single-use sessionStorage key; the editor seeds its resource from
it when present and valid, and falls back to its normal fetch otherwise.

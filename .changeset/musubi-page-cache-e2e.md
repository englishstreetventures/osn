---
"@tools/e2e": patch
---

`musubi-org-detail` holds Musubi's page cache: hovering Discover reads its suggestions before the click and the visit reads them once more; the organisations list, coming back to it with its read held, draws the renamed row at once with no placeholder, and so does the organisation; a deleted organisation's stale link is a first load with a placeholder. The return is shot as `screenshots/musubi-page-cache/organisations-return.png`.

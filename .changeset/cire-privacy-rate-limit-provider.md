---
"@cire/api": patch
"@cire/landing": patch
"@cire/ui": patch
"@tools/e2e": patch
---

The host and vendor privacy pages on cire's marketing site name Cloudflare as the provider that holds rate-limit state. The privacy summary, the host, vendor and guest notices say where Cloudflare keeps the data: the databases, which hold sign-in sessions too, have their primary in Oceania, with read-only copies in other regions Cloudflare chooses; uploaded files are stored in Eastern North America (the summary, the host notice, and the guest notice for the spreadsheets hosts upload); rate limits are counted wherever a request arrives. The privacy summary and the host notice say copies of images are cached where they are viewed, for up to a year (link thumbnails 30 days), and the host notice says removing a file or deleting a wedding leaves cached copies that can still be served until they expire. The host notice adds that the portal's live updates run on a server placed near the first request for each wedding. The guest notice gives Oceania as its primary region, as the database's primary is, and names no city. A comment in cire-api and the end-to-end suite's comments and environment test name the coordination store, and the suite's sign-up retry flow waits for the refused send before it counts it.

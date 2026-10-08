---
"@cire/api": patch
---

Five small fixes to the organiser API.

Every CSV download now puts a `'` before a `=`, `+`, `-` or `@` that starts a cell or any `;`, tab or line-break segment inside one, after any invisible leading characters, so a spreadsheet set to split on `;` cannot run a planted formula. The guard sits immediately before the marker, header cells included. Uploading a round-trip `export/*.csv` takes exactly that guard back off after the formula scan, so values such as `-12 Smith Street` or a dash-list dress code come back as stored.

The organiser registry image is kept by the browser for an hour (`private, max-age=3600` with a weak `ETag`) instead of a year, and each revalidation passes the sign-in, member and Gold gates before it can get a 304.

Claiming a directory listing burns the token in one UPDATE that carries every check, so a claim costs four statements over two round trips and a refusal still never spends the token. The RSVP-changes card reads the caller's digest setting in its gate's statement, so it costs two statements. Two tests pin the organiser wedding list at one statement in the service and two in the route.

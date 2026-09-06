---
"@cire/host": patch
---

Stop the guest and event editors seeding a DesiredState draft from a slice
whose load resolved without filling the cache. `ensureXxxLoaded` fulfils
without writing rows when its generation guard discards an in-flight fetch —
an invalidate landing mid-load — and the editors fell through `?? []` on that
outcome. Since the draft is posted back as the DesiredState the server acts on,
that empty slice reads as a deletion: every household in `GuestsEditor` (taking
its live claim code with it, since `families.public_id` is the claim code and
the delete cascades guests, RSVPs and sessions), and every event in
`EventsEditor`, whose `scope: "events"` save is precisely what makes its events
slice authoritative. All four reads now check the loader's `fresh` result and
show the existing load error instead.

Adds `allAuthFirst` beside `isAuthExpired` in `cire/host/src/lib/api.ts`, and
routes `GuestsEditor`'s three parallel loads through it. `Promise.all` adopts
whichever rejection settles first, so once a slice could reject for an ordinary
reason it could beat the `AuthExpiredError` that `authFetch` throws — and the
catch's `isAuthExpired` check, the only thing that reaches `redirectToLogin()`,
would not see it. An organiser whose session expired mid-load would get a
"couldn't load" banner and a dead page rather than a sign-in prompt. The helper
settles all of them and rethrows an expired session in preference to anything
else.

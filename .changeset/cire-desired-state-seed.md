---
"@cire/host": patch
---

Fix the guests + events editors seeding a DesiredState draft from an empty
slice when its load resolves without filling the cache (a generation-guarded
`ensureXxxLoaded` discarding an in-flight fetch, e.g. an invalidate landing
mid-load). Since the draft is posted back as the whole DesiredState, that
empty slice previously fell through `?? []` and a save from it deleted every
household — and every live claim code with it. All six reads (events, guests,
households in both `EventsEditor` and `GuestsEditor`) now check the loader's
`fresh` result and show the existing load error instead of seeding an empty
draft.

---
"@pulse/api": minor
---

Wire the `notifyAppJoined` enrollment bridge and split `createSettingsRoutes`
out of `routes/events.ts`.

`completeOnboarding` now fires `notifyAppJoined(accountId)` on the
first-completion branch as a best-effort `forkDaemon` (new
`pulse.onboarding.enrollment_notify{result}` counter). This inserts the
`app_enrollments` row that osn-api's full-account-delete fan-out reads to know
it must reach Pulse — previously that row was never created for real users, so
deleting an OSN account silently skipped the user's Pulse data. `joinApp` is
idempotent, so a repeat or stray fire is harmless. (Residual gap: no join-side
retry sweeper yet, unlike the leave side — a transient osn-api outage during
onboarding leaves the row uncreated until the next completion.)

`createSettingsRoutes` (`PATCH /me/settings`) moved verbatim to
`routes/settings.ts`; it was already a distinct `/me`-prefixed factory. No
behaviour change. The discovery/share/exposure extraction remains open (those
routes share closures mid-chain with the events builder).

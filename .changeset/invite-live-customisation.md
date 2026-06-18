---
---

fix(cire/web): reflect organiser hero + theme changes on the guest invite at runtime

The static guest site baked the build-time `/api/invite/:slug` snapshot, so an
organiser's later hero/theme update never reached guests until a rebuild. Both
guest islands now revalidate on mount and let the live response override the
snapshot (`InvitePage` gains its own theme revalidation, keyed on a `slug` prop).
`@cire/*` are version-less, so this changeset is intentionally empty.

---
"@osn/landing": patch
"@pulse/landing": patch
---

P-I8 (tracker #619) — split from the cire-side changeset because `@osn/landing`
and `@pulse/landing` are versioned packages and changesets refuses to mix a
versioned package with the unversioned `@cire/*` apps in one file.

Both apps' `build` script now chains `scripts/guard-bundle-size.sh . static
<threshold>` (previously bare `astro build`, no guard at all), and `ci.yml`
carries an explicit per-app step for the same reason cire/invites' own guard
does: a Turborepo cache replay of `build` never runs the chained script. See
`wiki/conventions/bundle-size-guards.md` for the measured baseline and
threshold each app was set from.

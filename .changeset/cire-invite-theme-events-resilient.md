---
"@cire/web": patch
---

Fix the guest invite's **events section vanishing** when a malformed/partial theme
payload reaches the render boundary. `sectionThemeVars` destructured
`theme[section]` unguarded, so a truthy-but-partial `theme` (a missing section
sub-object — e.g. a shape mismatch on the no-store invite revalidation, or future
payload drift) threw a `TypeError`. That call computes the inline CSS variables
for the events ("details") section wrapper on the guest invite, so the throw
crashed the whole `InvitePage` island and the **events list disappeared** — the
hero/blur change that bumped the customisation row was the trigger that re-fetched
the theme.

`sectionThemeVars` now reads the section colours defensively (`theme[section]?` →
fall back to the built-in tokens), mirroring the resilience the organiser-side
preview helper (`invite-theme-preview.ts`) already had (`theme.accent[section] ??
default`). A partial theme now renders with the global fonts and the default
section colours instead of crashing, so the events can never be taken down by a
theme/customisation payload issue. Adds a regression test covering the
partial-theme case.

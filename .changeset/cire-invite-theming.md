---
---

Invite builder: per-section theming. Organisers can now set fonts (closed
allow-list enum) and accent/background colours per invite section (hero, our
story, event details), persisted on the existing `wedding_invite_customisations`
row and rendered on the guest site via validated CSS custom properties with
graceful per-field fallback to the built-in tokens.

Only `@cire/*` packages (version-less / ignored) are touched, so this is an empty
changeset.

---
"@pulse/web": patch
---

Raise the root `overrides` for `seroval` (`^1.6.8`), `sharp` (`^0.35.5`),
`shell-quote` (`^1.11.0`), `source-map-js` (`^1.2.2`) and `tinypool` (`^2.1.2`)
past five advisories that `bun audit --audit-level=high` reports. `seroval` is
the one that ships to browsers, through `solid-js` and `@solidjs/start`.
Lockfile and root `package.json` only; no source change.

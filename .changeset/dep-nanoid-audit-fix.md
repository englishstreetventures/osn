---
"@cire/host": patch
---

Force `nanoid` `^3.3.17` via a root `overrides` entry to clear the
high-severity advisory (`GHSA-2v37-7h3g-55p8`, custom generators looping
indefinitely when size is zero) pulled transitively through
`@cire/host`'s `vite` → `postcss` → `nanoid@3.3.16`. `postcss@8.5.26`
carries the same fix upstream but was too recently published to pass this
environment's minimum-release-age install policy, so the narrowest
override — directly on `nanoid`, the vulnerable leaf — clears the
advisory without waiting on it. Was blocking every push at the pre-push
`bun audit` gate; build-tooling-only, never on a deployed Worker path.

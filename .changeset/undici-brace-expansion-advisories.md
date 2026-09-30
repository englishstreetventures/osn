---
"@musubi/landing": patch
"@pulse/landing": patch
---

Raise the root `undici` override from `^8.9.0` to `^8.10.2` (resolves 8.11.2)
and add a `brace-expansion` override at `^5.0.11` (resolves 5.0.12), clearing
GHSA-rfgv-xxqx-mfg5, GHSA-w293-vg96-wgc3, GHSA-vp8m-p9jh-q5pm,
GHSA-qhr7-859c-m2p7 and GHSA-6j4f-fj2g-mc7p. `undici` reaches these packages
through Astro's font loader (`unifont`), which runs at build time, so the HTTP
client they build with changes. `brace-expansion` reaches only lint tooling.

The version-less `@cire/*` packages take the same upgrade and are not named
here, because a changeset may not mix versioned and version-less packages.

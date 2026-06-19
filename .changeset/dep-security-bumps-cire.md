---
"@cire/web": patch
"@cire/organiser": patch
---

Bump `astro` `^6.4.2` → `^6.4.6` to clear the high-severity Host-header
SSRF advisory (`GHSA-2pvr-wf23-7pc7`) in the prerendered error-page fetch,
plus the bundled spread-prop XSS (`GHSA-jrpj-wcv7-9fh9`). Also force
`undici` `^7.28.0` via a root `overrides` entry to clear the high-severity
TLS certificate-validation bypass (`GHSA-vmh5-mc38-953g`) pulled
transitively through `jsdom`/`miniflare`. Both were blocking every push at
the pre-push `bun audit` gate.

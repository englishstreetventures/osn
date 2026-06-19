---
"@osn/landing": patch
---

Bump `astro` `^6.4.2` → `^6.4.6` to clear the high-severity Host-header
SSRF advisory (`GHSA-2pvr-wf23-7pc7`) in the prerendered error-page fetch,
plus the bundled spread-prop XSS (`GHSA-jrpj-wcv7-9fh9`).

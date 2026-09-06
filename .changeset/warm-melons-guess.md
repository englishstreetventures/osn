---
"@cire/host": patch
"@cire/vendor": patch
---

Take @testing-library/jest-dom 7.0.1, off the deprecated 6.10.0. See the accompanying changeset for why 6.10.0 is deprecated; the short version is that its breaking changes (Node >= 22, a required `@testing-library/dom` peer) were already in force here, so 7.0.1 is the supported equivalent of what was installed.

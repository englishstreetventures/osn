---
"@pulse/web": patch
---

Take @testing-library/jest-dom 7.0.1. The pinned `^6.10.0` could only ever resolve 6.10.0, and npm marks that release **deprecated** — the maintainers shipped breaking changes (Node >= 22, a required `@testing-library/dom` peer) in a minor by mistake and their notice says to use 6.9.1 or move to 7.0.0. Since this repo already runs Node 24 and already has `@testing-library/dom` 10.4.1 in the tree via `@solidjs/testing-library`, 7.0.1 is the un-deprecated equivalent of what was already installed. No matcher changed; no test edit needed.

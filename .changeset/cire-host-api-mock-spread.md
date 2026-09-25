---
"@cire/host": patch
---

Every test mock of `lib/api` now spreads the real module. Tests only; no
runtime change.

Eleven suites mocked `lib/api` with an object that listed a few exports, so
any export they left out was missing from the mock. A component that began
calling one would throw inside its own `try`/`catch` and render "Could not
load", which reads as a fetch failure rather than a mock gap. Each suite now
spreads `vi.importActual` and keeps its overrides as they were;
`ChangeHistory.test.tsx` uses the shared `organiserApiMock()`. The two
browser-tier suites use the same form.

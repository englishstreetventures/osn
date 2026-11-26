---
"@osn/api": patch
---

The account-deletion rules gain agreement tests: `tests/laws/` runs the same events through the Bend model in `tools/deletion-laws` (compiled to `model.mjs`) and through `requestErasure`, `cancelErasure`, the fan-out and hard-delete sweeps, the handle check and `DELETE /account`, and fails when they disagree. They run as the package's `test:repo` task, which turbo reruns when the model changes. No production code changes.

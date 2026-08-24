---
"@cire/api": patch
---

Type the R2 bucket `put`/`delete` interfaces after the real backend's return type (`R2Object` for a write, `void` for a delete, from the ambient Cloudflare `R2Bucket`) instead of bare `void`, so a dropped write can no longer typecheck as fine. The old `void` return let a real async delete or put be discarded silently — on the asset-erasure path, a dropped delete meant data that should be gone stayed. Callers that wrapped calls in `Promise.resolve(...)` only to satisfy the old lying type now just `await` them directly.

This does not turn on floating-promise detection — nothing in the repo checks for that today, and lint is not type-aware. It makes the type honest, so a future type-aware lint rule could see the problem.

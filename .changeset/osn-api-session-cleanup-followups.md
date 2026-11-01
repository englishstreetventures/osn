---
"@osn/api": patch
---

On bun:sqlite, a refresh whose write fails removes everything it wrote: its new session, and its rotation record when that record landed before the failure, so the device can refresh the same token again. Both clean-ups match the record on the token's hash and the grant's own `rotated_at`. A record the clean-up cannot remove is logged at error as `Refresh rotation could not remove its own rotation record after a failed write`, annotated `restricted` only. On D1 the rotation is one batch, which commits whole or not at all.

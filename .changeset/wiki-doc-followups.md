---
"@cire/api": patch
"@cire/host": patch
"@cire/invites": patch
---

Correct three comments that no longer matched the code, and make turbo's `check` re-run when a workspace dependency changes.

- `turbo.json`: `check` now depends on a script-less `transit` task chained through `^transit`, so its hash covers every workspace dependency's files (Markdown excepted) and an edit to, say, `shared/db-utils` re-runs every dependent's type-check instead of replaying a cached green. Checks still run side by side; none waits on another.
- `cire/api/wrangler.toml`: with no `STRIPE_SECRET_KEY` the portal does not hide the Connect panel; it shows the Money-gifts section and reports the Connect button's 404 as a toast.
- `ImageCropModal.tsx`: the image API sends `Vary: Accept, Origin`; the comment now gives the reasons the modal's `<img>` still carries no `crossOrigin`.
- Both invite `Document.astro` files and `claim-session.ts`: the gift-list band's split from `InvitePage` is no longer required by anything; the comments say so and name what the split costs.

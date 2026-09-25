---
"@cire/invites": patch
"@cire/api": patch
---

A guest invite page now requests `GET /api/invite/:slug` once per render instead
of three times. The `[slug]` route's server-side fetch is the only one: both
design packs' islands take its payload as props and fetch nothing. Before, each
island re-requested the payload through a `createResource`, which Solid's server
build runs during the render and Astro awaits, so the two extra requests ran in
the Worker ahead of the HTML and never reached the browser.

When the route's fetch fails, each island now retries it from the browser once it
mounts (`createInviteRetry`, `cire/invites/src/components/invite-retry.ts`, which
replaces `invite-revalidation.ts`). The retry writes nothing on a failure, so the
painted value keeps its identity and the root palette is not rewritten for data
that did not change. `InvitePage` takes a new `inviteMissing` prop for this.

The invite documents drop their anonymous (`crossorigin`) preconnect to cire-api,
and the gift list page drops its own: every request on a normal load is
credentialed. `@cire/invites` gains an `ssr` Vitest project that renders islands
through Solid's server build, run by the package's `test` script. `@cire/api`
changes comments only.

---
"@cire/api": patch
"@cire/db": patch
"@cire/invites": patch
"@tools/e2e": patch
---

The organiser's invite preview reads the gift list and never writes to it, as it never writes an RSVP.

- `@cire/api`: every guest gift-list write — reserving, marking bought, releasing and giving money — admits only a `guest` household and answers `403 preview_read_only` to the wedding's host preview household. Giving money is refused before Stripe is asked anything. The checks ride in the statements that already check the household against the wedding, so no D1 round trip is added. The list read stays open to the preview, and `GET …/registry/mine` carries `preview: true` for it. The local dev server keeps a client address a request sends only when the E2E stack asks it to (`CIRE_E2E_CLIENT_ADDRESS=1`); otherwise the socket peer is the address. The E2E gift-list wedding has its host preview household.
- `@cire/db`: migration 0085 sets every live claim a host preview household holds to `released`. The rows stay.
- `@cire/invites`: in a preview, the gift page says "Preview mode", shows each Reserve button and the payment button disabled, and offers no Change or Release. A `403 preview_read_only` gets its own "Preview mode." message, and any other 403 a generic failure.
- `@tools/e2e`: a `cire-registry-preview` flow opens the invitation at the preview code, sees the list with every Reserve disabled, and is refused `403` on a reservation sent anyway, with no claim row written. The organiser's claim goes out from its own client address, and the claim-budget test counts `code=` links as well as presses.

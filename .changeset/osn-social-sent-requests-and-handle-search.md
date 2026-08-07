---
"@osn/api": minor
"@osn/client": minor
"@osn/social": minor
---

Add a "Sent" tab to Connections so an outgoing request is actually visible somewhere.

`listPendingRequests` was always addressee-only by design (a request you sent
never shows up there), and `listConnections` only returns accepted rows, so a
sender had no page anywhere in `@osn/social` that showed their own outstanding
requests — the toast on send was the only trace, and it vanished on
navigation. Reported as "I tried connecting with someone and it didn't work,
don't see it in pending or accepted," but the request was landing fine on the
recipient's side the whole time.

- `@osn/api`: new `graph.listOutgoingRequests` service method and
  `GET /graph/connections/sent` route (mirrors the existing `/pending`
  endpoint, filtered by `requesterId` instead of `addresseeId`).
- `@osn/client`: `GraphClient.listSentRequests` + `SentRequestEntry` type.
- `@osn/social`: a "Sent" tab on `ConnectionsPage` listing outgoing requests,
  with a Cancel action (`removeConnection`, which already cancels a pending
  request in either direction).

Also gives the desktop rail combobox and the `/search` page search fields a
prepended "@" inside the existing pill styling, replacing the magnifying-glass
icon — reusing the `@osn/ui` `UsernameInput` field's own `@`-prefix visual
convention. `UsernameInput`'s availability-check `status` machinery doesn't
fit a live people/org combobox that also matches by display name, so this
borrows the visual token rather than the component itself.

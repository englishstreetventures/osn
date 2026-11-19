---
"@osn/db": minor
"@osn/api": minor
"@osn/client": minor
"@musubi/social": minor
"@musubi/infra": minor
---

Musubi's Settings › Connected apps links an app's own screen for removing a person's data from it, as "Remove my data from <app>". `oauth_clients` gains a nullable `manage_data_url` that only an operator sets (migration `20261119150713_oauth_clients_manage_data_url`). `GET /oidc/connections` answers it as `manageDataUrl` only while it passes a read rule in `osn/api/src/services/auth/client-links.ts`: at most 512 characters, canonical, no user name or password, `https:` (or `http:` to localhost), on the origin of a registered redirect URI or of the app origin osn-api's deployment pins to the client (`CIRE_ORGANISER_ORIGIN` for `CIRE_OIDC_CLIENT_ID`), and never for a disabled client; a refused value counts on the new `osn.oidc.manage_data_link.refused`. `@osn/client`'s `OidcConnection` carries `manageDataUrl`. Musubi draws the link on its own line in the app's row, through `followableLink`, in a new tab; the page cache records each Connected apps row's kind so the placeholder keeps each row's height. The musubi stack's dev seed sets cire's link to the organiser portal's `/#/remove-data`.

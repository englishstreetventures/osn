---
"@osn/api": patch
---

Dev sign-in mounts only on a named tier, and the origin guard exempts only requests that carry credentials.

`GET|POST /dev/login` now needs `OSN_ENV` set to `local`, `dev` or `development`. An unset `OSN_ENV` leaves the routes unmounted, even with `DEV_LOGIN_SECRET` bound, although every other gate still reads unset as `local`. `bun run dev` names `local` for itself when `OSN_ENV` is unset (`dev:app` starts `src/local.ts` with `--devloop`), and a value in `osn/api/.env` still wins. `bun run start` takes no default. `wrangler dev`, the E2E stack and the musubi dev stack already set the tier.

Under `/internal`, `/graph/internal` and `/organisations/internal`, the origin guard now skips the `Origin` check only for a request carrying `Authorization: Bearer …`, the service secret that service registration and key revocation compare. `Authorization: ARC …` stays exempt on every path. A request there with no credential header, or with another scheme, is checked like any other route. Every caller already sends one of the two headers.

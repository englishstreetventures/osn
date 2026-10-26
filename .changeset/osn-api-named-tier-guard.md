---
"@osn/api": patch
---

Dev sign-in mounts only on a named tier, and the origin guard exempts only requests that carry credentials.

The dev sign-in routes now need `OSN_ENV` set to `local`, `dev` or `development`. An unset `OSN_ENV` leaves the routes unmounted, even with `DEV_LOGIN_SECRET` bound, although every other gate still reads unset as `local`. `bun run dev` names `local` for itself when `OSN_ENV` is unset (`dev:app` starts `src/local.ts` with `--devloop`), and a value in `osn/api/.env` still wins. `bun run start` takes no default. `wrangler dev`, the E2E stack and the musubi dev stack already set the tier.

The secret no longer travels in a URL. `GET /dev/login` serves a form that posts the secret to `/dev/login/form`, which signs in and redirects to an allowlisted `return_to`. A `secret` query parameter is refused with 422. The form POST is exempt from the origin guard by its exact path: it needs the secret in its body, so a cross-site form has nothing to borrow.

Under `/internal`, `/graph/internal` and `/organisations/internal`, the origin guard now skips the `Origin` check only for a request carrying `Authorization: Bearer …`, the service secret that service registration and key revocation compare. `Authorization: ARC …` stays exempt on every path. A request there with no credential header, or with another scheme, is checked like any other route. Every caller already sends one of the two headers.

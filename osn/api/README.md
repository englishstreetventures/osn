# @osn/api

OSN identity server binary. A Bun/Elysia process that listens on **port 4000**
(configurable via `PORT`) and exposes:

- All auth routes from `@osn/core` (passkey, OTP, magic link, PKCE, JWT,
  registration, `/login/*`, hosted `/authorize` HTML for third-party OAuth)
- All social graph routes from `@osn/core` (connections, close friends, blocks)
- `GET /health` for probes

It's a thin wrapper — the actual logic lives in `@osn/core`. This package
only wires CORS, reads env config, and calls `app.listen(port)`.

## Run

```bash
bun run --cwd osn/api dev
```

## Env

See `.env.example`. At minimum: `OSN_JWT_PRIVATE_KEY`, `OSN_JWT_PUBLIC_KEY`
(both base64-encoded JWK JSON; ephemeral pair auto-generated in local dev when
unset), `OSN_ORIGIN`, `OSN_RP_ID`.

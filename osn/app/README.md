# @osn/app

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
bun run --cwd osn/app dev
```

## Env

See `.env.example`. At minimum: `OSN_JWT_SECRET` (≥32 chars in prod),
`OSN_ORIGIN`, `OSN_RP_ID`.

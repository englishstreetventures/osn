# @pulse/web

Pulse frontend — a SolidJS browser SPA.

Talks to two backends over HTTP:

- **`@pulse/api`** on port 3001 for events/RSVPs (via Eden treaty client)
- **`@osn/api`** on port 4000 for identity (registration, sign-in, tokens,
  social graph)

UI auth flows come entirely from `@osn/ui/auth` — `<Register>`, `<SignIn>`,
and `<MagicLinkHandler>` — with `RegistrationClient` and `LoginClient`
instances built once in `src/lib/authClients.ts` and injected as props.

## Run

```bash
bun run --cwd pulse/web dev      # dev server (port 1420)
bun run --cwd pulse/web build    # production build
bun run --cwd pulse/web preview  # preview a production build
```

## Env

Two hosts are configurable: `VITE_API_URL` (`@pulse/api`) and
`VITE_OSN_ISSUER_URL` (`@osn/api`, the OIDC issuer). See `.env.example`.

Vite picks the file from its mode, and its mode already matches what we want:
the dev server reads `.env.development`, `vite build` reads `.env.production`.
No flag, no extra script. Both files are committed — they hold hostnames, not
secrets. Local overrides go in `.env.local`, which is ignored.

A variable that should not be set must be left **commented out**, never set
empty. An empty string is not nullish, so it defeats the
`?? "http://localhost:…"` fallback in `src/lib/api.ts` and `src/lib/auth.ts`,
and the app quietly issues requests relative to its own origin.

One gap, deploy-time: `@pulse/api` has no route in any environment
(`pulse/api/wrangler.toml`), so it has no hostname yet. `VITE_API_URL` stays
commented out in `.env.production`. Grep `TODO(pulse-hosts)`.

## Tooling

Vite + `@tailwindcss/vite` (Tailwind v4) + `vite-plugin-solid`. Tests use
Vitest + happy-dom + `@solidjs/testing-library`.

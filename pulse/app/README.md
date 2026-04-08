# @pulse/app

Pulse frontend — Tauri + SolidJS. iOS-first, web + desktop supported.

Talks to two backends over HTTP:

- **`@pulse/api`** on port 3001 for events/RSVPs (via Eden treaty client)
- **`@osn/app`** on port 4000 for identity (registration, sign-in, tokens,
  social graph)

UI auth flows come entirely from `@osn/ui/auth` — `<Register>`, `<SignIn>`,
and `<MagicLinkHandler>` — with `RegistrationClient` and `LoginClient`
instances built once in `src/lib/authClients.ts` and injected as props.

## Run

```bash
bun run --cwd pulse/app dev           # web dev server (port 1420)
bun run --cwd pulse/app dev:ios       # iOS simulator via Tauri
bun run --cwd pulse/app tauri dev     # desktop shell via Tauri
```

## Env

See `.env.example`. Defaults assume `@osn/app` on `localhost:4000` and
`@pulse/api` on `localhost:3001`.

## Tooling

Vite + `@tailwindcss/vite` (Tailwind v4) + `vite-plugin-solid`. Tests use
Vitest + happy-dom + `@solidjs/testing-library`.

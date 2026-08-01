# @pulse/app

Pulse frontend — Tauri + SolidJS. iOS-first, web + desktop supported.

Talks to two backends over HTTP:

- **`@pulse/api`** on port 3001 for events/RSVPs (via Eden treaty client)
- **`@osn/api`** on port 4000 for identity (registration, sign-in, tokens,
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

## iOS build

The Apple development team ID is `FV59Y8RSUH`, set in
`src-tauri/tauri.conf.json`, and it is the only signing config in the repo.
Provisioning profiles are not committed — simulator builds need none, and a
device build resolves its own profile from the team.

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

### CSP

`tauri.conf.json` carries the development CSP, so `tauri dev` and `dev:ios`
need no flags. `tauri.prod.conf.json` overlays it for release builds, dropping
the `localhost` origins and naming `https://id.musubi.social`:

```bash
bun run --cwd pulse/app build:ios   # tauri ios build --config src-tauri/tauri.prod.conf.json
```

Tauri replaces arrays rather than merging them, so each overlay repeats the
whole `connect-src` list.

Two gaps, both deploy-time:

- `@pulse/api` has no route in any environment (`pulse/api/wrangler.toml`), so
  it has no hostname yet. `VITE_API_URL` stays commented out in
  `.env.production` and `connect-src` still ends in a bare `https:`.
- There is no staging environment. `@osn/api` routes production only. When
  staging gets a host, add `.env.staging` and `tauri.staging.conf.json`
  alongside the two that exist.

Grep `TODO(pulse-hosts)`.

## Tooling

Vite + `@tailwindcss/vite` (Tailwind v4) + `vite-plugin-solid`. Tests use
Vitest + happy-dom + `@solidjs/testing-library`.

## The iOS Xcode project

`src-tauri/gen/apple/` is committed and hand-edited. The deployment target, the
entitlements, the extra SDK dependencies and the Swift sources of the native
bridges all live there.

**Never run `tauri ios init` on this repo.** It regenerates that whole directory
from scratch and throws every one of those edits away. There is nothing to
regenerate: an ordinary build writes only to the ignored `build/`, `Externals/`
and `xcuserdata/` paths inside it, and to `src-tauri/gen/schemas`, which sits
outside it and is gitignored.

Adding files through Xcode's UI has the same effect on a smaller scale — it
rewrites `project.pbxproj`. Add sources to `project.yml` instead.

After any local iOS build or Xcode session:

```sh
bash scripts/check-gen-apple-diff.sh
```

It fails if anything under `gen/apple/` is uncommitted, and tells you how to
throw a regen away. CI runs it on every PR.

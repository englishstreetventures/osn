# @pulse/web

Pulse frontend — a SolidJS browser SPA.

Its one backend is **`@pulse/api`**, on port 3001 locally, reached two ways.
Events and onboarding go through the Eden treaty client from
`@pulse/api/client` (`src/lib/api.ts`). RSVPs, series, venues, close friends
and the calendar go through raw `fetch` wrappers (`src/lib/rsvps.ts` and the
modules beside it), which keep those routes out of Eden's type chain; the
comment at the top of `rsvps.ts` says why. Every wrapper but `venues.ts` calls
through `authFetch` or `publicFetch` from `src/lib/auth.ts`, which set
`credentials: "include"`; `venues.ts` makes public reads and sends no cookie.

The browser also calls two third parties: Photon (`photon.komoot.io`) for
place search (`src/lib/LocationInput.tsx`), and OpenStreetMap's tile servers
for the map preview (`src/components/MapPreview.tsx`).

Sign-in is OIDC, with Pulse as a relying party (`src/lib/auth.ts`, on
`@shared/rp-auth`). `@pulse/api`'s `/api/auth/oidc/start` sends the browser
to the OSN issuer and takes the code back in exchange for a Pulse session
cookie; the app holds that cookie and nothing else.

## Run

```bash
bun run --cwd pulse/web dev      # dev server (port 1420)
bun run --cwd pulse/web build    # production build
bun run --cwd pulse/web preview  # preview a production build
```

## Env

The app reads one configurable host, `VITE_API_URL` (`@pulse/api`). See
`.env.example`.
The env files also set `VITE_OSN_ISSUER_URL`, which nothing under `src/`
reads.

Vite picks the file from its mode, and its mode already matches what we want:
the dev server reads `.env.development`, `vite build` reads `.env.production`.
No flag, no extra script. Both files are committed — they hold hostnames, not
secrets. Local overrides go in `.env.local`, which is ignored.

A variable that should not be set must be left **commented out**, never set
empty. An empty string is not nullish, so it defeats the
`?? "http://localhost:…"` fallback in `src/lib/auth.ts` (and in
`src/lib/venues.ts`, which reads the variable itself), and the app quietly
issues requests relative to its own origin.

One gap, deploy-time: `@pulse/api` has no route in any environment
(`pulse/api/wrangler.toml`), so it has no hostname yet. `VITE_API_URL` stays
commented out in `.env.production`. Grep `TODO(pulse-hosts)`.

## Tooling

Vite + `@tailwindcss/vite` (Tailwind v4) + `vite-plugin-solid`. Tests use
Vitest + happy-dom + `@solidjs/testing-library`.

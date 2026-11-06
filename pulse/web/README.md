# @pulse/web

Pulse frontend — a SolidStart app whose pages render on the server.

The browser talks to one origin, this one. `@pulse/api` is mounted on it under
`/api` (`src/routes/api/[...path].ts`): `/api/auth/*` reaches pulse-api
unchanged, every other `/api/<rest>` reaches it as `/<rest>`. pulse-api's
session cookie is therefore host-only on this origin, and the server that
renders a page passes it on to pulse-api (`src/lib/transport.ts`), so a
signed-in page arrives filled in.

The app reaches `@pulse/api` two ways. Events and onboarding go through the
Eden treaty client from `@pulse/api/client` (`src/lib/api.ts`). RSVPs, series,
venues, close friends and the calendar go through raw `fetch` wrappers
(`src/lib/rsvps.ts` and the modules beside it), which keep those routes out of
Eden's type chain; the comment at the top of `rsvps.ts` says why. Every
wrapper takes its base from `src/lib/transport.ts`, so the same code runs in
the browser and on the rendering server. All but `venues.ts` call through
`authFetch` or `publicFetch` from `src/lib/auth.ts`; `venues.ts` makes public
reads with plain `fetch` and sends no cookie.

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

`PULSE_API_INTERNAL_URL` is where the rendering server reaches `@pulse/api`
(default `http://localhost:3001`). It is read from the process environment per
request and never reaches the client bundle. See `.env.example`.
The env files also set `VITE_OSN_ISSUER_URL`, which nothing under `src/`
reads.

Vite picks the file from its mode, and its mode already matches what we want:
the dev server reads `.env.development`, `vite build` reads `.env.production`.
No flag, no extra script. Both files are committed — they hold hostnames, not
secrets. Local overrides go in `.env.local`, which is ignored.

A variable that should not be set must be left **commented out**, never set
empty.

One gap, deploy-time: neither `@pulse/api` nor this app has a deployed tier
yet, so nothing sets `PULSE_API_INTERNAL_URL` outside the devloop and the E2E
stack.

## Tooling

Vite + `@tailwindcss/vite` (Tailwind v4) + `vite-plugin-solid`. Tests use
Vitest + happy-dom + `@solidjs/testing-library`.

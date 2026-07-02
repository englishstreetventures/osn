# @pulse/landing

Marketing / landing site for **Pulse** (events). Static Astro + SolidJS +
Tailwind v4 — same stack as `@cire/landing`. Colourful, fun identity following
the Pulse design system (`pulse/DESIGN.md`): Instrument Serif / Geist /
Geist Mono, the coral/ember accent family, and a vivid category palette
(`PulseField` backdrop + `PulseHero` + a colourful Categories showcase).

Pure brochure: no Pulse API calls, no account.

## Run

```bash
bun run --cwd pulse/landing dev        # dev server on http://localhost:4325
bun run --cwd pulse/landing build      # static build → dist/
bun run --cwd pulse/landing check      # astro check (type-check)
bun run --cwd pulse/landing test:run   # vitest
# or, from the repo root:
bun run dev:pulse-landing
```

## Config

CTA target + canonical origin are build-time env vars (see `.env.example`):

- `PUBLIC_APP_URL` — primary CTA → the Pulse app (dev default `http://localhost:3001`)
- `SITE` — canonical origin baked into SEO meta (placeholder default)

Site metadata, CTA target and the category list live in `src/lib/site.ts`.

See [`wiki/apps/pulse-landing.md`](../../wiki/apps/pulse-landing.md).

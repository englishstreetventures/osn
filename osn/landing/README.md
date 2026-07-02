# @osn/landing

Marketing / landing site for **OSN**. Static Astro + SolidJS + Tailwind v4 —
same stack as `@cire/landing`. Dark-grey, connections-led identity built on a
dotted / network motif (`ConstellationCanvas` backdrop + `ConnectionsHero`).

Pure brochure: no OSN auth, no first-party API calls.

## Run

```bash
bun run --cwd osn/landing dev        # dev server on http://localhost:4324
bun run --cwd osn/landing build      # static build → dist/
bun run --cwd osn/landing check      # astro check (type-check)
bun run --cwd osn/landing test:run   # vitest
```

## Config

CTA targets + canonical origin are build-time env vars (see `.env.example`):

- `PUBLIC_APP_URL` — primary CTA → the OSN identity / social app (dev default `http://localhost:1422`)
- `PUBLIC_DOCS_URL` — optional docs / source link
- `SITE` — canonical origin baked into SEO meta (placeholder default)

Site metadata and CTA targets live in `src/lib/site.ts`.

See [`wiki/apps/osn-landing.md`](../../wiki/apps/osn-landing.md).

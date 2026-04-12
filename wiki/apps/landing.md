---
title: Landing
description: OSN marketing and landing page
tags: [app, marketing]
status: active
packages:
  - "@osn/landing"
---

# Landing

`@osn/landing` is the OSN marketing site -- the public-facing landing page that introduces the platform.

## Stack

- **Astro** -- static site generator with island architecture
- **SolidJS** -- interactive components (consistent with the rest of the OSN stack)

## Current Status

The landing site is **scaffolded** but design and content are pending. The Astro + Solid foundation is in place and the package is wired into the monorepo workspace.

## Deploy Target

Planned deployment to **Vercel** or **Cloudflare Pages** (decision pending).

## Development

The landing site is included in the monorepo dev command:

```bash
bun run dev    # Starts all dev servers including landing
```

For landing-specific work:

```bash
bun add <pkg> --cwd osn/landing    # Add dependencies
```

## Related

- [[monorepo-structure]] -- workspace layout and the `@osn/*` prefix

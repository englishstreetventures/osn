---
"@pulse/web": minor
---

Move the Pulse web app from a plain Vite SPA to SolidStart. Routes are now
file-based under `src/routes/`, the app entry is `src/app.tsx` with
`src/entry-client.tsx` / `src/entry-server.tsx`, and the build emits a
deployable server bundle through nitro. Rendering stays client-side
(`ssr: false`) until the issuer session cookie is forwarded server-side.

The package is also renamed `@pulse/app` → `@pulse/web` and its directory
`pulse/app` → `pulse/web`, matching `@pulse/api` / `@pulse/db` /
`@pulse/landing` and leaving `@pulse/ios` unambiguous. References across the
repo, docs, and wiki follow; historical changelog entries are left as-is.

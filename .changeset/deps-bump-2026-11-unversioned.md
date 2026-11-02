---
"@cire/api": patch
"@cire/build-tools": patch
"@cire/db": patch
"@cire/host": patch
"@cire/infra": patch
"@cire/invite-designs": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/ui": patch
"@cire/vendor": patch
"@tools/oxlint-house": patch
---

Dependency bumps within the caution window: `astro` 7.4.4, `@astrojs/solid-js`
7.1.0, `@astrojs/cloudflare` 14.4.3, `motion` 13.5.1, `cropperjs` 2.3.1,
`lucide-solid` 1.59.0, `effect` 4.0.7, `jose` 6.2.14, `oxlint` and
`@oxlint/plugins` 1.88.0, `oxfmt` 0.73.0,
`lefthook` 2.2.2, `turbo` 2.11.9, `bun-types` 1.4.4, `portless` 0.15.12,
`@opentelemetry/*` 0.223.0 and 2.12.0, `vitest` and the `@vitest/*` packages
5.0.5. `@shadcn/lint` stays on 0.1.0: 0.2.3 flags the `AccountMenu` trigger
classes in `musubi/social`.

`cropperjs` 2.3.1 adds a named `Cropper` export beside the default, so
`ImageCropModal` imports the named one.

`bun-types` 1.4.4 widens `Subprocess.signalCode` to `number | Signals | null`.
The dev-urls test now normalises the signal to a string before comparing.

`solid-js` stays on 1.9.15: 1.9.18 changes effect timing that two component
suites assume (the URL fragment write and a list count).

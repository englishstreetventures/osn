# @osn/ui

Shared SolidJS components for OSN identity flows. Any first-party OSN app
can drop these in to get a consistent sign-in / registration experience
without redirecting out to the OSN-hosted HTML.

## Exports

- `@osn/ui/auth/Register` — email + handle + OTP + optional passkey
  enrolment, three-step flow (`details` → `verify` → `passkey` → `done`).
- `@osn/ui/auth/SignIn` — three-tab sign-in (passkey / OTP / magic link)
  driving the new `/login/*` endpoints. Calls `adoptSession` on success.
- `@osn/ui/auth/MagicLinkHandler` — invisible root-level helper that
  finishes a magic-link sign-in when the URL contains a `?token=…`.

## Dependency injection

Each component takes an explicit `client` prop (a `RegistrationClient`
or `LoginClient` from `@osn/client`). The consuming app builds the client
once at boot with its own `issuerUrl`, so this package stays free of any
env-config coupling.

## Styling

Components use Tailwind v4 classes. The consuming app must use Tailwind
v4 + `@tailwindcss/vite` so that the plugin's automatic content scan
picks up the classes from `@osn/ui` source files.

## Consumed by

`@pulse/app` — any future first-party OSN app should follow the same
pattern.

# @shared/ui

The primitives every product here renders — `Button`, `Card`, `Modal`, `Dialog`,
`Field`, `Input`, `Select`, `Table`, `Notice`, `Chip`, `Stat`, `Meter`,
`EmptyState`, `Avatar`, `Badge`, `Tabs`, `Popover`, `DropdownMenu`, `Checkbox`,
`RadioGroup`, `OtpInput`, `UsernameInput`, `QrCode`, `InfoPopover` — plus
`cn()` and `clsx()`. Zaidan-style: owned source on Kobalte and Tailwind v4, not
a versioned dependency.

## What is not here

- **Auth views** — `SignIn`, `Register`, `PasskeysView`, `StepUpDialog`,
  `TotpView`, `SessionsView` and the rest are `@osn/auth-ui`. Each is a client
  of a named OSN ceremony, so its shape belongs to the spec.
- **cire's house chrome** — `@cire/ui`.

Nothing here knows about a session, an API client or an app's colour names. A
component that needs one of those belongs in one of the other two packages. The
line and the reason behind it are in `wiki/shared/osn-and-musubi.md`;
`wiki/shared/component-library.md` is the long form of this README.

## Using it

Import per component:

```ts
import { Button } from "@shared/ui/ui/button";
import { clsx } from "@shared/ui/lib/utils";
```

Two lines of CSS opt an app in — both live in its root stylesheet:

```css
@import "tailwindcss";
@import "@shared/design-tokens/tokens.css";
```

That import ships the `@custom-variant base (:where(&))` the components' defaults
compile against and the `@source` line pointing Tailwind at `shared/ui/src`, so
no app declares either. What an app still owes is a `--ui-*` mapping block —
`--ui-surface`, `--ui-ink`, `--ui-accent`, the rest — pointing the contract at
its own colour names. `pulse/web/src/app.css` and
`cire/host/src/styles/global.css` are the worked examples, and the vocabulary is
in `wiki/shared/design-tokens.md`.

Components are styled entirely in `base:`-prefixed contract utilities
(`base:bg-ui-surface`, `base:text-ui-ink`). `base:` compiles to `:where(…)`, so
a caller's **plain** utility wins by cascade — write `class="max-w-lg"`, never
`class="base:max-w-lg"`, which only ties.

## Tests

Two projects out of one `vitest.config.ts`, split by filename:

```bash
bun run --cwd shared/ui test:run      # unit — tests/**/*.test.tsx, happy-dom
bun run --cwd shared/ui test:browser  # browser — tests/**/*.browser.test.tsx, Chromium
bun run --cwd shared/ui test          # unit, watch mode
```

The unit tier parses no stylesheet and computes no layout, so it can assert a
class list and a DOM shape and nothing about what painted. Anything that turns
on real CSS, the top layer or a gesture goes in the browser tier, which renders
against `tests/test-support/tailwind.css` — a stand-in app that maps the whole
contract to a deliberately garish palette so roles can be told apart. See
`wiki/conventions/browser-tests.md`.

## Consumed by

`@musubi/social`, `@pulse/web`, all four cire surfaces, `@cire/ui`,
`@osn/auth-ui`, `@tools/lab` and `@tools/metrics`.

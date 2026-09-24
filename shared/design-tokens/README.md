# @shared/design-tokens

The token contract every shared component reads, and the conformance test that
makes it a contract rather than a naming convention.

## The idea in one paragraph

Shared components cannot hard-code colours, because a library that owns a brand
is a library only one app can use. They also cannot read each app's own token
names, because those disagree — `@musubi/social` and `@pulse/web` speak shadcn
(`--background`, `--card`, `--primary`), `@cire/*` speaks its own house ramp
(`--bg`, `--surface`, `--gold`). So components read a third set of names, the
**contract**, and each app maps its own vocabulary onto it once. This is the
same arrangement `@shared/toast` already uses with `--toast-*`, generalised.

## Using it

```css
@import "tailwindcss";
@import "@shared/design-tokens/tokens.css";

:root {
  --ui-ground: var(--bg);
  --ui-surface: var(--surface);
  --ui-ink: var(--text);
  --ui-accent: var(--brand);
  /* … the rest of the contract */
}
```

That is the whole integration. `tokens.css` also carries the `@source` and
`@custom-variant base` directives the components need, so no app declares them —
[#1041](https://github.com/xchromo/osn/issues/1041) verified both propagate
through a bare package specifier, and that the relative `@source` resolves
against the package's real path rather than through the `node_modules` symlink.

Then add one test:

```ts
import { readFileSync } from "node:fs";
import { assertContractConformance } from "@shared/design-tokens/conformance";

it("maps the contract without breaking contrast", () => {
  assertContractConformance({
    css: readFileSync("src/styles/global.css", "utf8"),
    scopes: [
      { name: "dark", selectors: [":root"] },
      { name: "light", selectors: [":root", ':root[data-theme="light"]'] },
    ],
  });
});
```

## Who writes `ui-*`

**Shared component packages only.** `@shared/ui`, `@cire/ui` and `@osn/auth-ui`
— anything that renders inside an app it does not own — write
`bg-ui-surface`, `text-ui-ink`, `text-ui-sm`. **Application code keeps its own
vocabulary**: cire keeps `bg-surface` and `text-gold`, pulse keeps `bg-card`.
The namespace exists precisely so adopting the contract does not mean rewriting
the 3,120 class attributes in the tree.

The prefix is `ui-` because that is what these names are *for*, and because a
prefix is read as a claim about ownership: nothing here belongs to the identity
system, and most of the surfaces painting with it never touch an OSN ceremony.
`wiki/shared/osn-and-musubi.md` is what decides which name a new package,
token or identifier takes.

## The contract

| Group     | Tokens                                                        | Obligation                                      |
| --------- | ------------------------------------------------------------- | ----------------------------------------------- |
| Grounds   | `--ui-ground`, `--ui-ground-deep`                           | what other tokens are measured _against_        |
| Surfaces  | `--ui-surface`, `--ui-surface-raised`, `--ui-surface-sunk` | also grounds, for contrast                      |
| Edges     | `--ui-hairline`                                              | decoration, **no floor**                        |
|           | `--ui-hairline-strong`                                       | 3:1                                             |
| Ink       | `--ui-ink`, `--ui-ink-secondary`                            | 4.5:1 against every ground and surface          |
|           | `--ui-ink-tertiary`                                          | 3:1 — large text, ornament, disabled only       |
| Accent    | `--ui-accent`, `--ui-accent-strong`                         | fills; what sits on them is what is measured    |
|           | `--ui-accent-soft`                                           | a tint of the accent, **not** a neutral surface |
|           | `--ui-accent-ink`                                            | 4.5:1 — the readable-on-a-ground variant        |
|           | `--ui-on-accent`                                             | 4.5:1 against the accent it sits on             |
| Status    | `--ui-success`, `--ui-warn`                                 | 4.5:1                                           |
|           | `--ui-danger`, `--ui-on-danger`                             | fill and its ink                                |
| Focus     | `--ui-focus`                                                 | 3:1                                             |
|           | `--ui-focus-width`, `--ui-focus-offset`                      | —                                               |
| Radius    | `--ui-radius-hair\|sm\|md\|lg\|pill`                         | —                                               |
|           | `--ui-radius-control`                                        | a role, not a size — defaults to `md`           |
| Type      | `--ui-font-body\|display\|mono`                              | —                                               |
| Motion    | `--ui-dur-fast\|base\|slow`, `--ui-ease-out\|in-out`        | —                                               |
| Elevation | `--ui-elev-1\|2`                                             | —                                               |

Three surfaces is the minimum, not a preference: `musubi/social` and `pulse/web`
both collapse shadcn's `secondary`/`muted`/`accent` onto one value and
`card`/`popover`/`background` onto another, so a two-surface contract cannot
express either without losing a distinction the app relies on. For the same
reason, an app mapping shadcn's _neutral_ `accent` must send it to a **surface**,
never to `--ui-accent-soft`, or it gets a coloured hover state where it wanted
a grey one.

## Scales

Four, clustered from what the monorepo actually used rather than invented.

**Type — 7 steps.** `xs` 0.7 · `sm` 0.8 · `base` 0.9 · `md` 1.05 · `lg` 1.3 ·
`xl` 1.75 · `2xl` 2.5rem.

There were **93 distinct font sizes** across 956 sites, nine of them between
0.7rem and 0.95rem. That is not a house style, it is drift. Seven steps and not
eleven because a scale nobody can hold in their head is another way of having no
scale — each step here is visibly distinct, which is what makes "use the next
step up" a decision rather than a guess.

**Tracking — 6 steps**, from 18 values, nothing moving more than 0.04em.
**Leading — 5 steps**, from 12 values, nothing moving more than 0.05.
**Measure — 7 steps**, content widths only.

### Migrating onto them

`SCALE_MIGRATION` in `src/index.ts` is the old→new table, and it is _derived_:
every value goes to its nearest step, with an exact tie resolving **up** (the
failure mode of a too-small label is illegibility; of a too-large one, a
slightly looser line). `tests/scales.test.ts` re-derives it and fails if the
table and the rule disagree, so the table cannot quietly acquire a hand-edit.

Three things the codemod must not touch:

- **Computed values** — `text-[calc(clamp(2rem,5vw,3rem)*var(--invite-heading-scale,1))]`
  is an expression, not a size. Snapping it to a step deletes a feature; cire's
  organisers choose that heading scale.
- **Variants** — `data-[state=open]:`, `aria-[current=page]:`. Selectors that
  share the bracket syntax. Treating them as sizes corrupts behaviour, which is
  worse than a visual regression and much harder to catch in review.
- **Layout constants** — a 240px rail, a 44% grid column. Not measures. Forcing
  a sidebar width into a typographic scale makes the scale meaningless rather
  than making the sidebar consistent. These stay arbitrary, deliberately.

**One thing that wants a designer, not a codemod:** the smallest step is 0.7rem
(11.2px), and six sites sit at 8–9.5px. They move up 2–3px, which on a badge or
a superscript is a visible change rather than a rounding difference.

## Conformance

`assertContractConformance` reads the stylesheet and measures every pair the
contract defines, in every scope you name.

It is a **rewrite** of `cire/host/tests/styles/tokens.test.ts`, not a move.
That harness finds tokens by regex over literal `--name: oklch(…)`
declarations, which works there because cire's ramps _are_ literals. A contract
mapping never is — it is `--ui-ink: var(--text)`, two or three hops from a
value — so against a mapping the regex matches nothing and asserts about an
empty set. A test that cannot fail. Hence the `var()` resolver, with cycle
detection.

What it does that a naive check does not:

- **Composites alpha** over the ground before measuring, in sRGB, because that
  is where a browser does it. Half the ink tokens in this monorepo are
  translucent and a naive ratio overstates every one.
- **Measures each ink against all five grounds and surfaces.** Ink that clears
  4.5:1 on the page and fails it on a raised menu is a real defect the
  one-ground version cannot see.
- **Knows what has no obligation.** A hairline is decoration; an invisible one
  must not fail a build.
- **Measures on-fill ink against its fill**, never against the page.

What it cannot do: it reads the stylesheet, not the browser. It knows nothing
about the cascade beyond the scopes you name and cannot see a colour injected at
runtime — cire's per-wedding palette lands on `<html>` from the server. It is a
**drift guard**. Real rendering is the browser tier's job
(`wiki/conventions/browser-tests.md`).

`unmapped` takes a token and a reason, and the reason appears in the failure
output of any pair that referenced it — so "we never got round to it" reads as
exactly that in CI.

## Why `@theme inline`

`inline` compiles `bg-ui-surface` to `background-color: var(--ui-surface, …)`,
resolved **at the element**. A subtree that redefines `--ui-surface` is
therefore followed correctly: a lab story showing both themes at once, a themed
section on a landing page, cire's invite preview rendering a wedding's palette
inside the organiser's chrome. Without `inline` the alias resolves once at
`:root` and every one of those silently shows the page theme.

Nothing reads `--color-ui-*` from JavaScript — an app reads its own `--ui-*` or
its own token — so the reason `cire/host` gives for keeping _its_ theme block
non-inline does not apply here.

## Why there is no `:root` block

Every fallback is written inline as `var(--ui-x, <value>)`. A package-level
`:root` is unlayered and lands at the import site, so it would beat an app
mapping written inside `@layer base` or a later `@theme` — the app would set a
token and silently get the package's value. `@shared/toast` avoids it the same
way.

The fallbacks are a neutral greyscale. An unmapped app renders legibly rather
than correctly, which is the point; anything resembling a house style here would
be a library owning a brand.

## Tests

```bash
bun run --cwd shared/design-tokens test:run
```

A large minority of them assert that the harness produces a **failure** — a
contrast guard that only ever goes green is indistinguishable from one that
measures nothing, which is exactly what the harness this replaces would have
done against a `var()`-based mapping.

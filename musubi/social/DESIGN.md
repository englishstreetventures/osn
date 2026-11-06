# Design — Musubi Social

A locked design system for the `@musubi/social` app. Every screen reads this file
before it changes visual style. Do not regenerate per page — extend or amend
this file when the system needs to grow.

The system is deliberately near-monochrome and typographic: SF Pro, a tight
grey ink hierarchy, two corner radii plus a pill, and nothing else competing
for attention. It is scoped to `@musubi/social` only — it lives in
`src/App.css` and per-screen class overrides, and never edits the shared
`@shared/ui` primitives (those are used by cire and pulse too).

Each section states its rules. Where the code does not meet one yet, a "Where
the app does not follow this yet" list says so, with the issue that fixes it
where one exists. Those lists name known breaks; they do not claim to name
every one.

## The one design law

Ink carries the hierarchy; colour only marks status. A screen tells its parts
apart by grey, size and weight, never by a hue. The only hues are the status
colours in §Colour, each held to the uses named there.

## Genre

modern-minimal (utility app · left-rail workbench on desktop · bottom-tab
shell on mobile)

## Colour

### Ink hierarchy

Three greys carry all hierarchy. Values are in `src/App.css` (`:root` for
light, `.dark` for dark).

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--foreground` (`text-foreground`) | `#292929` | `#f2f2f2` | primary text; also `--primary`, the filled-CTA background |
| `--muted-foreground` (`text-muted-foreground`) | `#5d5d5d` | `#a3a3a3` | secondary text (subtitles, descriptions) |
| `--subtle` (`text-subtle`) | `#8d8d8d` | `#7a7a7a` | resting icons and ornaments; never text a reader needs |
| `--background` | `#ffffff` | `#1c1c1c` | the page |
| `--card`, `--popover` | `#ffffff` | `#242424` | cards, dialogs, menus |
| `--muted` (and `--secondary`, `--accent`) | `#f4f4f4` | `#2b2b2b` | hover and fill surfaces |
| `--border` | `#ececec` | `#333333` | hairline rule |
| `--input` | `#e2e2e2` | `#3a3a3a` | control borders |
| `--ring` | `#5d5d5d` | `#a3a3a3` | focus ring |

Text a reader needs — a handle, a status, a hint, a "Loading…" line — takes
`text-muted-foreground`, never `text-subtle`. `--subtle` is for resting icons
and ornaments, and clears 3:1 (WCAG 1.4.11's floor for an icon) on every
ground it rests on:

| `--subtle` | on `--background` | on `--card`, `--popover` | on `--muted`, `--secondary`, `--accent` | on `muted/60` over the page |
| --- | --- | --- | --- | --- |
| Light `#8d8d8d` | 3.32:1 | 3.32:1 | 3.02:1 | 3.13:1 |
| Dark `#7a7a7a` | 3.97:1 | 3.62:1 | 3.30:1 | 3.57:1 |

*Measured 2026-11-07 — `contrastRatio` from `@shared/color` over the `App.css`
values; `muted/60` composited first, each sRGB channel `0.6 × muted + 0.4 ×
--background`. `tests/styles/design-token-contract.test.ts` re-checks 3:1 on
the five contract grounds in both themes.*

`text-subtle` rests in five places: the rail's small-caps "Social" tag, part of
the wordmark, which WCAG 1.4.3 exempts as a logotype (`Sidebar.tsx`); the
rail's and the bottom bar's resting nav icons (`Sidebar.tsx`, `MobileNav.tsx`);
the theme menu's option icons (`ThemeToggle.tsx`); and the organisation list's
row chevron (`OrganisationsPage.tsx`).

### Borders

- A bare `border` (any side) draws the hairline, `--border`. `App.css` sets
  `border-color` in its base layer; Tailwind's preflight leaves it at
  `currentColor`, which would draw ink.
- A bare-bordered text field (`input`, `textarea`, `select`) keeps the ink
  edge, `currentColor`. Its fill is the ground's, so the edge alone shows where
  it is, and `--input`, the edge `@shared/ui`'s `Input` draws, sits under the
  3:1 a control's boundary needs (§The contrast contract).
- A class that names a colour (`border-border`, `border-input`,
  `border-foreground`) wins over both, since utilities outrank the base layer.

### Status colours

Three hues, each held to its uses:

- **Success** — `text-success` in app code, `text-ui-success` in shared parts
  (`--toast-accent-success`: `oklch(48% 0.13 150)` light, `oklch(78% 0.13 150)`
  dark). Ink for a confirmed good state. Uses today: "Verified by Musubi" on
  `/authorize` (`AuthorizePage.tsx`), the "Accepted" line after an email code
  in `Register`, "@handle is available" in `@shared/ui`'s `UsernameInput`, and
  the accepted border of `OtpInput`.
- **Warn** — `--toast-accent-warn` (`oklch(52% 0.12 75)` light,
  `oklch(80% 0.12 75)` dark). A border and a wash only, never ink. Uses
  today: the security-events banner (`border-ui-warn/40 bg-ui-warn/10`, in
  `@osn/auth-ui`'s `SecurityEventsBanner`) and the legal pages' draft notice
  (`border-warn/40 bg-warn/10`, `LegalDocument.tsx`).
- **Red** — `--destructive`. Remove and delete: the `destructive` Button (red
  fill, at rest) and `ghostDanger` (red on hover only, for a Remove repeated
  down a list).

Red text also renders today in the failed-load line (§Empty states and failed
loads), in the error lines on `/authorize`, and in the auth views' error lines
(§Auth surfaces).

Success as ink, on each of the contract's five grounds, and ink on the warn
wash:

| | Light: `--background`, `--card`, `--popover` | Light: `--muted`, `--secondary` | Dark: `--background` | Dark: `--card`, `--popover` | Dark: `--muted`, `--secondary` |
| --- | --- | --- | --- | --- | --- |
| Success ink | 6.16:1 | 5.60:1 | 8.95:1 | 8.15:1 | 7.44:1 |

| On the warn wash (`warn/10` over `--background`) | Light | Dark |
| --- | --- | --- |
| `--foreground` | 12.69:1 | 12.50:1 |
| `--muted-foreground` | 5.75:1 | 5.55:1 |

*Measured 2026-11-06 — `contrastRatio` from `@shared/color` over the `App.css`
values above; the wash is composited first, each sRGB channel
`0.1 × warn + 0.9 × --background`. `tests/styles/design-token-contract.test.ts`
re-checks the 4.5:1 floor for success and warn on all five grounds in both
themes.*

### The contrast contract

`tests/styles/design-token-contract.test.ts` parses `App.css` and checks every
role in the `@shared/design-tokens` contract in both themes: body ink, success
and warn at 4.5:1 on every ground and surface, the focus ring at 3:1, and ink
on a fill against that fill. One role carries a waiver, with its reason in the
test: `--ui-hairline-strong`, which takes `--input` (1.30:1 on the page in
light, against a 3:1 floor). No base rule draws it on an element that does
not name it (§Borders).

## Typography

- **Face** — SF Pro, via the system stack `-apple-system, BlinkMacSystemFont,
  "SF Pro Text", "SF Pro Display", …`. No web-font download; real SF Pro on
  Apple devices, graceful fallback elsewhere. (Apple's own optical split —
  SF Pro Text ≤19px, SF Pro Display ≥20px — happens automatically.)
- **Weights** — 400 (regular) and 500 (medium) only. No semibold/bold.
- **Tracking** — `-0.15px` everywhere (set on `body`, baked into each type token).
- **Scale — four sizes only.** Use the semantic utilities, never raw `text-lg`,
  `text-xl`, `text-base`, or arbitrary `text-[Npx]`.

  | Utility | Size / line-height | Role |
  | --- | --- | --- |
  | `text-display` | 24 / 30 | page titles (`h1`), large avatar initials |
  | `text-title`   | 14 / 20 | person & org names, section headers, card titles, default Button labels |
  | `text-body`    | 13 / 18 | nav, tabs, `size="sm"` Button labels, body copy, subtitles |
  | `text-meta`    | 12 / 16 | handles, timestamps, captions, helper text |

- **Buttons** — `@shared/ui`'s Button sets its label at `--ui-text-base`,
  which Musubi maps to `text-title` (14px), weight 500; `size="sm"` steps down
  to `--ui-text-sm`, `text-body` (13px).
  `tests/styles/token-contract.browser.test.tsx` holds the default size.
- **Text fields** — `@shared/ui`'s `Input` sets 14px (`--ui-text-base`) at its
  default size; below 768px Musubi's mobile input exception raises it to 16px.
- **Mobile input exception** — form controls (`input`, `select`, `textarea`)
  render at **16px** below 768px (app-scoped rule in `App.css`). Mobile Safari
  zooms the page when a focused control is under 16px; this is the one
  sanctioned deviation from the four-size scale. Never fix the zoom with
  `maximum-scale` — that breaks accessibility zoom.
- **Shared parts** — the contract has seven steps where the app has four.
  Musubi maps the four where they belong and fills the gaps by continuing its
  own progression (§Token contract), so a shared part that asks for 16px, 20px
  or 32px gets it.
- **Legal prose** — the body of `/privacy` and `/terms` sits in `.prose-legal`
  (`App.css`, components layer), which `LegalDocument.tsx` puts round the body
  alone, not the title, draft notice or "Last updated" line above it. `h2` is
  `text-title` at 500 with 32px above and 8px below; `h3` `text-body` at 500,
  20px above and 4px below; paragraphs and list items `text-body` at a 1.65
  line height (`leading-ui-relaxed`, 21.45px), paragraphs 12px apart; lists
  take discs or numbers, indented 20px; `strong` is 500. The line height is
  the one place the scale's own leading gives way: a page of 13px text at 18px
  reads as a wall. The head above the body is a page head (§Layout): the
  title `text-display` at 500, "Last updated" a `text-body` subtitle in
  `text-muted-foreground`, and the draft notice `text-body` with "Draft" at
  500.

Where the app does not follow this yet — known breaks include:

- `@shared/ui`'s `DialogTitle` and `CardTitle`: 16px (`--ui-text-md`) at
  weight 600 (#2040).
- `@shared/ui`'s `Badge`: weight 600 (#2041). `AvatarFallback`: weight 600.
  `OtpInput`'s digits: 16px (`--ui-text-md`).
- Settings → Security: the "Recovery codes" heading is `text-lg font-semibold`
  and its intro `text-sm` (`SecuritySection.tsx`) (#2045).
- `text-sm` on the recovery-codes prompt's body (`RecoveryCodesPrompt.tsx`).
- `/authorize` writes `text-caption`, which no stylesheet defines, so those two
  lines take the size around them (#2039).
- The auth views (§Auth surfaces) (#2045).

## Radii — two families + pill

- **8px** (`--radius`, `rounded-lg`/`rounded-md`) — nav items, list rows,
  dropdown triggers, small controls; text fields (`@shared/ui`'s `Input`,
  `Textarea` and `Select`, through the contract's `--ui-radius-field`, which
  Musubi maps to `--radius-md`); and, through `--ui-radius-md`, `@shared/ui`'s
  Popover and menu panels and `OtpInput`'s boxes.
- **16px** (`rounded-card`; the contract's `--ui-radius-lg`) — card surfaces
  (`@shared/ui`'s `Card`: Settings' sections, Discover's suggestions),
  bordered rows, dialogs, empty states. A card that is not itself a control
  takes no hover wash; a row that is a link or a button does.
- **pill** (`rounded-pill`; the contract's `--ui-radius-control` and
  `--ui-radius-pill`) — every Button variant, `ghost`, `ghostDanger` and
  `link` included (the radius sits on Button's base class,
  `shared/ui/src/ui/button.tsx`); badges; avatars.
- **Sheets** — below `md`, dialogs render as bottom sheets: 16px top corners
  (the contract's `--ui-radius-sheet`, which Musubi leaves to fall back to
  `--ui-radius-lg`) with square bottom corners, pinned to the bottom edge (see
  Responsive layout).

Where the app does not follow this yet — known breaks include:

- `@shared/ui`'s default menu rows, the account menu's and the theme menu's,
  take `--ui-radius-sm`, 6px (#2103). The token stays 6px because
  `@shared/ui`'s drawn Checkbox, a 16px box, reads it too, and would turn
  round at 8px.

## Icons

- **14px** (`h-3.5 w-3.5`) — sidebar navigation icons
- **20px** (`h-5 w-5`) — card / content icons (row chevrons, etc.) and the
  mobile bottom-tab-bar icons
- Inline SVG, `stroke="currentColor"`. A resting icon takes `text-subtle`; the
  label beside it takes `text-muted-foreground` (the rail's links, the bottom
  bar's tabs). An active nav item draws icon and label in `text-foreground`,
  and marks itself with a shape as well: the rail's with the `bg-muted` fill,
  the bottom bar's with a 2px bar along its top edge (§Responsive layout).

## Theme (light / dark)

Follow the system theme by default; the fallback is **dark**. Light is shown
only when the OS explicitly asks for light, or the user opts into light.
`prefers-color-scheme: dark` and "no preference" both resolve to dark.

- Preference (`system` / `light` / `dark`) persists in `localStorage` (`osn-theme`);
  default is `system`. Resolution lives in `src/lib/theme.ts` (`resolveTheme`).
- A synchronous mirror in `index.html` sets `.dark` before first paint (no flash).
  Keep the two in sync.
- The three-grey ink hierarchy inverts in `.dark` (paper `#1C1C1C`, ink `#F2F2F2`,
  etc.) in `App.css`; type/radii/spacing are theme-agnostic.
- Opt-in control: the `ThemeToggle` (System / Light / Dark) in the sidebar
  header and in the mobile top bar: a ghost icon Button opening `@shared/ui`'s
  `DropdownMenu`, one radio row per choice (`DropdownMenuRadioGroup`), so it
  draws the account menu's rows, focus and trailing check, and a screen reader
  hears which theme is on.

## Focus

Every element the keyboard reaches shows a focus mark on `:focus-visible`,
drawn in `--ring` (the contract's `--ui-focus`), which the contrast contract
holds at 3:1. A focus mark appears at once, never animated.

- **The base rule.** `App.css` outlines every `:focus-visible` element from
  its base layer: 2px solid `--ui-focus`, 2px off (`--ui-focus-width`,
  `--ui-focus-offset`). It reaches the elements the browser outlines anyway —
  links, buttons, form fields, a `<summary>` — so a control drawn by hand needs
  no focus class to show one. The account-menu triggers in the rail and the
  phone top bar take it this way.
- **Inset where a box clips.** Where an outline 2px outside the element would
  be cut off, the call site adds `focus-visible:-outline-offset-2`, which draws
  the same ring just inside the element. Today: the bottom bar's tabs, whose
  cells run to the screen's edges (`MobileNav`); `SectionTabs`, whose row
  scrolls sideways; and the profile switcher's rows, which run to the dialog's
  edges, inside a sheet that scrolls below `md` (`ProfileSwitcherDialog`).
- **Parts that draw their own.** `@shared/ui`'s parts draw focus from the
  utilities layer, which outranks the base rule, so each shows one mark, not
  two: Button a ring (`ring-2 ring-ui-focus`) with its outline hidden
  (`outline-hidden`), the text fields a ring 2px off, and a menu row (the
  account and theme menus) the sunk fill, its outline hidden while it has
  focus. A hand-drawn control that wants the ring instead writes
  `focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden`;
  the profile choice on `/authorize`'s account screen does
  (`AuthorizePage.tsx`, in the contract's `ring-ui-focus`, the same colour).
- **Contrast themes.** Windows forced colours drop the ring and the fill, and
  `outline-hidden` there is a 2px system-colour outline, so a `Button`, a menu
  row or the profile choice still shows focus. `outline-none` removes that outline
  too: never pass it to an element that draws a ring.

## Motion

The app adds colour and opacity transitions only, and no spatial motion of its
own. Rows, tabs and controls fade their colours with `transition-ui-colors`
(`App.css`): Tailwind's `transition-colors` with `outline-color` left out, the
same utility each cire app defines. Never `transition-colors` or
`transition-all` on anything that takes focus: both fade the outline, so the
focus mark arrives late. A loading placeholder is a block drawn at the call
site in the loaded row's shape (`bg-muted/50 animate-pulse`), which pulses in
opacity.

Where the app does not follow this yet: `@shared/ui`'s Dialog (as card and as
sheet), Popover and default menu run the shared overlay motion. They fade and
scale from 96% as they open and to 98% as they close (`zoom-in`, `zoom-out`),
and the popover and menu grow from their trigger
(`wiki/shared/design-tokens.md` §Motion). They move to a fade with no scale,
the owner's decision on #2034, when #2040 lands.

## Layout

- Desktop shell (`md+`) = fixed **240px left rail** (`Sidebar.tsx`) +
  scrollable content.
- Content column centered at `max-w-2xl`, `px-4 py-6 md:px-8 md:py-8` — every
  page's `main`, and the account banners above it at the same width and side
  padding. The legal pages use `max-w-2xl px-6 py-12`.
- Page head = `text-display` title + optional `text-body` muted subtitle.
- `/authorize` = no shell; one centred column, `max-w-md px-6 py-10`, centred
  vertically in the viewport.

## Responsive layout

One breakpoint: **`md` (768px)**. Below it the app is a mobile shell; at and
above it, the desktop rail. Never introduce additional breakpoints without
amending this file.

- **One shell at a time** — `Layout` (`App.tsx`) mounts either the rail or the
  mobile shell, chosen by an `md` media-query signal.
- **Mobile shell** = `MobileTopBar` (wordmark · theme toggle · account
  control) above the scroll column + `MobileNav` (fixed bottom tab bar, the
  five primary destinations, 20px icons + `text-meta` labels). The current tab
  draws a 2px `--foreground` bar along its top edge as well as full ink, as
  `SectionTabs` underlines its current tab, so ink is not its only mark. Nav
  items are
  defined once in `nav.tsx` and shared by both shells. The mobile wordmark is
  the product name alone: the desktop rail's small-caps "Social" tag is left
  out, because at 320px the signed-out bar has no room for it beside "Sign in"
  and "Create account".
- **Search** is the one asymmetric surface, because the reachable spot
  differs by shell. The desktop rail carries a live combobox (`GlobalSearch`)
  under the wordmark; mobile gets a **Search tab** in the bottom bar routing
  to `/search`, which is thumb-reachable in a way a header field is not — so
  the top bar keeps its three-item composition and costs no vertical space.
  The nav item is marked `mobileOnly` and filtered out of the rail
  (`DESKTOP_NAV_ITEMS`) so the same destination never has two doors on one
  shell. `MobileNav`'s column count is derived from the item count against a
  static Tailwind allow-list — adding a sixth destination means adding
  `grid-cols-6` there.
- **Viewport** = `h-dvh` (never `h-screen`/`100vh` — iOS toolbars),
  `viewport-fit=cover` with `pt-safe`/`pb-safe`/`px-safe` utilities padding
  the fixed chrome out of the notch and home-indicator regions. The scroll
  column pads with `pb-nav` so content clears the tab bar.
- **Dialogs** = `ResponsiveDialogContent`, which is `@shared/ui`'s
  `DialogContent` with `presentation="sheet"`: a bottom sheet below `md`
  (16px top corners, square bottom corners, `max-h-[85dvh]`, scrolling, padded
  clear of the home indicator), the shared centred card at `md+`. All app
  dialogs go through it; never mount a raw `DialogContent` in a screen.
- **Touch targets** = ≥40px visual / 44px effective on mobile. The mechanism
  is `max-md:` call-site utilities (e.g. `h-7 max-md:h-10` on row actions,
  `max-md:min-h-11` on tabs); rows keep `hover:` classes and add matching
  `active:` classes for touch feedback. Tab rows scroll (`overflow-x-auto`)
  rather than wrap or shrink.
- **Toasts** = top-center below `md` (clear of keyboard + tab bar),
  bottom-right at `md+`.
- The bare `/authorize` route renders with **no shell at any width**.

Where the app does not follow this yet:

- Three classes switch at `sm` (640px), not `md`: Discover's two grids of
  suggestions, the loaded one and its placeholder (`sm:grid-cols-2`,
  `DiscoverPage.tsx`), and the organisation list's description line
  (`sm:block`, `OrganisationsPage.tsx`) (#2057).
- Each app dialog passes a width cap (`max-w-sm`, or `max-w-xs` on the profile
  switcher), and the cap applies to the sheet too, so on a phone a sheet is no
  wider than the cap (#2038).
- The dialogs `@osn/auth-ui`'s views open themselves use `DialogContent`
  without `presentation="sheet"`, so they stay a centred card below `md`
  (#2045).

## Empty states and failed loads

- **Empty states** = `EmptyNote` (`src/components/EmptyNote.tsx`): the dashed
  `rounded-card` block, `size="page"` (`py-16`) for a page's whole content,
  `size="section"` (`py-12`) for one list. It is an `<output>`, so a state
  that replaces a skeleton is read out. Never draw the block by hand.
- **A load that failed** for any reason the screen does not name is a
  `text-destructive text-meta` line with `role="alert"` that ends "Reload and
  try again." — never the empty-state block, which means "nothing here". A
  screen whose head comes from what failed to load keeps its section's head
  above the line (`OrgDetailPage` falls back to "Organisations").

## Auth surfaces

Sign-in, registration, step-up and the Security settings are `@osn/auth-ui`
views. `osn/auth-ui/DESIGN.md` governs them; this section says how Musubi
hosts them.

**How they render here.** `@shared/design-tokens/tokens.css`, which `App.css`
imports, carries the `@source` for `osn/auth-ui/src`, so the views' classes
compile in this app. The views' own classes name the shadcn colour vocabulary
(`text-muted-foreground`, `text-destructive`, `bg-muted`), which `App.css`
defines, and Tailwind's default type steps (`text-xs`, `text-sm`, `text-lg`,
`text-2xl`), which Musubi's `@theme` leaves as Tailwind sets them: 12/16,
14/20, 18/28 and 24/32. The `@shared/ui` parts inside the views render through
the contract mapping (§Token contract). So the views do not follow this file's
four-step scale or its weights today (#2045).

`App.css`'s base rules reach the views too: their bare-bordered rows
(`PasskeysView`, `TotpView`, `RecoveryCodesView`) draw the hairline, the raw
code fields in `StepUpDialog` keep their ink edge, and every control the views
draw by hand shows the base focus outline (§Borders, §Focus).

**Where each view mounts:**

| View | Where | Host file |
| --- | --- | --- |
| `SignIn`, `Register` | The sign-in and create-account dialogs: a sheet below `md`, a centred card capped at `max-w-sm` above | `components/AuthDialogs.tsx`, mounted by `Sidebar` and `MobileTopBar` |
| `SignIn`, `Register` | `/authorize`, in a bordered `rounded-card` frame under the client card; "No account yet? Create one" swaps to `Register` | `components/AuthorizeSignIn.tsx` |
| `RecoveryLoginForm` | Inside `SignIn`, from "Lost your passkey?" | — |
| `TurnstileWidget` | Inside `SignIn`, `Register` and `RecoveryLoginForm`'s emailed-code step, when a site key is set | — |
| `PasskeysView`, `TotpView`, `RecoveryCodesView` | Settings → Security, in that order, the last under the app's own "Recovery codes" heading | `components/SecuritySection.tsx` (lazy) |
| `SecurityEventsBanner` | The account banner stack, above every signed-in page | `components/SecurityEventsBannerMount.tsx`, via `AccountBannerStack.tsx` |
| `ProfileOnboarding` | Settings, above the tabs, dismissible; its dialog holds `CreateProfileForm` | `pages/SettingsPage.tsx` |
| `StepUpDialog` | Inside `PasskeysView`, `TotpView`, `RecoveryCodesView` and `SecurityEventsBanner`, when an action needs it | — |

**What Musubi supplies:**

- `productName` — `PRODUCT_NAME`, "Musubi" (`src/lib/auth.ts`).
- The API clients, built once in `src/lib/authClients.ts`; the authenticated
  ones send through `osnAuth.authFetch`, the page's one auth runtime
  (`src/lib/auth.ts`), so no view is handed a token.
- Ceremony runners: `runPasskeyCeremony` (`src/lib/webauthn-ceremony.ts`) to
  the Security views and the banner; `runPasskeyRegistration`
  (`src/lib/webauthn-registration.ts`) to `PasskeysView`;
  `runPasskeyRegistrationDeferred` (`src/lib/webauthn-registration-deferred.ts`)
  to `SignIn`.
- The Turnstile site key, `TURNSTILE_SITEKEY` (`src/lib/auth.ts`).
- `AuthProvider` around the shell, and a second one inside
  `AuthorizeSignIn` on `/authorize`, both on the same `osnAuth` runtime; the `Toaster` in `App.tsx`; and the
  `Dialog` that frames `SignIn` and `Register`, which draw none of their own.

## Token contract

`@shared/ui` parts paint only `ui-*` utilities, and the `:root` block under
"Design-token contract" in `src/App.css` says which of Musubi's colours, radii
and type steps plays each role. That block is the whole integration; the app's
own vocabulary (`bg-card`, `text-muted-foreground`) stays as written.

- **Colour.** Each `--ui-*` colour aliases a shadcn name, so `.dark` carries the
  mapping with it. Two mappings read wrong at first sight, and the comment
  above the block explains both: `--ui-accent-soft` takes `--muted` (a tint of
  the ink accent), not shadcn's neutral `--accent`; `--ui-ground-deep` takes
  `--secondary`, which in dark mode is lighter than the page. `--ui-accent-strong`
  takes `--primary-hover` (`#000000` light, `#ffffff` dark).
  `--ui-hairline-strong` takes `--input`; `--ui-success` and `--ui-warn` take
  the toast accents; `--ui-danger` takes `--destructive`; `--ui-focus` takes
  `--ring`.
- **Radius.** `--ui-radius-sm` 6px, `-md` 8px, `-lg` 16px (`--radius-card`),
  `-pill` and `-control` a pill, `-field` 8px (`--radius-md`). No
  `--ui-radius-sheet` is set, so sheets take the large radius.
- **Base rules.** The bare-border and focus rules (§Borders, §Focus) read the
  contract's `--ui-hairline` and `--ui-focus`, so a subtree that maps its own —
  the lab's cire column — draws its own colours.
- **Type.**

  | Contract step | Musubi value |
  | --- | --- |
  | `--ui-text-xs` | `--text-meta`, 12px |
  | `--ui-text-sm` | `--text-body`, 13px |
  | `--ui-text-base` | `--text-title`, 14px |
  | `--ui-text-md` | 16px |
  | `--ui-text-lg` | 20px |
  | `--ui-text-xl` | `--text-display`, 24px |
  | `--ui-text-2xl` | 32px |

- **Tracking.** `--ui-tracking-tight` and `-normal` are `-0.15px`; `-wide` is
  `0em`, which the rail's small-caps "Social" tag uses.
- **Overrides.** Every `@shared/ui` class sits behind the `base:` variant, which
  has zero specificity, so a class passed at a Musubi call site wins without
  touching the library. `Card`, `Button` and `DialogContent` already take the
  contract's radii (16px, pill, 16px), so a call site adds no radius class to
  them.

## What screens MUST share

The SF Pro stack, the `-0.15px` tracking, the three-grey ink hierarchy, the
four-size scale, the two-radius + pill system, pill buttons in every variant,
and colour for status only: success, warn and red within the uses §Colour
names.

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

Text a reader needs — a handle, a status, a hint, a "Searching…" line — takes
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
the wordmark, which WCAG 1.4.3 exempts as a logotype (`RailHead` in
`ShellFrame.tsx`, drawn by the rail and its loading frame); the
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
- `@shared/ui`'s `OtpInput` draws an empty box's edge in ink at 55%, which
  holds 3:1 against the box's fill and the sheet around it in both themes.
- A class that names a colour (`border-border`, `border-input`,
  `border-foreground`) wins over both, since utilities outrank the base layer.
- A menu's separator (`@shared/ui`'s `DropdownMenuSeparator`, in the account
  menu) is a 1px fill in `--ui-hairline`, which Musubi maps to `--border`, and
  draws no border of its own: the hairline in both themes, not the panel's
  ink. `AccountMenu.tsx` passes it no class.

### Status colours

Three hues, each held to its uses:

- **Success** — `text-success` in app code, `text-ui-success` in shared parts
  (`--toast-accent-success`: `oklch(48% 0.13 150)` light, `oklch(78% 0.13 150)`
  dark). Ink for a confirmed good state. Uses today: "Verified by Musubi" on
  `/authorize` (`AuthorizePage.tsx`), "@handle is available" in `@shared/ui`'s
  `UsernameInput`, and the accepted border of `OtpInput`.
- **Warn** — `--toast-accent-warn` (`oklch(52% 0.12 75)` light,
  `oklch(80% 0.12 75)` dark). Ink inside `@shared/ui`'s `Notice`
  (`tone="warn"`) and only there: its words and its circled "!" mark, on the
  notice's own wash (`ui-warn/5`, edged `ui-warn/20`). Everywhere else warn
  is a border and a wash, never ink. Uses today: the legal pages' draft
  notice (`Notice tone="warn" size="sm"`, `LegalDocument.tsx`) and the
  security-events banner (`border-ui-warn/40 bg-ui-warn/10`, in
  `@osn/auth-ui`'s `SecurityEventsBanner`), a wash with no warn ink.
- **Red** — `--destructive`. Remove and delete: the `destructive` Button (red
  fill, at rest) and `ghostDanger` (red on hover only, for a Remove repeated
  down a list).

Red text also renders as the error line: `@shared/ui`'s `Notice`
(`tone="danger"`, which paints `--ui-danger` through the contract) in the
failed-load lines, on `/authorize`, in the shell's notices and in the auth
views (§Empty states and failed loads, §Auth surfaces); and as the shell
frame's failed-load line, a `text-destructive text-meta` line
(`ShellFrame.tsx`, §Layout). It sits on the page, a card or a popover, never
on `--muted`, `--secondary` or the warn wash, where light danger ink falls
under 4.5:1 (the table below).

Success as ink, on each of the contract's five grounds, ink on the warn
wash, and warn ink on a warn `Notice`'s wash:

| | Light: `--background`, `--card`, `--popover` | Light: `--muted`, `--secondary` | Dark: `--background` | Dark: `--card`, `--popover` | Dark: `--muted`, `--secondary` |
| --- | --- | --- | --- | --- | --- |
| Success ink | 6.16:1 | 5.60:1 | 8.95:1 | 8.15:1 | 7.44:1 |
| Danger ink (`--destructive`) | 4.77:1 | **4.34:1** | 5.90:1 | 5.37:1 | 4.90:1 |

| On the warn wash (`warn/10` over `--background`) | Light | Dark |
| --- | --- | --- |
| `--foreground` | 12.69:1 | 12.50:1 |
| `--muted-foreground` | 5.75:1 | 5.55:1 |
| `--destructive` | **4.16:1** | 4.85:1 |

| On a warn `Notice`'s wash (`warn/5` over `--background`) | Light | Dark |
| --- | --- | --- |
| Warn ink (`--toast-accent-warn`) | 5.25:1 | 8.20:1 |

*Measured 2026-11-06 (danger 2026-11-09, warn ink on the `Notice`'s wash
2026-11-10) — `contrastRatio` from `@shared/color` over the `App.css` values
above; a wash is composited first, each sRGB channel `0.1 × warn + 0.9 ×
--background` (`0.05` and `0.95` for the `Notice`'s).
`tests/styles/design-token-contract.test.ts` re-checks the 4.5:1 floor for
success and warn on all five grounds in both themes, for danger ink on the
five grounds, expecting it to fall short only on light `--muted` and
`--secondary`, and for warn ink on the `Notice`'s wash in both themes, with
the wash's strength read from `notice.tsx`.*

### The contrast contract

`tests/styles/design-token-contract.test.ts` parses `App.css` and checks every
role in the `@shared/design-tokens` contract in both themes: body ink, success
and warn at 4.5:1 on every ground and surface, the focus ring at 3:1, and ink
on a fill against that fill. It also checks danger ink, which the contract
holds only as a fill, at 4.5:1 on the grounds an error line sits on, and warn
ink at 4.5:1 on a warn `Notice`'s wash, the one place warn is ink. One role
carries a waiver, with its reason in the test: `--ui-hairline-strong`, which
takes `--input` (1.30:1 on the page in light, against a 3:1 floor). No base
rule draws it on an element that does not name it (§Borders).

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
  | `text-display` | 24 / 30 | page titles (`h1`) in the shell, `/authorize`'s client name (the `h1` on its sign-in and consent screens), large avatar initials, a number the person carries to another screen (`CheckEmailView`'s, and the numbers `ConfirmLinkPage` offers to pick from, in tabular figures; larger than the heading above them on purpose) |
  | `text-title`   | 14 / 20 | person & org names, section headers, default Button labels; card and dialog titles at the size and 500, on their own leading (Dialog and card titles, below); the `h1` of a bare route whose page is one card (`/authorize`'s dead end, its load-error card and "Choose a profile"; the emailed-link confirm page) |
  | `text-body`    | 13 / 18 | nav, tabs, `size="sm"` Button labels, body copy, subtitles |
  | `text-meta`    | 12 / 16 | handles, timestamps, captions, helper text |

- **Names and section heads** — a person's or an organisation's name, wherever
  it stands for them in a row or a card, is `text-title` at 500: the
  organisations list, the roster, search results (the page and the rail's
  panel), Settings' profile card, and `/authorize`'s account screen, profile
  picker and consent screen. The handle under it is `text-meta` in
  `text-muted-foreground`. A heading that opens a section inside a page
  ("Members", "Signed in as", `/search`'s "People" and "Organisations") takes
  the same step and weight, in `text-foreground`. A shell page's `h1` is
  `text-display` (§Layout). `/authorize`, which has no shell, leads with the
  app's name on its client card at `text-display` and 500, so the app the
  reader is signing in to is the screen's first word ([the owner's
  call](https://github.com/englishstreetventures/osn/issues/2034#issuecomment-6680062893), 2026-11-06), breaking anywhere since the app chose the words; the screen's own heading under it
  is `text-title` at 500 (the sign-in panel's title, "Signed in as"). The
  profile picker, which draws no client card, titles its screen "Choose a
  profile" at `text-title` and 500. The rail's account trigger is shell chrome and keeps its own
  size.
- **Dialog and card titles** — `@shared/ui`'s `DialogTitle` and `CardTitle`
  are `text-title`'s 14px at 500. Both set their size with `--ui-text-md` and
  their weight with `--ui-weight-title`, which the contract block in `App.css`
  maps to `--text-title` and 500 (§Token contract); a call site sets neither,
  and `shadcn/no-restyle` refuses a type class on either. `--ui-text-md`
  carries the size and not the step's 20px leading: `DialogTitle` inherits the
  body's 18px, and `CardTitle` keeps the shared part's `leading-none`, 14px.
- **Consent marks** — `/authorize`'s "Verified by Musubi" and its "Third-party
  app" chip (§Chips) are `text-meta` at 500, so neither reads quieter than the
  other.
- **Buttons** — `@shared/ui`'s Button sets its label at `--ui-text-base`,
  which Musubi maps to `text-title` (14px), weight 500; `size="sm"` steps down
  to `--ui-text-sm`, `text-body` (13px).
  `tests/styles/token-contract.browser.test.tsx` holds the default size.
- **Text fields** — `@shared/ui`'s `Input` sets 14px (`--ui-text-base`) at its
  default size; below 768px Musubi's mobile input exception raises it to 16px.
  `OtpInput`'s digits read `--ui-text-md`, which is also `--text-title`, so
  they are 14px from 768px and 16px below, as `Input` is.
- **Mobile input exception** — form controls (`input`, `select`, `textarea`)
  render at **16px** below 768px (app-scoped rule in `App.css`). Mobile Safari
  zooms the page when a focused control is under 16px; this is the one
  sanctioned deviation from the four-size scale. Never fix the zoom with
  `maximum-scale` — that breaks accessibility zoom.
- **Shared parts** — the contract has seven steps where the app has four.
  Musubi maps the four where they belong, puts `--ui-text-md` on the title
  step beside `--ui-text-base` (the size shared titles ask for), and fills the
  steps above by continuing its own progression (§Token contract), so a shared
  part that asks for `lg` or `2xl` gets 20px or 32px. No shared part in
  Musubi draws at 16px except a form control below 768px.
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
  `text-muted-foreground`, and the draft notice a warn `Notice` at `sm`
  (§Status colours): 13px on a 1.5 line height, "Draft" at 500.

Where the app does not follow this yet — known breaks include:

- `@shared/ui`'s `AvatarFallback`: weight 600.
- `text-sm` on the recovery-codes prompt's body (`RecoveryCodesPrompt.tsx`).

## Radii — two families + pill

- **8px** (`--radius`, `rounded-lg`/`rounded-md`) — nav items, list rows
  (`/authorize`'s bordered profile rows among them), dropdown triggers, small
  controls; text fields (`@shared/ui`'s `Input`, `Textarea` and `Select`, and
  `OtpInput`'s boxes, through the contract's `--ui-radius-field`, which Musubi
  maps to `--radius-md`); through `--ui-radius-md`, `@shared/ui`'s Popover and
  menu panels; and the rail search's results panel (`GlobalSearch`), a
  floating panel drawn as the menus are: `rounded-md`, `bg-popover`,
  `shadow-md`. A bordered row nested inside a card takes 8px too, the card's
  own corner already spent; a row standing alone takes 16px ([the owner's
  call](https://github.com/englishstreetventures/osn/issues/2034#issuecomment-6680062893), 2026-11-06): `@osn/auth-ui`'s Settings rows, `Card
  radius="md" padding="sm"` inside Settings' card, and the new recovery codes'
  well.
- **16px** (`rounded-card`; the contract's `--ui-radius-lg`) — card surfaces
  (`@shared/ui`'s `Card`: Settings' sections, Discover's suggestions, the
  organisations list's rows, `/authorize`'s scope rows and its dead-end and
  error boxes), bordered rows (Settings' connected apps), dialogs, empty
  states. No card takes a hover wash: one that is a link says so with its
  chevron (below). A row that is a link or a button, and not a `Card`, does
  take one.
- **A card that is a link** — the organisations list — is a `Card`
  (`padding="sm"`) inside its `<A>`. `Card` owns its fill and padding (the
  `shadcn(no-restyle)` lint refuses a colour or padding class on it), so it
  takes no wash: its chevron turns from `--subtle` to full ink on hover and
  press (`group-hover:`, `group-active:` from the link), and the link's focus
  outline follows its 16px corner. Never a hand-drawn bordered box to win the
  wash back: that box has no fill, so in dark it loses the card's raised
  ground.
- **pill** (`rounded-pill`; the contract's `--ui-radius-control` and
  `--ui-radius-pill`) — every Button variant, `ghost`, `ghostDanger` and
  `link` included (the radius sits on Button's base class,
  `shared/ui/src/ui/button.tsx`); chips (§Chips); avatars.
- **Sheets** — below `md`, dialogs render as bottom sheets: 16px top corners
  (the contract's `--ui-radius-sheet`, which Musubi leaves to fall back to
  `--ui-radius-lg`) with square bottom corners at every width up to 767px,
  pinned to the bottom edge (see Responsive layout).

Where the app does not follow this yet — known breaks include:

- `@shared/ui`'s default menu rows, the account menu's and the theme menu's,
  take `--ui-radius-sm`, 6px (#2103), and so do `Notice`'s `sm` and `md`
  boxes (the shell's "You've been signed out." and the legal pages' draft
  notice). The token stays 6px because `@shared/ui`'s drawn Checkbox, a 16px
  box, reads it too, and would turn round at 8px.

## Chips

A word that names a role or a kind is `@shared/ui`'s `Chip`,
`variant="outline" treatment="tag"` in the neutral tone: a hairline edge,
secondary ink, 12px (`--ui-text-xs`, which Musubi maps to `text-meta`), set as
written in sentence case, on the pill corner. Uses today: the roster's role
("Admin", "Member", from `ROLE_LABEL` in `OrgDetailPage.tsx`, never the API's
raw value), "Member" on an organisation the searcher belongs to (`/search`
and the rail's results panel, `SearchResultRows.tsx`), and `/authorize`'s
"Third-party app".

- **Not filled.** The filled neutral chip paints `--ui-surface` at 60%, which
  Musubi maps to `--card`: white on a white page, so its shape vanishes in
  light.
- **Not small caps.** The rail's "Social" tag is the only small-caps label,
  and a chip's word reads as written.
- **Never `@shared/ui`'s `Badge`.** Three of its four variants fill the pill,
  the default with the accent, which in Musubi is ink: a black pill holding a
  white word, the look of a primary Button. `outline` fills nothing, but sets
  its word in full ink at 13px (`--ui-text-sm`) and the title weight, 500,
  where a chip's word is secondary ink at 12px and 400. A word that names a
  role is the outline chip above.
- **Weight.** A chip's word is 400, except "Third-party app": a trust mark
  beside a name the app chose for itself, it keeps 500, the weight of the
  consent screen's other mark (§Typography, Consent marks). The weight comes
  from a `font-medium` span inside the chip; `Chip`'s `class` is for layout
  only.

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
- **Where focus goes when a dialog closes.** Back to the element that had it
  when the dialog opened, if it is still in the page: `ResponsiveDialogContent`
  does this for every app dialog. No app dialog has a `Dialog.Trigger`, so
  without it Kobalte leaves focus on `<body>`. A shell dialog whose opener has
  gone — the shell switched while the dialog was open — gives focus to the
  current shell's control for the same dialog, which carries
  `data-dialog-return="sign-in" | "register" | "switcher"` (the shells' Sign
  in and Create account buttons, the account-menu trigger). After a sign-in
  succeeds, or a removal takes the row that opened it, neither exists, and
  focus stays on the page.
- **Contrast themes.** Windows forced colours drop the ring and the fill, and
  `outline-hidden` there is a 2px system-colour outline, so a `Button`, a menu
  row or the profile choice still shows focus. `outline-none` removes that outline
  too: never pass it to an element that draws a ring.

## Motion

The app adds colour and opacity transitions only, and no spatial motion of its
own, with two exceptions: the orb a busy button draws (§The orb), and a dialog
below `md`, which `@shared/ui` slides up and down as a sheet (below). Rows,
tabs and controls fade their colours with `transition-ui-colors`
(`App.css`): Tailwind's `transition-colors` with `outline-color` left out, the
same utility each cire app defines. Never `transition-colors` or
`transition-all` on anything that takes focus: both fade the outline, so the
focus mark arrives late. A loading placeholder is `@shared/ui`'s `Skeleton`
(§Empty states and failed loads), which pulses in opacity and stands still
under reduced motion. What replaces it arrives at once, with no fade, and so
do an error line and a step that replaces another (a sign-in step, the
authenticator's setup, a step-up's code): a fade would only hold back what the
reader is waiting for, and the jump in height it leaves could be bridged only
by spatial motion.

On the emailed-link page (`/verify/:requestId`) the loaded shape is the whole
card, so the placeholder is one `Skeleton` standing for a card
(`ResponsiveSkeleton`), at the ready card's height with five numbers on a
360–430px phone and on desktop: 552px below `md` and 520px from it (138 and 130
spacing steps). The product name above it stays put when the card arrives.
Meanwhile the page's live region says "Checking this link…".

*Measured 2026-11-10 — the ready card's `getBoundingClientRect().height` in
Chromium (Vitest browser tier, `ConfirmLinkPage` with five numbers, Musubi's
`App.css`): 568.9px at 320px wide; 550.7px at 360, 375, 390, 414 and 430px;
532.5px at 600px; 520.5px at 768 and 1280px. At 320×640 the column is taller
than the screen either way, so the name does not move;
`tests/pages/VerifyEmailLinkPage.layout.browser.test.tsx` holds it at 320×640,
390×844 and 1280×800.*

**Sheets slide; cards and menus fade, with no scale.** Below `md` every
dialog is a sheet (`ResponsiveDialogContent`, and `@osn/auth-ui`'s three,
§Responsive layout), and it slides up from the bottom edge as it opens and
back down as it closes, as an iOS sheet does: the owner's choice ("B: slide
up"), recorded on #2045 on 2026-11-13. It rises from its own height below the
edge over `--ui-dur-slow` (320ms) and falls over `--ui-dur-base` (200ms),
both on `--ui-ease-sheet` (`cubic-bezier(0.32, 0.72, 0, 1)`), at full opacity
and with no scale. The scrim fades in and out on the same pace and curve.
Closed part-way up, or reopened part-way down, the sheet turns round from
where it is. The slide is `@shared/ui`'s, on every app's sheets; Musubi adds
no class for it, and its scale tokens do not touch it.

From `md` the same dialog is a centred card, and a card, Popover (the
sign-up form's `InfoPopover`) and the default menu (the account and theme
menus) change their opacity alone as they open and close, the owner's
decision on #2034. The contract block in `App.css` maps `--ui-scale-enter`
and `--ui-scale-exit` to 1, so the shared `zoom-in` and `zoom-out` scale
nothing (`wiki/shared/design-tokens.md` §Motion); a call site adds no motion
class. The timing is the contract's: in over `--ui-dur-fast` (120ms) on
`--ui-ease-out`, out over `--ui-dur-exit` (80ms) on `--ui-ease-exit`, which
carries the same curve. The scrim fades with the panel. A sheet carried
across `md` while open (a phone turned, a window resized) does not slide:
down across it, it sits on the bottom edge at once; up across it, the card
fades in at its new place.

Under reduced motion each one shows and hides at once (`tokens.css` sets the
overlay animations and the sheet's transitions to `none`). Only cire's
`accent` menu look closes at once, and Musubi draws none. On a browser older
than Chrome 117, Firefox 129 or Safari 17.5, which cannot read
`@starting-style`, a sheet appears at once and still slides out.
`tools/e2e/tests/support/musubi-surfaces.ts` holds the first frame of the
account menu, the profile switcher and the create-organisation dialog, and
the half-way frame of the menu and the switcher closing: the menu and the
card show no transform, and the switcher, a sheet at 390px, sits its own
height below the edge as it opens and part-way down half-way out, at full
opacity and unscaled.

## The orb

A busy button (§Busy buttons) draws `@shared/ui`'s `Orb` before its label: a
20px sphere of dots, state `working`, in the button's own text colour, so it
reads on a filled button and on the page alike. It is the app's one canvas
animation and its one motion that is not a colour or opacity change.

- **It stops.** It moves for five seconds at most, then holds one still frame,
  so it needs no pause control (WCAG 2.2.2). Under reduced motion it draws that
  still frame from the start.
- **It says nothing.** The canvas is `aria-hidden`; the button's label and its
  `aria-busy` say what is happening.
- **Only in a busy button.** No page, empty state or loading placeholder draws
  it. A loading placeholder stays the opacity pulse (§Motion).
- **It loads on demand.** The orb is a chunk of its own, fetched at idle time
  once a page holds a `Button` that takes `busy`; until it lands a 20px box
  holds its room, so the label does not move (`wiki/shared/component-library.md`
  §The orb chunk).

## Layout

- Desktop shell (`md+`) = fixed **240px left rail** (`Sidebar.tsx`) +
  scrollable content.
- **The shell holds still.** Each shell is a lazy chunk, so on a cold load the
  page can paint before its shell arrives. Until it does, `Layout` draws the
  shell's frame in its place: the rail's 240px `aside` with its hairline and
  wordmark row, or the top bar's 48px header with the wordmark
  (`RailFrame`, `TopBarFrame` in `ShellFrame.tsx`). The shells are built from
  the same parts, so the frame and the shell share one box and the page beside
  them does not move when the shell lands. The rule covers the shell only:
  the account banners above a signed-in page still push it down when they
  arrive. The phone's tab bar needs no frame; it is fixed to the bottom edge,
  out of the flow, and the scroll column carries `pb-nav` from the first paint.
- **A shell whose chunk, or the shell dialogs' chunk, fails to load**
  (offline, or a chunk renamed by a deploy since the page loaded) leaves its
  frame in place with the failed-load line
  (§Empty states and failed loads): "Musubi could not finish loading. Reload
  and try again." The page beside it keeps working. A later load that succeeds
  (the other shell's, after a crossing) draws the shell with its dialogs.
- Content column centered at `max-w-2xl`, `px-4 py-6 md:px-8 md:py-8` — every
  page's `main`, and the account banners above it at the same width and side
  padding. The legal pages use `max-w-2xl px-6 py-12`.
- Page head = `text-display` title + optional `text-body` muted subtitle.
- **Page title** = the page's `h1` text, then " · Musubi" ("Discover ·
  Musubi"), set by `usePageTitle` (`src/lib/page-title.ts`); "Musubi" alone
  while the head is unknown. An organisation's page names the organisation
  once it loads and "Organisations" until then, as its `h1` does. The bare
  routes, `/authorize` and `/verify/:requestId`, keep the plain "Musubi" from
  `index.html`.
- Bare routes (`/authorize`, `/verify/:requestId`) = no shell; one centred
  column, `max-w-md px-6 py-10`, centred vertically in the viewport.
  `/verify/:requestId` sets the product name above its card, `gap-6` apart.

## Responsive layout

One breakpoint: **`md` (768px)**. Below it the app is a mobile shell; at and
above it, the desktop rail. Never introduce additional breakpoints without
amending this file. `tests/styles/one-breakpoint.test.ts` fails on any other
breakpoint in `src/`, naming the file and line: a variant (`sm:`, `lg:`,
`xl:`, `2xl:`, their `max-*:` forms, an arbitrary `min-[…]:` or `max-[…]:`)
in a `.ts`, `.tsx` or `.css` file, and an `@media`, `@custom-variant` or
`@variant` in a `.css` file at any width but 767px or 768px.

- **One shell at a time** — `Layout` (`App.tsx`) mounts either the rail or the
  mobile shell, chosen by an `md` media-query signal. The shell's dialogs —
  sign in, create account, switch profile — are mounted once, above that
  switch (`ShellDialogs.tsx`), so a dialog open when the window crosses 768px
  stays open, with what was typed in it. A control in either shell, or a page,
  opens one through `useShellDialogs()`.
- **Mobile shell** = `MobileTopBar` (wordmark · theme toggle · account
  control, in a 48px row, `--topbar-h` in `App.css`; every control 40px tall,
  the theme toggle a 40px square, `TOGGLE_BOX` in `ShellFrame.tsx`) above the
  scroll column + `MobileNav` (fixed bottom tab bar, the
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
  dialogs go through it; never mount a raw `DialogContent` in a screen. Below
  `md` the sheet is as wide as the screen. The card's cap at `md+` is the
  `width` prop: `"sm"`, 384px, the default, or `"xs"`, 320px, which the
  profile switcher takes. The component takes no `class`, `classList` or
  `style`: the sheet's rules sit behind `base:`, so a call-site `max-w-*` would
  cap the sheet too and pin a narrow sheet to a phone's left edge. A dialog's
  padding and layout go on the children it wraps. Every dialog has a name: a
  `DialogTitle` in a `DialogHeader`, or, where the view inside draws its own
  heading (`@osn/auth-ui`'s `SignIn` and `Register`), an `aria-label` on
  `ResponsiveDialogContent`.
- **A form dialog** (create and edit organisation) = `DialogHeader` ›
  `DialogTitle`, then the `<form>`: its fields in a body `div` padded 16px
  (`flex flex-col gap-4 p-4`), its actions in `DialogFooter` (16px padding, a
  hairline above, right-aligned; Cancel `secondary`, then the commit). The
  footer sits inside the form, so Enter in a field submits. A confirmation
  dialog has the same shape with its words in the body (`ConnectionsPage`'s
  remove dialog).
- **Touch targets** = ≥40px visual / 44px effective on mobile. The mechanism
  is `max-md:` call-site utilities (e.g. `h-7 max-md:h-10` on row actions,
  `max-md:min-h-11` on tabs); rows keep `hover:` classes and add matching
  `active:` classes for touch feedback. A full-width pill that is a page's
  one next step, such as Try again on a bare route's card (`/authorize`, the
  emailed-link page), draws it at `size="lg"` with `max-md:h-11`: 40px from
  `md`, 44px below it. The
  numbers that page offers to pick from are full-width `outline` Buttons 48px
  tall at every width (`h-12`), and its "I didn't ask for this" a full-width
  `ghost` `sm` Button, 44px below `md`. Tab rows scroll (`overflow-x-auto`)
  rather than wrap or shrink. Buttons keep these call-site heights: no
  `Button` size draws 40px at `sm`'s padding, and `default` would widen the
  top bar's pair past what 320px holds.
- **Text fields** take `Input`'s own sizes, with no height class: the rail's
  search is `md`, 36px. One exception: `/search`'s field keeps `h-11`, 44px
  at every width. `Input`'s `touch` size, the only one that tall, steps from
  46px to 44px at 640px, a width this file's one breakpoint does not use.
  Where the emailed-link confirm page asks for the number to be typed, its
  field is `Input` at `size="touch"`: 46px with 16px type below 640px, 44px
  above.
- **Code boxes** = `OtpInput`'s six boxes share their column and are 40px wide
  at a 260px column, so a screen that hosts one gives the row at least 260px
  on a phone (drop an inner card's padding below `md` rather than squeeze the
  boxes). `TotpView`'s enrolment step drops its frame below `md`, so in
  Settings → Security its code row takes the card's whole column. The
  step-up's code row is in its sheet, inside the sheet's 16px padding: 288px
  at a 320px viewport. Where the app does not follow this yet, at a 320px
  viewport:
  - Settings → Security: the card's column is 246px (37.7px boxes; 260px from
    a 334px viewport), after `main`'s `px-4` and the card's `p-5` and edge,
    for `TotpView`'s enrolment step (#2054).
- **Toasts** = top-center below `md`, one spacing step under the top bar
  (`--topbar-h` plus the notch inset), clear of the keyboard and the tab bar;
  bottom-right at `md+`.
- The bare routes, `/authorize` and `/verify/:requestId`, render with **no
  shell at any width**.

Every dialog `@osn/auth-ui`'s views open themselves is a sheet below `md`:
the step-up sheet, "Generate a new set?" and "Create a new profile".

## Empty states and failed loads

- **Loading** = `@shared/ui`'s `Skeleton`, one block in place of each row,
  card, line, field or button, in the loaded thing's corner (`standsFor`) and
  height in spacing steps, so nothing jumps when the content lands: a list
  row is `row`, a card `card`, a heading or a status line `line`. It fills
  with the sunk well (`--muted`), pulses in opacity, and stands still under
  reduced motion. Never a "Loading…" line and never a block drawn by hand.
  A row whose buttons grow to the touch height below `md` (§Responsive
  layout) is taller on a phone, so its placeholder is
  `src/components/ResponsiveSkeleton.tsx`: one block per width, each hidden
  at the other, since `Skeleton` takes one height. Rows: a connection or a
  member with Remove 56px and 60px below `md`, a Discover card 114px and
  126px, a connected app 62px and 66px; an organisation card is 74px at
  both. Settings' Security fallback stands for `@osn/auth-ui`'s passkey
  head, 32px and 40px below `md`, and one of its rows, 92px and 144px,
  copying the package's own placeholder, which it keeps internal; `/authorize`'s
  "Sign in instead" is 32px and 40px. A placeholder list takes the gap of the list it stands for. Words
  that do not load stay on screen: Connected apps' lead paragraph is the
  page's, outside the section's `Suspense`, so only its list is a
  placeholder. The region that holds the placeholders and the content that replaces them
  carries `aria-busy` while it loads; a `Suspense` fallback, which no element
  outlives, carries it on its own wrapper and takes it away with it
  (Settings' Security and Connected apps tabs, `/authorize`'s sign-in frame).
  `/authorize`'s takes the shape of the half of the panel that leads:
  sign-up's heading beside Cancel and its four fields for `reason=create`;
  sign-in's heading, one field, Continue, "Lost your passkey?" and the
  "Create one" line otherwise, at the page column's width. Words that wrap
  stay words there, so they wrap where the panel's do: the heading, and the
  date of birth's hint; labels, fields and buttons are blocks. Two browser
  tests hold every placeholder's height against what lands, at 320 and
  1440px, and `/authorize`'s at 390 too
  (`tests/components/LoadingShapes.browser.test.tsx`,
  `tests/components/AuthorizeLoading.browser.test.tsx`). A list a person
  acts on keeps its rows on screen while it is read again (Connected apps
  after a revoke, the passkey list after a delete), and a row that may be gone
  is not one anyone can act on: its action stays busy or disabled until the
  read lands. A state whose words are the content stays
  words: `/authorize`'s "Checking this request…" and "Taking you back…",
  search's "Searching…", and a busy button's label (§Busy buttons).
- **Empty states** = `EmptyNote` (`src/components/EmptyNote.tsx`): the dashed
  `rounded-card` block, 16px at the sides, `size="page"` (`py-16`) for a
  page's whole content, `size="section"` (`py-12`) for one list. Its words sit
  centred in an `<output>`, so a state that replaces a skeleton is read out.
  An optional `action` sits 16px under the words, outside the `<output>`, so
  what is read out is the message and not a button's name too. Never draw the
  block by hand.
- **A signed-out page** = `SignedOutNote` (`src/components/SignedOutNote.tsx`):
  the page's `EmptyNote`, whose words say what signing in gives, with one
  Sign in under them that opens the shell's sign-in dialog. It is `secondary`
  and `sm`, as the shell's own Sign in is, so the page never shows a second
  filled button beside the shell's Create account. Create account stays in
  the shell. Until the shell's dialogs have loaded the button is `invisible`
  — not painted, not focusable, out of the accessibility tree — so it never
  offers a dialog that cannot open, and the note keeps its height when they
  land (§Layout, a shell that fails to load).
- **A load that failed** for any reason the screen does not name is one
  line, `@shared/ui`'s `Notice` (`tone="danger"`, `size="inline"`, `alert`):
  the danger mark and the sentence at the body size, announced as it appears.
  Never the empty-state block, which means "nothing here". Where the screen
  offers no retry it ends "Reload and try again." (`ConnectedAppsSection`,
  `OrgDetailPage`). A screen whose head comes from what failed to load keeps
  its section's head above the line (`OrgDetailPage` falls back to
  "Organisations"). A shell that failed to load says so inside its frame
  (§Layout), the one failed-load line not drawn by `Notice`: a
  `text-destructive text-meta` line with `role="alert"` (`ShellFrame.tsx`),
  sized so the phone top bar's 48px row holds it at 320px.
- **A failed load with a retry** is the same line with a lead that names what
  did not load, then an underlined "Try again" that loads it again in place;
  the button is gone while the retry is out, so clicks never stack. The
  copy map's sentence (`describeAuthError`) follows the lead only when it
  adds something — a `429` says to wait, a lost connection to check it —
  never a "something went wrong, try again" beside the button. Uses: the
  profile list ("Your profiles didn't load.", `ShellNotices`), and the
  Security views' lists (§Auth surfaces).
- **On a bare route**, whose one card is what failed to load (`/authorize`,
  `/verify/:requestId`), the card offers its own Try again, so the line does
  not say "Reload". The card is `Card` at `padding="lg"`, left-aligned: its
  `h1`, then the line as an inline danger `Notice` with `alert`, the copy
  map's sentence (`describeAuthError`), then Try again, full width at
  `size="lg"` with `max-md:h-11`. On `/verify/:requestId`, Try again is busy
  ("Checking…") while the read runs, the card stays up, and the page's live
  region says the try and, when it fails again, the line.
- **A page that throws while it renders** shows "This page didn't load." with
  "Try again" in the content column, inside the shell: `PageErrorBoundary`
  wraps each route, so the rail, the tab bar and the account banners stay
  drawn and lead elsewhere. It resets on its own when the path changes, and
  never shows the error's text.

## Links

Two kinds, both `@shared/ui`'s `Button` `link` variant, in the accent ink
(`--ui-accent-ink`, which Musubi maps to `--primary`, the same value as
`--foreground`). Since the ink matches the words around it, a link is told
apart by its underline or by standing alone at 500.

- **A link inside a sentence** is `variant="link" size="inline"`: no box,
  underlined at rest 2px under the text, in the sentence's own size, line
  height and weight. An action that goes nowhere is the `Button`; a way to
  another address is an `<A>` or `<a>` wearing
  `buttonVariants({ variant: "link", size: "inline" })`. Uses:
  `/authorize`'s "No account yet? Create one" (a button: it swaps the panel to
  sign-up), Discover's empty note "Search for someone" (an `<A>`), and the
  contact address on `/privacy` ("email …") and `/terms`.
- **A link in a legal document's prose takes the inline treatment too**, even
  where it fills its paragraph alone, as the address under the Terms'
  "Contact" heading does. It is part of the text, not an action, and an ink
  link with no underline reads as plain words. The legal pages' words change
  only with the date at their top, so a link's look never rewrites them.
  `.prose-legal` sets no rule on `a`: the link classes decide the look, and
  since `Button`'s classes carry no specificity, a `.prose-legal a` rule would
  beat them without a warning. The `/privacy` and `/terms` surface checks read
  the address.
- **A link standing alone** is `variant="link" size="sm"`: 13px at 500 in a
  32px box with 12px sides, underlined only under the pointer. It sits centred
  under the action it follows (`self-center`), so no column edge sits 12px off
  its words. Uses: `@osn/auth-ui`'s "Lost your passkey?" under Continue.
- **The action that ends an error line is neither.** It keeps the line's ink
  and is underlined at rest: `@osn/auth-ui`'s `InlineAction`, and "Try again"
  in `ShellNotices` and `PageErrorBoundary`. `link` would paint it the accent
  ink, and a call site may not recolour a `Button` (`shadcn/no-restyle`).

## Busy buttons

A button that starts a wait shows it: `Button`'s `busy`, in place of
`disabled`, with a label that names the wait and ends in "…" ("Creating…",
never "Creating..."). While busy it keeps focus, is announced busy and
unavailable (`aria-busy`, `aria-disabled`), refuses a press and the Enter that
would submit its form, dims to 50% except under keyboard focus, and draws the
orb (§The orb).

- **Only the button that started the wait.** Every other action in the same
  form or dialog is `disabled` while it runs, its Cancel, Back and links among
  them, so nothing leaves it mid-call: the organisation dialogs' Cancel while
  Create or Save runs, and `@osn/auth-ui`'s sign-up Cancel while its link is
  sent or resent. A row's action leaves the other rows alone.
- **The other reasons stay in `disabled`, and apply only while idle**
  (`disabled={!busy() && …}`). `disabled` wins over `busy` and drops focus to
  the page, so a reason that turns true mid-wait — the verification challenge
  dropping a spent token — would take focus away.
- **The handler checks too.** Each one returns early while its own wait runs,
  so no second request goes out whatever reaches it.
- **Not for a wait the button did not start.** Settings → Security's
  "Checking…", while the recovery-code status first loads, stays `disabled`.
- **As it stands.** `/authorize`'s Allow and Cancel are still `disabled` for
  their wait, with no working label, until its consent screens are finished
  (#2048).

Uses in the app: the create-organisation dialog's Create ("Creating…"), the
edit dialog's Save ("Saving…"), Discover's Connect ("Sending…"), Connected
apps' Revoke ("Revoking…"), `/search`'s Connect ("Sending…") and Accept
("Accepting…"), and Try again on a bare route's failed card ("Checking…"). The
rail's results panel shows the same words as text, since
a listbox option holds no button (`SearchResultRows.tsx`). The auth views' are
in `osn/auth-ui/DESIGN.md` §6.

## Form fields

A form field is `@shared/ui`'s `Field` with `labelTreatment="plain"`: `Label`'s
default look (the control step, 14px, at 500, full ink, the words as written)
6px above the control, then a hint at `text-meta`'s 12px in the secondary ink.
`Field` mints the control's id and names the hint in its `aria-describedby`.

- **An error about what was typed** goes in `Field`'s `errors`, announced and
  turning the edge red. No app form passes one today: the organisation dialogs
  report a refused save in a toast. The auth views draw their own `Notice` line
  and tie it to the field themselves (`osn/auth-ui/DESIGN.md` §7).
- **What stays a bare `Label`.** A field with an `InfoPopover` beside its
  label, since a label cannot hold a button (`@osn/auth-ui`'s Register Email),
  wired by hand and 6px above its control all the same; and the label of a
  label/value pair (Settings' Profile and Account cards, a muted `sm` `Label`
  over a disabled value). The code boxes (`OtpInput`) take a span in the label's
  look 6px above them, its id the boxes' `aria-labelledby`: `Field`'s
  `<label for>` names one control, and the boxes are a group
  (`osn/auth-ui/DESIGN.md` §4).

Uses in the app: the create-organisation dialog (Handle, with its hint; Name;
Description) and the edit dialog (Name, Description); in the auth views, every
form field but those above.

## Auth surfaces

Sign-in, registration, step-up and the Security settings are `@osn/auth-ui`
views. `osn/auth-ui/DESIGN.md` governs them; this section says how Musubi
hosts them.

**How they render here.** `@shared/design-tokens/tokens.css`, which `App.css`
imports, carries the `@source` for `osn/auth-ui/src`, so the views' classes
compile in this app. The views write only the `ui-*` contract, which the
contract block in `App.css` maps onto this file's scale (§Token contract): a
panel heading is `text-title` at 500, body lines `text-body` in the secondary
ink, meta lines `text-meta`, names in a row 14px at 500. Their form fields,
links and busy buttons follow this file too: §Form fields, §Links and §Busy
buttons. A view's title in a dialog is the dialog's `DialogTitle`, so the
sign-in and create-account dialogs are named "Sign in to Musubi" and
"Create your Musubi account" by the view; `ResponsiveDialogContent` takes no
`aria-label` there.

Every control the views draw by hand takes Button's focus ring, not the base
outline (§Focus). Every text field in the views is `@shared/ui`'s `Input` (or
`UsernameInput`), so each draws `Input`'s `--input` edge.

**Where each view mounts:**

| View | Where | Host file |
| --- | --- | --- |
| `SignIn`, `Register` | The sign-in and create-account dialogs: a sheet as wide as the screen below `md`, a centred card capped at 384px above | `components/AuthDialogs.tsx`, mounted once above the shell switch by `ShellDialogs.tsx` |
| `SignIn`, `Register` | `/authorize`, unframed (`host="page"`), 24px under the client card, at the column's width with no side padding; "No account yet? Create one" sits 24px under `SignIn` and swaps to `Register`, whose Cancel reads "Sign in instead". While the panel's code loads, its placeholder takes the same shape (`SignInLoading`) | `components/AuthorizeSignIn.tsx`, in `pages/AuthorizePage.tsx` |
| `CheckEmailView` | Inside `Register` once its link is sent, and inside `RecoveryLoginForm` once a recovery link is | — |
| `ConfirmLinkPage` | `/verify/:requestId`, a bare route with no app shell: the wordmark above the card, in `AuthorizePage`'s `<main>` column. A sign-up link's page offers the numbers to pick; a recovery link's asks for the number typed (`typeNumber`). Its expired card also answers a link whose id names no flow | `pages/VerifyEmailLinkPage.tsx` |
| `RecoveryLoginForm` | Inside `SignIn`, from "Lost your passkey?" | — |
| `TurnstileWidget` | Inside `SignIn`, `Register` and `RecoveryLoginForm`'s emailed-link step, when a site key is set | — |
| `PasskeysView`, `TotpView`, `RecoveryCodesView` | Settings → Security, in that order, inside Settings' card, so their rows are nested 8px cards; the last under the app's own "Recovery codes" heading, `text-title` at 500 over a `text-body` intro, as the panels' own headings read. While the section's code loads, `SecurityLoading` draws the passkeys' head and one row, a block for each width as the view's own placeholder does | `components/SecuritySection.tsx` (lazy), in `pages/SettingsPage.tsx` |
| `SecurityEventsBanner` | The account banner stack, above every signed-in page | `components/SecurityEventsBannerMount.tsx`, via `AccountBannerStack.tsx` |
| `ProfileOnboarding` | Settings, above the tabs, dismissible; its dialog holds `CreateProfileForm` | `pages/SettingsPage.tsx` |
| `StepUpDialog` | A sheet over the view that opened it — `PasskeysView`, `TotpView`, `RecoveryCodesView` or `SecurityEventsBanner` — when an action needs it: as wide as the screen below `md`, a centred card capped at 384px above, as Musubi's dialogs are by default | — |

**When the session ends.** The runtime ends a session when the issuer refuses
to renew it, and when another tab signs out or signs in to another account.
The shell then shows "You've been signed out." with a Sign in button, above
the account banners: `Notice`, `tone="info"`, `size="sm"`, `alert`, at the
banners' width (`ShellNotices`). One notice however many requests failed,
cleared by the next session. A log out in this tab and a cold load with no
session show none: the runtime reports no end for either. So a person who
logs out in one tab sees the notice in every other open tab, which is true.

The notice's Sign in opens the shell's sign-in dialog through
`useShellDialogs()`, as the shells' own buttons do (§Responsive layout).

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
  | `--ui-text-md` | `--text-title`, 14px |
  | `--ui-text-lg` | 20px |
  | `--ui-text-xl` | `--text-display`, 24px |
  | `--ui-text-2xl` | 32px |

- **Tracking.** `--ui-tracking-tight` and `-normal` are `-0.15px`; `-wide` is
  `0em`, which the rail's small-caps "Social" tag uses.
- **Weight.** `--ui-weight-title` is 500, the weight `DialogTitle` and
  `CardTitle` read (§Typography, Dialog and card titles).
- **Elevation and scrim.** Musubi maps neither `--ui-elev-2` nor `--ui-scrim`,
  so a dialog casts the contract's `0 8px 24px rgb(0 0 0 / 0.12)` over the
  contract's scrim, black at 50% (`wiki/shared/design-tokens.md` §The tokens).
- **Motion.** `--ui-scale-enter` and `--ui-scale-exit` are 1: overlays fade
  with no scale (§Motion). Durations and easings are the contract's own;
  Musubi maps none.
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

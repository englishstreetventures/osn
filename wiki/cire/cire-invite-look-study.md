---
title: Cire invite look — competitor study and open questions
description: How a leading digital-invite service builds its invites and envelope, where cire's guest site falls short of it, and the questions each exploration issue has to answer before any build starts
tags: [investigation, web, ios, design, cire]
related:
  - "[[cire-envelope]]"
  - "[[cire-invite-designs]]"
  - "[[cire-invite-builder]]"
  - "[[cire-entitlements]]"
  - "[[cire-landing]]"
  - "[[frontend-patterns]]"
last-reviewed: 2026-11-17
---

# Cire invite look: competitor study and open questions

An investigation page, not a system page. No work has started. It records what
we found studying [The Digital Yes](https://www.thedigitalyes.com) and lists
the questions that the exploration issues under epic #2308 have to answer.
Each issue writes its findings back here. When a question is settled, the
answer moves to the system page it belongs to ([[cire-envelope]],
[[cire-invite-designs]]) and its row here links there.

## Why this page exists

The Digital Yes sells hand-personalised digital wedding invites. Their invites
and envelope look better than ours, and their marketing site is cleaner. Our
software is stronger: cire is self-serve, the invite is live the moment the
couple saves it, and the envelope opens onto the couple's own hero. The goal is
to keep that advantage and close the gap in looks, on every platform a guest
might use.

## What they build

*Observed 2026-11-16 — their home page and the Romantic and Lace demos at
375×812 in the desktop app's browser, with assets listed from `document.images`,
`video` and `source` elements and computed `background-image` values.*

| Area | What we saw |
|---|---|
| Business | A service. Three tiers, A$299 (a design with your details), A$999 (redesigned around your wedding), A$1,699 (from scratch). 7–14 days to make, 1–4 days for a fee. 36 invite designs, 16 save-the-dates, 278 reviews. Up to three languages. Gift cards and save-the-dates sold as extras |
| Build | Each design is its own [Lovable](https://lovable.dev) app on its own subdomain (`romantictemplate.thedigitalyes.com`, `plantillalace.thedigitalyes.com`). Page metadata names Lovable as author. Each couple's invite is most likely a hand-edited copy, not one shared engine |
| Envelope | A video, not a 3D scene. The cover is a still image (`sobre-portada-v8.jpg`); a tap plays `sobre-apertura-v8.mp4`. The Romantic design opens carved double doors; Lace opens a lace-and-pearl envelope. Because it is plain video it plays on every phone, iPhone Safari included |
| Art | Stacked transparent PNGs, many exactly 1024×1536 (the native size of OpenAI's image model), with names such as `cinta-palomas-nofondo` ("no background"). Each design keeps to one material: embroidery, embossed paper, satin, lace or mother of pearl |
| Motion | Falling petal sprites, a looping hero video, music, a countdown printed on a paper card, scratch-to-reveal |
| Weak point | The couple's monogram is part of the rendered seal image, so every couple's change is redone by hand. That is why it takes days |
| Marketing site | A live demo inside a phone frame, "tap a name to see its envelope", three clear price tiers, WhatsApp sharing |

Their price rests on the feeling of a bespoke piece. We can give that feeling
without the labour: the couple's monogram in the wax and their names on the
card as it rises, live in the organiser's preview.

## Where we stand

| Area | Cire today | Gap |
|---|---|---|
| Envelope surfaces | Drawn into 2D canvases in [`paint.ts`](../../cire/envelope/src/scene/paint.ts): ivory fill, a seeded 128-texel grain tile, a hatched liner in the couple's palette. Laid on flat planes in Three.js ([[cire-envelope#Look]]) | Reads as graphics, not paper. No depth, no fibre, no light on the surface |
| Seal | A placeholder: crimson disc with a "C" die, built in [`seal/index.ts`](../../cire/envelope/src/seal/index.ts). A designed seal is #1918; tier artwork is #1303 | Looks like a stand-in |
| Who sees it | Only where the HTML-in-Canvas API exists. Today that is Chrome, through an origin trial that runs to Chrome 160 ([[cire-envelope#Who sees it]]) | No iPhone guest sees the envelope. Android in-app browsers are untested |
| Personalisation | The card is the couple's live hero, drawn into the scene, and the break differs on each visit | Ours is ahead here; nothing to close |
| Guest site and portal | Our own design system, one `DESIGN.md` per surface | Their pages look cleaner. Audited side by side under question 5 |

The iPhone gap is not a 3D gap. Safari runs WebGL2, and Safari 26 added
WebGPU. What it lacks is the API that copies the live hero into the scene.

## Questions to answer

| # | Question | Issue | Answer |
|---|---|---|---|
| 1 | What do guests see where HTML-in-Canvas is missing: a still card drawn into the same scene, a pre-rendered video, or nothing? Which Android in-app browsers (WhatsApp, Instagram) load the origin trial? | #2309 | Open |
| 2 | Which AI image and video models give us photographic paper, liner, lace and wax, and how do they enter the scene: textures with normal maps, a 3D seal model, or video? | #2310 | Open |
| 3 | Can an App Clip open a cire invite from a link in WhatsApp or Messages, which app would it ship inside, and is it worth the cost? | #2311 | Open |
| 4 | When a guest has the Pulse iOS app, should it show the invite natively (RealityKit envelope) or in a web view? | #2312 | Open |
| 5 | Where do the guest site and the organiser portal look less clean than theirs, item by item? | #2313 | Organiser portal: [[#Findings: organiser portal]]. Guest site: [[#Findings: guest site]] |

## Findings: organiser portal

*Observed 2026-11-17 — ours live on the dev tier (`host.cire.esv.tools`,
seeded wedding) in Chrome, light theme, measured with `getComputedStyle`:
Overview at 1456px, Guests at 1224px, the widths the window would take. The
phone items (4, 10) were not re-checked live: the portal refuses to be framed
and the window would not narrow, so they rest on the E2E run on `main` of
2026-11-05 (`e2e-artifacts/hollow-page/img/after/overview-phone-390-loaded-light.png`).
Theirs from the portal mock-ups on their home page, observed 2026-11-16. Their
real portal is behind a purchase, so the comparison is with what they choose to
show.*

**How their cards are built.** A light card (`#fbf7f2`) on a tinted ground
(`#efe7dd`), set apart by a soft shadow (`0 30px 60px` at 22% opacity), not a
border. 20px padding, 22px corners. Each card is titled in a serif at 17–19px,
sentence case, with no small-caps label. Rows are 14px body text split by
hairlines, with 9px above and below. Each card holds three to five things and is
as tall as its content.

**Where ours loses space or reads busier.** "Settled" means the host
`DESIGN.md` already gives the answer; "Decision" means it needs the owner,
because the `DESIGN.md` holds a different choice or none.

| # | Where | What we see | Proposed fix | Kind |
|---|---|---|---|---|
| 1 | Overview, desktop | `auto-grid` stretches each row to its tallest card. Under What's next, Countdown, RSVP changes and Guests & events are 326px tall beside RSVPs, with 173–192px empty under their content. In the next row Vendors holds one line and the fourth slot is empty | Size each card to its content (`align-items: start`), or lift the small cards into one compact strip of figures above the grid | Decision |
| 2 | Overview, page head | "Overview", then "Your wedding at a glance", then the gilt rule: 120px from the top bar to the first card. The line under the heading tells the reader nothing new | Drop the line (§3, "A line earns its place") | Settled |
| 3 | Rail | The collapse toggle and its divider sit at the top, so the first link (y = 156) sits below the page title (y = 105). Upper-case tracked labels widen the rail to 224px; content starts at x = 308 of 1456 | Move the toggle to the rail's foot; set links in sentence case at `text-ui-sm` for a narrower rail | Decision |
| 4 | Overview, phone | The module switcher reads "Overview" and the heading under it says "Overview" again: about 120px before content | Keep one of the two | Decision |
| 5 | Every card | Eight gold small-caps labels on one screen, each card's only title | A serif title in sentence case at `text-ui-lg` for a card that stands alone, keeping `Eyebrow` for groups inside a card | Decision (§7 makes every card's label an `Eyebrow`) |
| 6 | Overview and Guests figures | Dates and counts in the platform monospace ("10 Nov", "24 attending") read as a terminal beside a serif brand | Body face with `tabular-nums`, which keeps the columns aligned | Decision (§3 chooses `font-ui-mono` for these) |
| 7 | Overview, RSVPs card | "200 attending" repeats on five rows and wraps under a long event name (`Overview.tsx:626`: the count has no `shrink-0` or `whitespace-nowrap`) | Say "Attending" once as the column's head and keep each count on one line | Settled |
| 8 | Every card | A card is the page ground under a 30% wash of a colour about 0.04 lighter, so card and page differ by about 0.01 in lightness and eight hairline boxes carry the layout | Widen the step between `--surface` and the page ground, as §2 already says a card is told apart "by its surface, not by its edge" | Decision (colour values) |
| 9 | Overview, What's next | "OVERDUE" six times in red capitals across twelve rows, beside a red-free date column | Group the overdue rows under one "Overdue" head, or mark the date itself in `text-error` and drop the word | Decision |
| 10 | Overview, phone | "Sangeet night and welcome dinner" runs into the card's right padding in the 2026-11-05 shot. The label has `truncate`, which sets `overflow: hidden` and so should clip; today's dev seed has no event that long, so it was not reproduced | Re-check at 390px with a long event name; give the row's grid column `min-w-0` if it still overflows | Settled (a bug, unconfirmed) |
| 11 | Guests, RSVPs | Two rows of pill groups, then a summary line that repeats the chips' counts ("Attending 24" in a chip and again below it) | Drop the summary line or the counts in the chips | Decision |
| 12 | Guests, RSVPs table | An "Edit" button on every row | Open the row on a click and show one Edit on hover or focus | Decision |
| 13 | Overview, Budget card | "Next: Balance · due 2026-10-25" prints the raw ISO date (`Overview.tsx:884`), while What's next says "25 Oct" and Countdown "Wednesday 25 November 2026" | Format it as the agenda does (`fmtAgendaDate`) | Settled (a bug) |

**What already works.** The palette, the large RSVP figure with its bar, the
table's row rhythm (about 53px) and the top bar's actions hold up next to
theirs.

## Findings: guest site

*Observed 2026-11-16 in Chrome, measured with `getComputedStyle`. Theirs: the
Romantic demo (`romantictemplate.thedigitalyes.com`) in a same-origin
375×812 frame, doors opened. Ours: `invite.cire.esv.tools/cire-wedding` on the
dev tier, unlocked with the seed's smoke-test code (`TESTFOR-JOY-DD44`),
privacy choices set to "Reject all". Our site refuses to be framed
(`frame-ancestors`), so ours is at 570×763, Chrome's narrowest window; every
`md:` rule is off below 768px, so it is the phone layout, 195px wider.*

**How theirs is built.** About 14,100px in 14 sections, each a screen or more
tall, one idea per section. Every section sits on the same textured paper and
opens with art (embossed flowers, a music box, a watercolour bouquet), then a
display serif heading at 36–48px, then a carved paper card that holds the
content: the countdown, the event, the RSVP form. Body text is Cormorant
Garamond at 14–16px in one muted green; labels are 10–11px tracked capitals.
Sections have 24px side padding and 56–96px above. Content fades in as it
scrolls into view.

**How ours is built.** 6,605px in eight blocks. Sections alternate three flat
grey-blue tones (`oklch(0.942–0.992 0.002–0.004 250)`), none with texture or
art. Headings are Cormorant Garamond at 36.8px; body is Lato light at 14.4px;
sections have 64px above and below and 24px at the sides. Fourteen boxes
taller than 60px carry a border.

| # | Where | What we see | Proposed fix | Kind |
|---|---|---|---|---|
| 1 | Event cards | Each of the five cards ends in an empty bordered box 320px tall. The event image it frames returns 404 (`/api/invite/cire-wedding/event/<id>/image`), and the frame stays. Five of these make the events section 3,323px | Drop the frame when the image fails to load. Separately, make the dev seed's image keys point at objects that exist | Settled (a bug) |
| 2 | Closing band, above "No boxed gifts…" | The same fault: an empty 321px band, because `/api/invite/cire-wedding/image/footer` returns 404 | As item 1 (`InviteClosing.tsx`, the narrow-crop `div`) | Settled (a bug) |
| 3 | Hero | With no couple photo, the hero is the names in a faint box on a pale gradient, a whole screen with nothing else in it. Theirs is never without art | Give each design pack its own hero art for a couple with no photo | Decision (needs art; see #2310) |
| 4 | Every section | Three flat tones in turn, one hue, no texture: the page reads as an app's settings screen, not paper | One paper ground for the whole invite with texture, and sections set apart by space and ornament, not by a change of tone | Decision (§2 says a section sits on a tone) |
| 5 | Welcome panel and events | "RSVPs closed" three ways: a bordered notice in the welcome panel, a second notice at the head of the events, and a chip on each of the five cards | Say it once, in the welcome panel; drop the chips when every event is closed | Decision |
| 6 | Event cards | A grey bordered card on a near-grey section, with a full-width "Event details" pill on every card | One event per card on the paper ground, with the details on a tap of the card itself, as the RSVP table in the portal proposes (portal item 12) | Decision |
| 7 | Body text | Lato light in a cool grey beside a Cormorant heading. Theirs sets body and heading in serif faces | Try Cormorant or a book serif for body text at 16px | Decision (§3 chooses Lato for body) |
| 8 | Envelope screen | The envelope floats on a flat grey-blue ground, with "Open your invitation" in 11px tracked capitals below it. Theirs fills the screen with the doors | Covered by #2309 and #2310 | — |

**What already works.** The hero title's type, the story's line length, the
FAQ's hairline accordion and the registry's single pill hold up next to
theirs, and the page is half the length of theirs without losing anything a
guest needs.

## Starting points

These are leads for the issues above, not decisions.

**AI models.** Names and prices come from vendor and aggregator blogs that
disagree with each other; check each provider's pricing page first.

| Need | Lead |
|---|---|
| Stills and transparent layers | GPT Image 2 (OpenAI) for quality; Nano Banana 2 (Gemini API) for cheap variants and keeping a design family consistent across reference images; FLUX.2 for open weights and a style adapter trained on our own approved art |
| An opening on video | Kling or Veo 3.1, both of which take a first and last frame, so the clip runs between two of our own stills. Seedance is the cheapest |
| 3D props such as a seal or music box | Hunyuan3D for texture quality; Tripo or Meshy for GLB files with PBR maps |
| Modelling by an agent | Blender driven through an MCP server can build the envelope's shape, folds and seal, then export glTF to Three.js or render frames. Art direction still comes from the images |

*Unverified — vendor figures, 2026-11-16: about $0.04–0.07 a still, $0.14–0.40
a second of video, $0.10–0.50 a 3D model. A design pack of about 20 stills and
three 8-second clips would cost $5–15 to generate, before retries.*

**App Clips.** An App Clip ships inside a full App Store app, so cire needs a
parent app or a home inside the Pulse app, and the clip's card shows that app's
name. Third-party sources give a 100 MB limit for clips opened only from links
on iOS 17 and later, but an Apple forum thread still cites 15 MB; check App
Store Connect's current limits. Messages shows a rich App Clip card for a
registered link. Nothing we found says what happens to a link tapped in
WhatsApp, which opens its own browser.

**Pulse iOS.** [`pulse/ios`](../../pulse/ios) is a shell (`Sources/App.swift`
and `project.yml`). A web view there runs WebKit, so it lacks HTML-in-Canvas
like Safari does. A native envelope means a second renderer kept in step with
`@cire/envelope`.

## Sources

- [Turing Post: AI image generators in 2026](https://www.turingpost.com/p/11-options-for-image-generation)
- [Teamday: best AI image models, November 2026](https://www.teamday.ai/blog/best-ai-image-models-2026)
- [OpenRouter: image-to-video models compared](https://openrouter.ai/blog/insights/image-to-video-models-compared/)
- [fal.ai: best image-to-video APIs 2026](https://fal.ai/learn/tools/best-image-to-video-apis-2026)
- [3D AI Studio: state of AI 3D generation 2026](https://3daistudio.com/state-of-ai-3d-generation-2026)
- [App Clip size and invocation notes (swift-ios-skills)](https://tessl.io/registry/dpearson2699/swift-ios-skills/files/skills/app-clips/references/size-capabilities-and-promotion.md)
- [Apple Developer Forums: App Clip size thread](https://developer.apple.com/forums/activities/1607080)

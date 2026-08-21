# @tools/lab

A scratchpad for building a component before it has anywhere to live. Storybook's
shape — a sidebar of stories, a live preview, an args panel — in about 600 lines,
built on the stack this repo already uses (Vite, Solid, Tailwind v4) so there is
no second toolchain to keep alive.

```bash
bun run dev:lab          # https://lab.localhost
```

Like every other dev server in the repo the lab runs behind portless, so its URL
is a name rather than a port, and a worktree on a branch gets its own
(`https://my-branch.lab.localhost`). `PORTLESS=0 bun run dev:lab` puts it back on
`http://localhost:4400`. See [devloop URLs](../../wiki/conventions/devloop-urls.md).

Nothing here ships. It is a dev tool.

## The catalogue

Open **`osn/ui` → Everything** for every component `@osn/ui` exports on one
page, each with the import path to copy. That is the "what do we already have"
view. For a component's full range of variants and states, open its own group:

| Group             | Covers                                                                   |
| ----------------- | ------------------------------------------------------------------------ |
| `osn/ui`          | Everything, one state each                                               |
| `osn/ui/Button`   | All variants, all sizes, live playground                                 |
| `osn/ui/display`  | Badge, Avatar, Card                                                      |
| `osn/ui/forms`    | Input, Label, Textarea, Checkbox, RadioGroup, UsernameInput, OtpInput    |
| `osn/ui/overlays` | Dialog, DropdownMenu, Popover, Tabs                                      |
| `pulse/Icon`      | The Pulse glyph set, every icon at every size                            |
| `shared/toast`    | Tones, positions, stacking, actions/promises, overflow                   |
| `shared/sortable` | Drag feel, the shift/settle animation, grip hover/focus, multi-container |

The last two are benches for behaviour no test tier can see. `@shared/toast`'s
suite asserts the queue and the DOM contract; `@shared/sortable`'s asserts drop
semantics against stubbed geometry, because happy-dom computes no layout. Neither
can tell you whether a drag tracks the pointer, whether the rows shift aside to
preview the drop, or whether a toast is legible on the surface it lands on. The
lab's **light · dark** toggle matters for the toast in particular — it borrows
`@osn/social`'s stylesheet, which is what maps the shadcn ramp onto the
`--toast-*` contract, so the toggle re-themes toasts exactly as the app does.

App-level components (`pulse/web/src/components`, `cire/invites`,
`osn/social`) are not catalogued: they read from an API client, a router and an
auth session, and standing those up means fixtures the repo deliberately keeps
out of app source. A story for one of them belongs next to it, supplying real
context — `pulse/web/src/components/Icon.story.tsx` is the pattern, and it is
catalogued precisely because it needs none.

## Writing a story

Any file named `*.story.tsx` is picked up. The shortest one is a component:

```tsx
// tools/lab/src/stories/thing.story.tsx
export const Thing = () => <div class="rounded-xl bg-primary p-8">Hello</div>;
```

Save it and it appears in the sidebar. Every export except `meta` is read as a
story, so a helper exported from a story file will show up as one — keep helpers
unexported.

For live controls, export a `Story` object instead. Each key in `args` becomes an
input in the right-hand panel, with the editor inferred from the initial value —
`true` gives a checkbox, `12` a number box, `"#7c5cff"` a colour picker, a long
string a textarea. `controls` overrides the guess:

```tsx
import type { Story, StoryArgs } from "../lab/types.ts";

interface Args extends StoryArgs {
  label: string;
  tone: "quiet" | "loud";
  radius: number;
}

export const Playground: Story<Args> = {
  args: { label: "Continue", tone: "quiet", radius: 8 },
  controls: {
    tone: { kind: "select", options: ["quiet", "loud"] },
    radius: { kind: "range", min: 0, max: 32 },
  },
  render: (args) => <button style={{ "border-radius": `${args.radius}px` }}>{args.label}</button>,
};
```

`args` values are `string | number | boolean` — exactly what a control can edit.
Anything richer (a callback, a fixture) belongs in the story's own closure.

Optional per-file defaults:

```tsx
export const meta = { title: "osn/ui/Button", layout: "centered" as const };
```

`layout` is `centered` (default), `padded` (top-left, for layout work) or
`fullscreen` (no padding, for canvases). Without `title`, the sidebar name comes
from the file path.

## Where stories live

Two homes, both auto-discovered:

- `tools/lab/src/stories/**` — spikes, throwaways, anything with no home yet.
- next to a real component, anywhere in `osn/*`, `pulse/*`, `cire/*`, `zap/*` or
  `shared/*` under `src/` — for a component that exists and wants a permanent
  bench.

Adding a new workspace root means adding a line to the glob list in
`src/lab/registry.ts`; Vite resolves `import.meta.glob` at build time and cannot
see through a variable.

A co-located story is loaded by the lab and by nothing else — no app imports it,
so it never reaches a bundle. Keep it free of lab imports (a bare component
export needs none) and it stays a plain file in its own package, typechecked and
linted there like any other.

## Chrome

- **backdrop** — app / paper / ink / grid / checker. Transparency is invisible
  until something is behind it.
- **viewport** — full / phone (390) / tablet (768) / laptop (1280).
- **light · dark** — toggles `.dark`, the same class the apps use.
- **remount** — tears the story down and rebuilds it. What you want after
  editing a canvas that holds a WebGL context.
- **open** — the story on its own at `?bare`, no chrome. Also what to point a
  screenshot tool at. `?theme=dark` forces a theme, since a screenshot tool
  cannot click the toggle.
- Arrow keys step through the list. The selected story is in the URL fragment,
  so a reload keeps its place and the link can be pasted into a PR.

## three.js and canvas

`src/lab/three.tsx` carries the boilerplate that otherwise gets rewritten badly
in every spike: sizing to the parent, device-pixel ratio, a frame loop, and a
teardown that actually frees the GPU memory.

```tsx
import { ThreeCanvas } from "../lab/three.tsx";

export const Scene = () => (
  <ThreeCanvas
    setup={({ scene, camera, onFrame, onDispose }) => {
      // build once…
      onFrame(({ delta, elapsed }) => {
        // …drive per frame
      });
      onDispose(() => {
        // anything the teardown walk cannot reach from the scene
      });
    }}
  />
);
```

To drive the scene from args, build the objects once and push each arg with its
own `createEffect` — nothing is rebuilt, so dragging a slider stays smooth. See
`src/stories/three-cube.story.tsx`.

`Canvas2D` is the same deal for a plain 2D context, with the transform
pre-scaled so you work in CSS pixels.

### HTML in canvas

Three routes, one per story in `src/stories/html-in-canvas.story.tsx`:

| Want                                     | Use                     | Cost                                                                                                               |
| ---------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| DOM-authored artwork, canvas compositing | `htmlToCanvas`          | It is pixels. No interaction.                                                                                      |
| The same artwork in a 3D scene           | `htmlToTexture`         | Lights and depth-sorts; still pixels.                                                                              |
| Live, clickable DOM in 3D                | `css3d` + `CSS3DObject` | Real hit-testing, but it composites _over_ the WebGL layer — geometry cannot occlude it, and it takes no lighting. |

The first two rasterise through an SVG `foreignObject`, which has two limits
worth knowing before you blame the helper:

- **Nothing external loads.** No web fonts, no remote images, no stylesheet from
  the page. Inline it or embed it as a `data:` URI.
- **The markup is parsed as XML.** Every tag closed, every attribute quoted. One
  stray `<br>` kills the whole image.

The CSS3D story sets `innerHTML` from a template string, and the args panel
feeds that string — so anyone can type markup into a control and have it run.
That is fine here and only here: it is your own browser, on a dev-only origin
with no session and nothing worth stealing in storage, and none of it ships. Do
not copy the pattern into app code.

## Styling

`src/lab.css` imports `osn/social/src/App.css` wholesale rather than keeping its
own copy of the design tokens. That file defines `--background`, the `.dark`
block and the `base:` variant that every `@osn/ui` class is written against, so
importing it is what makes those components render here exactly as they render
in the app. A second copy would drift within a week.

A story with its own design language (a cire invite, say) should import its own
CSS at the top of the story file.

## Limits

Stories render in the same document as the lab chrome — no iframe. That keeps
hot reload instant and the code small, at the cost of isolation: a story that
sets global CSS or grabs `document.body` will affect the chrome around it. Use
`?bare` when that matters.

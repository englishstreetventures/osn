---
title: Component Library (Zaidan)
aliases:
  - zaidan
  - shadcn
  - UI components
  - design system
tags:
  - architecture
  - frontend
  - solidjs
  - tailwind
  - design-system
status: current
related:
  - "[[frontend-patterns]]"
  - "[[monorepo-structure]]"
  - "[[testing-patterns]]"
  - "[[pulse]]"
packages:
  - "@osn/ui"
  - "@pulse/app"
last-reviewed: 2026-04-14
---

# Component Library (Zaidan)

OSN uses **Zaidan**-style components — the SolidJS equivalent of shadcn/ui. Components are copy-pasted source files (not imported from `node_modules`) backed by **Kobalte** headless primitives and styled with **Tailwind CSS** + **CVA** (class-variance-authority).

## Why Zaidan / shadcn-style?

- **Owned source** — components live in the repo, not behind a version pin. Customise freely without forking a library.
- **Kobalte underneath** — headless primitives give proper ARIA semantics, focus trapping, portal rendering, and keyboard navigation for free.
- **CVA variants** — type-safe variant props (`variant="secondary"`, `size="sm"`) with consistent class composition.
- **Tailwind-native** — uses the same CSS variable theme the app already defines, no separate token system.

## Where Components Live

All shared UI primitives live in `@osn/ui`:

```
osn/ui/src/
├── lib/
│   └── utils.ts              ← bx(), clsx re-export, cn() (fallback)
├── components/
│   └── ui/
│       ├── avatar.tsx         ← Avatar, AvatarImage, AvatarFallback
│       ├── badge.tsx          ← Badge (variant-based)
│       ├── button.tsx         ← Button + buttonVariants (CVA)
│       ├── card.tsx           ← Card, CardHeader, CardTitle, etc.
│       ├── checkbox.tsx       ← Checkbox (Kobalte)
│       ├── dialog.tsx         ← Dialog, DialogContent, etc. (Kobalte)
│       ├── input.tsx          ← Input
│       ├── label.tsx          ← Label
│       ├── popover.tsx        ← Popover, PopoverTrigger, etc. (Kobalte)
│       ├── radio-group.tsx    ← RadioGroup, RadioGroupItem (Kobalte)
│       ├── tabs.tsx           ← Tabs, TabsList, TabsTrigger (Kobalte)
│       └── textarea.tsx       ← Textarea
└── auth/
    ├── Register.tsx           ← uses Button, Input, Label
    └── SignIn.tsx             ← uses Button, Input, Label, clsx()
```

Consuming apps import via subpath exports:

```typescript
import { Button } from "@osn/ui/ui/button";
import { Card } from "@osn/ui/ui/card";
import { clsx } from "@osn/ui/lib/utils";  // for conditional class joining
import { cn } from "@osn/ui/lib/utils";     // only if you need Tailwind conflict resolution
```

## Dependency Stack

| Package | Role |
|---------|------|
| `@kobalte/core` | Headless UI primitives (Dialog, Popover, Tabs, RadioGroup, Checkbox) |
| `class-variance-authority` | Type-safe variant definitions for Button, Badge |
| `clsx` | Conditional class string joining |
| `tailwind-merge` | Tailwind class conflict resolution (used only via `cn()` fallback) |

These are dependencies of `@osn/ui`. Consuming apps get them transitively — no extra installs needed.

## Class Composition: `bx()`, `clsx()`, and `cn()`

Three utilities handle class composition at different levels:

### `bx()` — component defaults (zero-specificity via CSS)

Component files use `bx()` to prefix default styles with the `base:` custom variant. These compile to `:where()` selectors with zero CSS specificity, so any consumer class automatically wins via cascade — no runtime JS needed:

```typescript
import { bx } from "@osn/ui/lib/utils";
import { clsx } from "clsx";

// In a component file:
<div class={clsx(bx("bg-card rounded-xl border"), local.class)} />

// bx("bg-card rounded-xl border") → "base:bg-card base:rounded-xl base:border"
// Consumer passes class="bg-card/50 rounded-md" → wins via CSS cascade
```

### `clsx()` — conditional class joining (no conflict resolution)

Use for composing non-conflicting class sets, conditional classes, and signal-driven toggles:

```typescript
import { clsx } from "@osn/ui/lib/utils";

clsx("px-4 py-2", isActive && "font-bold", props.class)
```

### `cn()` — arbitrary runtime merging (with `tailwind-merge`)

Reserved for rare cases where two arbitrary class sets may contain conflicting Tailwind utilities and neither is a component default. `cn()` wraps `clsx` + `tailwind-merge` (~14 KB) for runtime conflict resolution:

```typescript
import { cn } from "@osn/ui/lib/utils";

// Only use when you genuinely have unpredictable conflicts:
cn(dynamicClassesFromSignalA(), dynamicClassesFromSignalB())
```

**Rule of thumb**: component files use `bx()` + `clsx()`. Consumer code uses `clsx()`. Use `cn()` only when you'd otherwise get broken styles from conflicting classes.

## Performance Guidelines

### Prefer `classList` for reactive class toggles

SolidJS's `classList` directive performs fine-grained DOM updates — it adds/removes individual classes without touching the rest of the class string. When using `cn()` inside a `class` attribute binding, every signal change recomputes the entire class string and replaces the full `className`.

For static or low-cardinality elements (a few buttons, a card header), `cn()` is fine. But inside `<For>` loops or any hot path that renders many items, prefer `classList`:

```tsx
// Prefer this in <For> loops:
<button
  class="rounded-md px-3 py-1.5 text-sm font-medium"
  classList={{
    "bg-primary text-primary-foreground": isActive(),
    "bg-background text-foreground": !isActive(),
  }}
>

// Avoid this in <For> loops:
<button class={cn("rounded-md px-3 py-1.5 text-sm", isActive() ? "bg-primary" : "bg-background")}>
```

### Use `createMemo` for filtered/mapped arrays

When passing a derived array to `<For>`, wrap it in `createMemo` so the array reference is stable unless the actual contents change:

```tsx
// Good — stable reference, <For> only diffs when filter result changes
const visibleTabs = createMemo(() => tabs.filter((t) => t.show()));
<For each={visibleTabs()}>{...}</For>

// Avoid — new array on every render, <For> diffs all items every time
<For each={tabs.filter((t) => t.show())}>{...}</For>
```

### Bundle size: `tailwind-merge` and the `base:` variant

Component files use `bx()` + `clsx()` for all default-vs-override class composition, which resolves conflicts via CSS cascade at zero runtime cost. `tailwind-merge` (~12-14 KB) is still bundled for the exported `cn()` function but is NOT called in the component render hot path.

If `tailwind-merge` is tree-shaken (i.e. no consumer imports `cn()`), the bundle drops by ~14 KB. If bundle size is a concern and `cn()` is still imported somewhere, consider refactoring the consumer to use `clsx()` instead — most conditional class composition doesn't involve Tailwind conflicts.

The `@custom-variant base (:where(&))` declaration in `App.css` is what makes this work. **Any new app** that uses `@osn/ui` components must include this variant declaration in its CSS.

## Component Patterns

### Variant Components (Button, Badge)

Use CVA for components with discrete visual variants:

```tsx
import { Button } from "@osn/ui/ui/button";

<Button variant="default">Primary action</Button>
<Button variant="secondary" size="sm">Secondary</Button>
<Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
<Button variant="destructive">Delete</Button>
```

For links that need button styling, use the exported `buttonVariants` function:

```tsx
import { buttonVariants } from "@osn/ui/ui/button";

<A href="/settings" class={buttonVariants({ variant: "secondary", size: "sm" })}>
  Settings
</A>
```

### Kobalte Components (Dialog, Popover, Tabs, RadioGroup, Checkbox)

These wrap Kobalte primitives with styling. They provide proper accessibility out of the box:

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@osn/ui/ui/dialog";

<Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Modal Title</DialogTitle>
    </DialogHeader>
    {/* content */}
  </DialogContent>
</Dialog>
```

Key behaviours you get for free:
- **Dialog** — portaled to `<body>`, overlay click dismisses, Escape key dismisses, focus trapped
- **Popover** — portaled, auto-positioned, outside click/Escape dismisses
- **Tabs** — `role="tablist"` / `role="tab"` / `role="tabpanel"`, keyboard arrow navigation
- **RadioGroup** — grouped `role="radiogroup"`, single selection, keyboard navigation
- **Checkbox** — `role="checkbox"`, indeterminate support

### Simple Styled Components (Input, Label, Card, Textarea)

Thin wrappers that apply consistent base styling and accept a `class` prop for overrides:

```tsx
import { Input } from "@osn/ui/ui/input";
import { Label } from "@osn/ui/ui/label";
import { Card } from "@osn/ui/ui/card";

<Card class="p-4">
  <Label for="email">Email</Label>
  <Input id="email" type="email" class="mt-1" />
</Card>
```

## CSS Theme Variables

Components reference CSS variables defined in each app's root CSS (e.g. `pulse/app/src/App.css`). The variable naming follows the shadcn convention:

```css
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --radius: 0.625rem;
}
```

Tailwind maps these via `@theme inline` to utility classes (`bg-primary`, `text-muted-foreground`, etc.). Dark mode overrides go in `.dark {}`.

**Any new app** that uses `@osn/ui` components must define these CSS variables in its root stylesheet. Copy from `pulse/app/src/App.css` as the starting point.

## Adding a New Component

1. Create the file in `osn/ui/src/components/ui/<name>.tsx`
2. Follow the existing pattern: `splitProps` for `class`, use `bx()` for base defaults and `clsx()` for composition with `local.class`, spread `...others`
3. For interactive components, use Kobalte primitives from `@kobalte/core/<name>`
4. For variant components, use CVA with `bx()` for each variant string, and export both the component and the `variants` function
5. For internal child elements that don't accept consumer `class` overrides, use `bx()` directly (no `clsx` needed)
6. Add a subpath export in `osn/ui/package.json`:
   ```json
   "./ui/<name>": "./src/components/ui/<name>.tsx"
   ```
7. No barrel file needed — consumers import individual components by path

## Testing Considerations

- Components render standard HTML — tests use `@solidjs/testing-library` with role/label queries
- **Kobalte portals**: Dialog and Popover content is portaled to `<body>`. Use `screen.queryByText()` (searches full document) instead of `container.querySelector()` (searches render container only)
- **`base:` prefixed class selectors**: Component default classes are prefixed with `base:` in the DOM (e.g. `base:relative` instead of `relative`). CSS selectors must escape the colon: `span.base\\:relative`. Consumer-provided classes (via `class` prop) are NOT prefixed and can be selected normally
- **Avatar DOM structure**: The `Avatar` wrapper has `base:relative` class. The fallback text is inside a nested `<span>`. Tests that find avatars should use `span.base\\:relative`
- **Close-friend ring**: Applied to the outer `Avatar` wrapper via `clsx()` (not prefixed — it's a consumer class), not to the inner `<img>` or fallback `<span>`

## Source Files

- [osn/ui/src/components/ui/](../../osn/ui/src/components/ui/) — all component source
- [osn/ui/src/lib/utils.ts](../../osn/ui/src/lib/utils.ts) — `bx()`, `clsx`, `cn()` utilities
- [osn/ui/package.json](../../osn/ui/package.json) — subpath exports
- [pulse/app/src/App.css](../../pulse/app/src/App.css) — CSS variable theme + `@custom-variant base`

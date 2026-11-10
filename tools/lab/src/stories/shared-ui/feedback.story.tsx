import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Chip, type ChipTone, type ChipTreatment, type ChipVariant } from "@shared/ui/ui/chip";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Input } from "@shared/ui/ui/input";
import { Notice, type NoticeSize, type NoticeTone } from "@shared/ui/ui/notice";
import { Skeleton, type SkeletonStandIn } from "@shared/ui/ui/skeleton";
import { Stat } from "@shared/ui/ui/stat";
import { For } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { type CireTheme, cireStyle } from "../cire-ui/cire-mapping.ts";

export const meta = { title: "shared/ui/feedback", layout: "padded" as const };

/**
 * The four components that say something happened, or that nothing has.
 *
 * All four were lifted out of cire's two portals, where each existed twice in
 * slightly different sizes and hard-coded palette colours. They are on the
 * token contract now, so the **light · dark** toggle is the thing to check
 * here: a `bg-green-500/15` chip reads on a dark ground and is a smear on a
 * light one, and that is precisely what the lift fixed.
 */
export const Notices = () => (
  <div class="flex max-w-xl flex-col gap-4">
    {(["danger", "warn", "success", "info"] as const).map((tone) => (
      <Notice tone={tone}>
        {tone === "danger" && "We could not save that. Nothing was changed."}
        {tone === "warn" && "Three guests have no email address, so they will not be invited."}
        {tone === "success" && "Invites sent to 84 households."}
        {tone === "info" && "Replies close 14 days before the day."}
      </Notice>
    ))}
  </div>
);

/**
 * `info` and `accent` have no mark and the other three each have a different
 * circled icon, which is the accessibility claim worth looking at rather than
 * reading about: switch to a greyscale filter and they should still be
 * tellable apart.
 */
export const NoticeGlyphs = () => (
  <div class="flex max-w-xl flex-col gap-4">
    <Notice tone="danger">Danger carries a circled cross and the word "Error:".</Notice>
    <Notice tone="warn">Warn carries a circled exclamation mark and the word "Warning:".</Notice>
    <Notice tone="success">Success carries a circled tick and the word "Success:".</Notice>
    <Notice tone="info">Info carries no mark at all — nothing has happened.</Notice>
    <Notice tone="accent">Accent carries no mark either — a standing note in the accent.</Notice>
  </div>
);

const TONES = [
  "danger",
  "warn",
  "success",
  "info",
  "accent",
] as const satisfies readonly NoticeTone[];
const SIZES = ["inline", "sm", "md"] as const satisfies readonly NoticeSize[];

const WORDS = {
  danger: "We could not save that. Nothing was changed.",
  warn: "Three guests have no email address, so they will not be invited.",
  success: "Invites sent to 84 households.",
  info: "Replies close 14 days before the day.",
  accent: "Preview — try the RSVP as a guest would. Nothing you send here is saved.",
} satisfies Record<NoticeTone, string>;

function EveryToneAt(props: { size: NoticeSize }) {
  return (
    <div class="flex flex-col gap-3">
      <For each={TONES}>
        {(tone) => (
          <Notice size={props.size} tone={tone}>
            {WORDS[tone]}
          </Notice>
        )}
      </For>
    </div>
  );
}

/**
 * Every tone at every size. `md` is the box every app drew before the others
 * existed; `sm` the same box, compact; `inline` no box at all — the error line
 * under a field.
 */
export const NoticeSizes = () => (
  <div class="flex max-w-xl flex-col gap-8">
    <For each={SIZES}>
      {(size) => (
        <section class="flex flex-col gap-3">
          <h3 class="text-meta text-subtle">{size}</h3>
          <EveryToneAt size={size} />
        </section>
      )}
    </For>
  </div>
);

/**
 * The inline size where it lives: under the field it is about, named by the
 * field's `aria-describedby`, so a screen reader hears it with the field and
 * not only when it appears.
 */
export const NoticeInline = () => (
  <div class="flex max-w-sm flex-col gap-1.5">
    <Input
      value="tia@example"
      aria-label="Email"
      aria-invalid="true"
      aria-describedby="notice-inline-email-error"
    />
    <Notice id="notice-inline-email-error" size="inline" tone="danger" alert>
      Enter a valid email address.
    </Notice>
  </div>
);

/**
 * The accent tone is a standing note in the app's accent, painted in the
 * accent's readable ink — under cire's mapping, the gold note. Each size.
 */
export const NoticeAccent = () => (
  <div class="flex max-w-xl flex-col gap-3">
    <For each={SIZES}>
      {(size) => (
        <Notice size={size} tone="accent">
          {size}: {WORDS.accent}
        </Notice>
      )}
    </For>
  </div>
);

/**
 * Every tone's box with `fill="none"`: the border and the ink, no tint, so the
 * words sit on the ground beneath. The inline line has no box and takes no
 * fill.
 */
export const NoticeUnfilled = () => (
  <div class="flex max-w-xl flex-col gap-8">
    <For each={["sm", "md"] as const}>
      {(size) => (
        <section class="flex flex-col gap-3">
          <h3 class="text-meta text-subtle">{size}, no fill</h3>
          <For each={TONES}>
            {(tone) => (
              <Notice size={size} tone={tone} fill="none">
                {WORDS[tone]}
              </Notice>
            )}
          </For>
        </section>
      )}
    </For>
  </div>
);

function CireRamp(props: { theme: CireTheme }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-0 flex-1 basis-80 flex-col gap-6 border p-5"
      style={cireStyle(props.theme)}
    >
      <span class="text-ui-xs tracking-ui-widest text-ui-ink-secondary uppercase">
        cire · {props.theme}
      </span>
      <For each={SIZES}>{(size) => <EveryToneAt size={size} />}</For>
    </div>
  );
}

/**
 * The same parts under cire's mapping, both ramps: the host portal's colours,
 * type steps and 6px notice corner. The guest site and the marketing site map
 * some roles differently — on both, `warn` shares its ink with `accent` — so
 * judge those there.
 */
export const NoticeInCire = () => (
  <div class="flex flex-wrap items-start gap-6">
    <CireRamp theme="dark" />
    <CireRamp theme="light" />
  </div>
);

export const Chips = () => (
  <div class="flex flex-col gap-6">
    <div class="flex flex-wrap items-center gap-2">
      <Chip>draft</Chip>
      <Chip tone="success">live</Chip>
      <Chip tone="pending">awaiting reply</Chip>
      <Chip tone="accent">quoted</Chip>
    </div>
    <p class="text-meta text-subtle max-w-md">
      The tones are roles — `success`, `pending`, `accent` — not domains. An app maps its own word
      onto one at the call site, which is what stops a second product needing a second set.
    </p>
  </div>
);

const CHIP_TONES = [
  "neutral",
  "success",
  "pending",
  "accent",
  "danger",
] as const satisfies readonly ChipTone[];

const CHIP_WORD = {
  neutral: "No reply",
  success: "Live",
  pending: "Awaiting",
  accent: "Connected",
  danger: "Declined",
} satisfies Record<ChipTone, string>;

/**
 * Every tone outlined: a 1px border at 40% of the tone (the hairline for
 * `neutral`) and no ground, at the filled chip's height — the filled row under
 * it is there for scale.
 */
export const ChipOutline = () => (
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <For each={CHIP_TONES}>
        {(tone) => (
          <Chip tone={tone} variant="outline">
            {CHIP_WORD[tone]}
          </Chip>
        )}
      </For>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <For each={CHIP_TONES}>{(tone) => <Chip tone={tone}>{CHIP_WORD[tone]}</Chip>}</For>
    </div>
  </div>
);

/**
 * The `tag` treatment: a label as written, in sentence case at normal spacing —
 * a vendor's category, "Cash fund", a gift no longer available — filled and
 * outlined. A `danger` chip is outlined unless a variant is asked for.
 */
export const ChipTag = () => (
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <Chip treatment="tag">Hair and makeup</Chip>
      <Chip treatment="tag">Cash fund</Chip>
      <Chip treatment="tag" tone="danger">
        No longer available
      </Chip>
      <Chip treatment="tag" tone="accent">
        You
      </Chip>
      <Chip treatment="tag" tone="pending">
        Coming up
      </Chip>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <Chip treatment="tag" variant="outline">
        Done
      </Chip>
      <Chip treatment="tag" variant="outline" tone="pending">
        Event removed
      </Chip>
    </div>
  </div>
);

/** An outline or a tag leading with a mark — a dot, a glyph — held 6px from its word. */
export const ChipWithMark = () => (
  <div class="flex flex-wrap items-center gap-2">
    <Chip tone="accent" variant="outline">
      <span aria-hidden="true" class="bg-ui-accent inline-block size-1.5 rounded-full" />
      Shown
    </Chip>
    <Chip variant="outline">
      <span aria-hidden="true" class="bg-ui-ink-tertiary inline-block size-1.5 rounded-full" />
      Hidden
    </Chip>
    <Chip treatment="tag" variant="outline">
      <span aria-hidden="true">✓</span>
      Done
    </Chip>
  </div>
);

function ChipRamp(props: { theme: CireTheme }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-0 flex-1 basis-80 flex-col gap-3 border p-5"
      style={cireStyle(props.theme)}
    >
      <span class="text-ui-xs tracking-ui-widest text-ui-ink-secondary uppercase">
        cire · {props.theme}
      </span>
      <For each={["filled", "outline"] as const satisfies readonly ChipVariant[]}>
        {(variant) => (
          <For each={["caps", "tag"] as const satisfies readonly ChipTreatment[]}>
            {(treatment) => (
              <div class="flex flex-wrap items-center gap-2">
                <For each={CHIP_TONES}>
                  {(tone) => (
                    <Chip tone={tone} variant={variant} treatment={treatment}>
                      {CHIP_WORD[tone]}
                    </Chip>
                  )}
                </For>
              </div>
            )}
          </For>
        )}
      </For>
    </div>
  );
}

/**
 * Every tone, variant and treatment under cire's mapping, both ramps: the host
 * portal's colours, type steps and pill corner.
 */
export const ChipsInCire = () => (
  <div class="flex flex-wrap items-start gap-6">
    <ChipRamp theme="dark" />
    <ChipRamp theme="light" />
  </div>
);

interface ChipArgs extends StoryArgs {
  label: string;
  tone: ChipTone;
  variant: ChipVariant;
  treatment: ChipTreatment;
}

export const ChipPlayground: Story<ChipArgs> = {
  args: { label: "quoted", tone: "accent", variant: "filled", treatment: "caps" },
  controls: {
    tone: { kind: "select", options: CHIP_TONES },
    variant: { kind: "select", options: ["filled", "outline"] },
    treatment: { kind: "select", options: ["caps", "tag"] },
  },
  render: (args) => (
    <Chip tone={args.tone} variant={args.variant} treatment={args.treatment}>
      {args.label}
    </Chip>
  ),
};

/**
 * The two defects the lift fixed, both visible here rather than described: the
 * dashed border (so an empty list does not read as one that failed to load) and
 * the centring (seven hand-written copies set `items-start` *and* `text-center`,
 * so a title read centred in its own box and left-aligned against the box).
 */
export const Empty = () => (
  <div class="flex w-full max-w-xl flex-col gap-6">
    <EmptyState title="No guests yet" />
    <EmptyState title="No guests yet" description="Add one, or import a spreadsheet." />
    <EmptyState
      title="Nothing in the registry"
      description="Guests see this page once there is something on it."
      action={<Button variant="outline">Add a gift</Button>}
    />
  </div>
);

export const Stats = () => (
  <div class="flex flex-wrap gap-8">
    <Stat value="84" label="Replied" />
    <Stat value="120" label="Invited" hint="across 63 households" />
    <Stat value="$4,280" label="Spent" hint="of $6,000" />
  </div>
);

interface NoticeArgs extends StoryArgs {
  tone: NoticeTone;
  size: NoticeSize;
  body: string;
  alert: boolean;
}

/**
 * `alert` is the one to play with: it turns the notice into a live region, so a
 * screen reader interrupts. Right for a save that just failed, wrong for a
 * standing note that was on screen before the reader arrived.
 */
export const NoticePlayground: Story<NoticeArgs> = {
  args: {
    tone: "danger",
    size: "md",
    body: "We could not save that. Nothing was changed.",
    alert: true,
  },
  controls: {
    tone: { kind: "select", options: TONES },
    size: { kind: "select", options: SIZES },
  },
  render: (args) => (
    <div class="max-w-xl">
      <Notice tone={args.tone} size={args.size} alert={args.alert}>
        {args.body}
      </Notice>
    </div>
  ),
};

const STAND_INS = [
  "line",
  "row",
  "field",
  "control",
  "card",
  "pill",
] as const satisfies readonly SkeletonStandIn[];

/**
 * Each stand-in at the sizes it takes, one group each: `line` for text, `row`
 * for a list row, `field` for a text field or a select, `control` for a
 * button, `card` for a card, `pill` for a chip and, square, an avatar. Every
 * one fills with the sunk well and pulses on Tailwind's `--animate-pulse`. To
 * see the still state, emulate `prefers-reduced-motion: reduce` (DevTools,
 * Rendering): each block stands at full strength. Emulate
 * `forced-colors: active` there to see the contrast theme: each block draws
 * an edge in the theme's text colour.
 */
export const Skeletons = () => (
  <div class="flex max-w-xl flex-col gap-8">
    <section class="flex flex-col gap-2">
      <h3 class="text-meta text-subtle">line</h3>
      <Skeleton standsFor="line" width={48} height={8} />
      <Skeleton standsFor="line" width={64} height={5} />
      <Skeleton standsFor="line" width={56} height={5} />
    </section>
    <section class="flex flex-col gap-2">
      <h3 class="text-meta text-subtle">row</h3>
      <Skeleton height={14} />
      <Skeleton height={12} />
      <Skeleton width={40} height={10} />
    </section>
    <section class="flex flex-col gap-2">
      <h3 class="text-meta text-subtle">field</h3>
      <Skeleton standsFor="field" height={9} />
      <Skeleton standsFor="field" width={48} height={9} />
    </section>
    <section class="flex flex-col gap-2">
      <h3 class="text-meta text-subtle">control</h3>
      <div class="flex flex-wrap items-center gap-2">
        <Skeleton standsFor="control" width={24} height={9} />
        <Skeleton standsFor="control" width={32} height={11} />
      </div>
    </section>
    <section class="flex flex-col gap-2">
      <h3 class="text-meta text-subtle">card</h3>
      <Skeleton standsFor="card" height={28} />
      <Skeleton standsFor="card" height={20} />
    </section>
    <section class="flex flex-col gap-2">
      <h3 class="text-meta text-subtle">pill</h3>
      <div class="flex flex-wrap items-center gap-2">
        <Skeleton standsFor="pill" width={16} height={6} />
        <Skeleton standsFor="pill" width={24} height={9} />
        <Skeleton standsFor="pill" width={10} height={10} />
        <Skeleton standsFor="pill" width={8} height={8} />
      </div>
    </section>
  </div>
);

/** Each stand-in's size in a column: a line's, a button's or a chip's width, the column's for the rest. */
const ONE_OF_EACH = {
  line: { width: 48, height: 5 },
  row: { width: "full", height: 12 },
  field: { width: "full", height: 9 },
  control: { width: 24, height: 9 },
  card: { width: "full", height: 20 },
  pill: { width: 16, height: 6 },
} as const satisfies Record<SkeletonStandIn, { width: number | "full"; height: number }>;

/** One of each stand-in. Not exported. */
function EveryStandIn() {
  return (
    <For each={STAND_INS}>
      {(standIn) => <Skeleton standsFor={standIn} {...ONE_OF_EACH[standIn]} />}
    </For>
  );
}

/**
 * The placeholder Musubi's call sites draw today (`bg-muted/50 animate-pulse`,
 * 8px corners on lines and rows, the card's on cards), written in the
 * contract's names, which the lab's Musubi mapping resolves to the same values.
 * Drawn by hand only to compare against `Skeleton`'s full-strength well.
 */
function MusubiToday() {
  return (
    <>
      <div
        aria-hidden="true"
        class="bg-ui-surface-sunk/50 rounded-ui-md h-5 w-48 max-w-full animate-pulse"
      />
      <div aria-hidden="true" class="bg-ui-surface-sunk/50 rounded-ui-md h-12 animate-pulse" />
      <div aria-hidden="true" class="bg-ui-surface-sunk/50 rounded-ui-lg h-20 animate-pulse" />
    </>
  );
}

/**
 * Each stand-in on the page ground and inside a `Card`, to judge the fill against
 * both, and below them the half-strength placeholder Musubi's call sites draw
 * today, on the same two grounds. Toggle **light · dark**: under Musubi's dark
 * mapping the sunk well (`--muted`) sits close to the card (`--card`), and at
 * the pulse's low point closer still.
 */
export const SkeletonGrounds = () => (
  <div class="grid max-w-3xl gap-6 sm:grid-cols-2">
    <section class="flex flex-col gap-3">
      <h3 class="text-meta text-subtle">On the page</h3>
      <EveryStandIn />
    </section>
    <Card padding="md" class="flex flex-col gap-3">
      <h3 class="text-meta text-subtle">In a card</h3>
      <EveryStandIn />
    </Card>
    <section class="flex flex-col gap-3">
      <h3 class="text-meta text-subtle">Musubi today, on the page</h3>
      <MusubiToday />
    </section>
    <Card padding="md" class="flex flex-col gap-3">
      <h3 class="text-meta text-subtle">Musubi today, in a card</h3>
      <MusubiToday />
    </Card>
  </div>
);

/**
 * Musubi's placeholders as they would read on `Skeleton`: the connections
 * list's rows, Discover's card grid, an organisation's name and handle, its
 * members' rows, and a person's avatar beside two lines. Each region carries
 * `aria-busy`, which is the caller's to set. At a phone width the fixed lines
 * stop at the column's edge.
 */
export const SkeletonInPlace = () => (
  <div class="flex max-w-2xl flex-col gap-10">
    <section aria-busy="true" aria-label="Connections" class="flex flex-col gap-2">
      <For each={[0, 1, 2]}>{() => <Skeleton height={14} />}</For>
    </section>
    <section aria-busy="true" aria-label="Discover" class="grid gap-3 sm:grid-cols-2">
      <For each={[0, 1, 2, 3]}>{() => <Skeleton standsFor="card" height={28} />}</For>
    </section>
    <section aria-busy="true" aria-label="Organisation" class="flex flex-col gap-3">
      <Skeleton standsFor="line" width={48} height={8} />
      <Skeleton standsFor="line" width={64} height={5} />
      <div class="mt-3 flex flex-col gap-2">
        <For each={[0, 1]}>{() => <Skeleton height={12} />}</For>
      </div>
    </section>
    <section aria-busy="true" aria-label="Person" class="flex items-center gap-3">
      <Skeleton standsFor="pill" width={10} height={10} />
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton standsFor="line" width={40} height={4} />
        <Skeleton standsFor="line" width={24} height={3} />
      </div>
    </section>
  </div>
);

interface SkeletonArgs extends StoryArgs {
  standsFor: SkeletonStandIn;
  full: boolean;
  width: number;
  height: number;
}

/**
 * `width` and `height` are spacing steps (`48` is 12rem). Tick `full` to fill
 * the container instead of `width`.
 */
export const SkeletonPlayground: Story<SkeletonArgs> = {
  args: { standsFor: "row", full: false, width: 48, height: 14 },
  controls: {
    standsFor: { kind: "select", options: STAND_INS },
    width: { kind: "range", min: 0, max: 160, step: 1 },
    height: { kind: "range", min: 0, max: 64, step: 1 },
  },
  render: (args) => (
    <div class="w-full max-w-xl">
      <Skeleton
        standsFor={args.standsFor}
        width={args.full ? "full" : args.width}
        height={args.height}
      />
    </div>
  ),
};

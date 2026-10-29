import { Button } from "@shared/ui/ui/button";
import { Chip, type ChipTone, type ChipTreatment, type ChipVariant } from "@shared/ui/ui/chip";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Input } from "@shared/ui/ui/input";
import { Notice, type NoticeSize, type NoticeTone } from "@shared/ui/ui/notice";
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
 * outlined.
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

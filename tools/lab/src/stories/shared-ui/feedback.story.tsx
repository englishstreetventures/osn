import { Button } from "@shared/ui/ui/button";
import { Chip, type ChipTone } from "@shared/ui/ui/chip";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Notice, type NoticeTone } from "@shared/ui/ui/notice";
import { Stat } from "@shared/ui/ui/stat";

import type { Story, StoryArgs } from "../../lab/types.ts";

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
 * `info` has no glyph and the other three each have a different one, which is
 * the accessibility claim worth looking at rather than reading about: switch to
 * a greyscale filter and the four should still be tellable apart.
 */
export const NoticeGlyphs = () => (
  <div class="flex max-w-xl flex-col gap-4">
    <Notice tone="danger">Danger carries a cross and the word "Error:".</Notice>
    <Notice tone="warn">Warn carries a triangle and the word "Warning:".</Notice>
    <Notice tone="success">Success carries a tick and the word "Done:".</Notice>
    <Notice tone="info">Info carries no mark at all — nothing has happened.</Notice>
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

interface ChipArgs extends StoryArgs {
  label: string;
  tone: ChipTone;
}

export const ChipPlayground: Story<ChipArgs> = {
  args: { label: "quoted", tone: "accent" },
  controls: { tone: { kind: "select", options: ["neutral", "success", "pending", "accent"] } },
  render: (args) => <Chip tone={args.tone}>{args.label}</Chip>,
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
  body: string;
  alert: boolean;
}

/**
 * `alert` is the one to play with: it turns the notice into a live region, so a
 * screen reader interrupts. Right for a save that just failed, wrong for a
 * standing note that was on screen before the reader arrived.
 */
export const NoticePlayground: Story<NoticeArgs> = {
  args: { tone: "danger", body: "We could not save that. Nothing was changed.", alert: true },
  controls: { tone: { kind: "select", options: ["danger", "warn", "success", "info"] } },
  render: (args) => (
    <div class="max-w-xl">
      <Notice tone={args.tone} alert={args.alert}>
        {args.body}
      </Notice>
    </div>
  ),
};

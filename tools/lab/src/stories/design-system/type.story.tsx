import { CONTRACT_SCALAR_TOKENS, CONTRACT_SCALES } from "@shared/design-tokens";
import { For } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Caption, Gallery, Mono, Readout, Rule, Section } from "./chrome.tsx";
import {
  FONT,
  LEADING,
  type LeadingStep,
  MEASURE,
  type MeasureStep,
  TEXT_SIZE,
  type TextStep,
  TRACKING,
  type TrackingStep,
} from "./utilities.ts";

export const meta = { title: "design-system/type", layout: "padded" as const };

const TEXT_STEPS = Object.keys(CONTRACT_SCALES.text) as TextStep[];
const TRACKING_STEPS = Object.keys(CONTRACT_SCALES.tracking) as TrackingStep[];
const LEADING_STEPS = Object.keys(CONTRACT_SCALES.leading) as LeadingStep[];
const MEASURE_STEPS = Object.keys(CONTRACT_SCALES.measure) as MeasureStep[];

const PARAGRAPH =
  "Seven steps, clustered from what the monorepo actually used: 956 sites carrying 93 distinct font sizes, nine of them between 0.7rem and 0.95rem. That is not a house style, it is drift, and a scale is the thing that stops it recurring. Seven and not eleven because a scale nobody can hold in their head is another way of having no scale.";

interface SampleArgs extends StoryArgs {
  sample: string;
}

function ScaleRow(props: { step: TextStep; sample: string }) {
  let el!: HTMLParagraphElement;
  return (
    <div class="border-ui-hairline flex items-baseline gap-6 border-t py-3">
      <div class="w-44 shrink-0">
        <Caption
          name={
            <div class="flex flex-col">
              <Mono>{TEXT_SIZE[props.step]}</Mono>
              <Mono muted>contract {CONTRACT_SCALES.text[props.step]}</Mono>
            </div>
          }
          value={
            <>
              painted <Readout of={() => el} property="font-size" />
            </>
          }
        />
      </div>
      <p ref={el} class={`${TEXT_SIZE[props.step]} leading-ui-tight text-ui-ink`}>
        {props.sample}
      </p>
    </div>
  );
}

/**
 * The seven steps stacked, so the scale can be read as a scale. The contract's
 * fallback is beside each; the painted size is what this app mapped it to —
 * musubi keeps its four-step house scale and fills the gaps by continuing it,
 * which is why the two columns disagree.
 */
export const Scale: Story<SampleArgs> = {
  args: { sample: "The quick brown fox jumps over the lazy dog" },
  render: (args) => (
    <Gallery
      title="Type scale"
      intro={
        <>
          Named for role, not value: changing <Mono>--ui-text-sm</Mono> is one line where{" "}
          <Mono>text-[0.82rem]</Mono> was 108 sites. Values are rem so a reader's root font size
          scales the whole system; <Mono>em</Mono> is absent because two nested em sizes compound.
          Each step is visibly distinct from its neighbours — that is what makes "the next step up"
          a decision rather than a guess.
        </>
      }
    >
      <div class="flex flex-col">
        <For each={TEXT_STEPS}>{(step) => <ScaleRow step={step} sample={args.sample} />}</For>
      </div>
    </Gallery>
  ),
};

function FamilyRow(props: { token: (typeof CONTRACT_SCALAR_TOKENS.fontFamily)[number] }) {
  let el!: HTMLParagraphElement;
  return (
    <div class="border-ui-hairline flex items-baseline gap-6 border-t py-3">
      <div class="w-44 shrink-0">
        <Caption
          name={<Mono>{FONT[props.token]}</Mono>}
          value={<Readout of={() => el} property="font-family" />}
        />
      </div>
      <p ref={el} class={`${FONT[props.token]} text-ui-lg text-ui-ink`}>
        Sphinx of black quartz, judge my vow — 0123456789
      </p>
    </div>
  );
}

/** Families only — the sizes are the scale above. */
export const Families = () => (
  <Gallery
    title="Type families"
    intro={
      <>
        Three roles. <Mono>body</Mono> carries the tool, <Mono>display</Mono> the wordmark and the
        headline, <Mono>mono</Mono> the code and the figure. An app maps each to its own stack; the
        fallbacks are the platform's.
      </>
    }
  >
    <div class="flex flex-col">
      <For each={CONTRACT_SCALAR_TOKENS.fontFamily}>{(token) => <FamilyRow token={token} />}</For>
    </div>
  </Gallery>
);

interface TrackingArgs extends StoryArgs {
  sample: string;
  uppercase: boolean;
}

function TrackingRow(props: { step: TrackingStep; sample: string; uppercase: boolean }) {
  let el!: HTMLParagraphElement;
  return (
    <div class="border-ui-hairline flex items-baseline gap-6 border-t py-3">
      <div class="w-44 shrink-0">
        <Caption
          name={
            <div class="flex flex-col">
              <Mono>{TRACKING[props.step]}</Mono>
              <Mono muted>contract {CONTRACT_SCALES.tracking[props.step]}</Mono>
            </div>
          }
          value={
            <>
              painted <Readout of={() => el} property="letter-spacing" />
            </>
          }
        />
      </div>
      <p
        ref={el}
        class={`${TRACKING[props.step]} text-ui-sm text-ui-ink font-medium`}
        classList={{ uppercase: props.uppercase }}
      >
        {props.sample}
      </p>
    </div>
  );
}

/**
 * Letter-spacing is the whole difference between an eyebrow label and
 * shouting. The wide end exists for uppercase: switch the case off and the
 * same steps look wrong, which is the point.
 */
export const Tracking: Story<TrackingArgs> = {
  args: { sample: "Replies close in fourteen days", uppercase: true },
  render: (args) => (
    <Gallery
      title="Tracking"
      intro={
        <>
          Six steps from 18 observed values, chosen so nothing moved more than 0.04em. The wide end
          is not decoration: <Mono>wider</Mono> and <Mono>ultra</Mono> are what the uppercase
          eyebrow labels across cire and pulse are built on. musubi tracks everything at −0.15px as
          a house rule, so its lower steps all paint the same.
        </>
      }
    >
      <div class="flex flex-col">
        <For each={TRACKING_STEPS}>
          {(step) => <TrackingRow step={step} sample={args.sample} uppercase={args.uppercase} />}
        </For>
      </div>
    </Gallery>
  ),
};

function LeadingRow(props: { step: LeadingStep; sample: string }) {
  let el!: HTMLParagraphElement;
  return (
    <div class="border-ui-hairline flex items-start gap-6 border-t py-3">
      <div class="w-44 shrink-0">
        <Caption
          name={
            <div class="flex flex-col">
              <Mono>{LEADING[props.step]}</Mono>
              <Mono muted>contract {CONTRACT_SCALES.leading[props.step]}</Mono>
            </div>
          }
          value={
            <>
              painted <Readout of={() => el} property="line-height" />
            </>
          }
        />
      </div>
      <p ref={el} class={`${LEADING[props.step]} max-w-ui-sm text-ui-base text-ui-ink`}>
        {props.sample}
      </p>
    </div>
  );
}

/** Five steps on the same paragraph, so the difference is between the lines rather than in a number. */
export const Leading: Story<SampleArgs> = {
  args: { sample: PARAGRAPH },
  render: (args) => (
    <Gallery
      title="Leading"
      intro={
        <>
          Five steps from 12 observed values; nothing moved more than 0.05. <Mono>none</Mono> is
          1.1, not 1 — a display line still needs its descenders. A component that wants a true{" "}
          <Mono>line-height: 1</Mono> on a one-line badge reaches for Tailwind's own{" "}
          <Mono>leading-none</Mono>, which is a structural choice rather than a step on a scale.
        </>
      }
    >
      <div class="flex flex-col">
        <For each={LEADING_STEPS}>{(step) => <LeadingRow step={step} sample={args.sample} />}</For>
      </div>
    </Gallery>
  ),
};

interface MeasureArgs extends StoryArgs {
  step: number;
}

function MeasureBar(props: { step: MeasureStep }) {
  let el!: HTMLDivElement;
  return (
    <div class="flex items-center gap-4">
      <div class="w-44 shrink-0">
        <Caption
          name={
            <div class="flex flex-col">
              <Mono>{MEASURE[props.step]}</Mono>
              <Mono muted>contract {CONTRACT_SCALES.measure[props.step]}</Mono>
            </div>
          }
          value={
            <>
              painted <Readout of={() => el} property="max-width" />
            </>
          }
        />
      </div>
      <div ref={el} class={`${MEASURE[props.step]} rounded-ui-pill bg-ui-accent-soft h-3 w-full`} />
    </div>
  );
}

/**
 * Content widths only. The bars show the seven caps against each other; the
 * range control walks a paragraph through them, which is the only way to feel
 * where a line gets too long to follow back to its start.
 */
export const Measure: Story<MeasureArgs> = {
  args: { step: 2 },
  controls: { step: { kind: "range", min: 0, max: MEASURE_STEPS.length - 1, step: 1 } },
  render: (args) => {
    const chosen = () => MEASURE_STEPS[Math.min(MEASURE_STEPS.length - 1, Math.max(0, args.step))];
    return (
      <Gallery
        title="Measure"
        intro={
          <>
            The caps that decide how long a line of prose gets and how wide a panel or modal grows.
            Seven steps from 87 uses spread over 28 distinct widths — <Mono>max-w-[640px]</Mono> and{" "}
            <Mono>max-w-[40rem]</Mono> were the same number written twice. A one-off layout constant
            (a 240px rail, a 44% column) is <em>not</em> a measure and stays arbitrary.
          </>
        }
      >
        <Section title="The seven caps">
          <div class="flex flex-col gap-3">
            <For each={MEASURE_STEPS}>{(step) => <MeasureBar step={step} />}</For>
          </div>
        </Section>
        <Section
          title="A paragraph at the chosen step"
          eyebrow={`step ${args.step} · ${MEASURE[chosen()]}`}
        >
          <Rule>Drag the control to walk the paragraph across the scale.</Rule>
          <p
            class={`${MEASURE[chosen()]} rounded-ui-md border-ui-hairline bg-ui-surface text-ui-base leading-ui-normal text-ui-ink border p-4`}
          >
            {PARAGRAPH} {PARAGRAPH}
          </p>
        </Section>
      </Gallery>
    );
  },
};

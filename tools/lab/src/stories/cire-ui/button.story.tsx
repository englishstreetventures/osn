import Button, { type ButtonSize, type ButtonVariant } from "@cire/ui/button";
import { createEffect, createSignal, For, type JSX } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import {
  Caption,
  Eyebrow,
  Gallery,
  Mono,
  Readout,
  Rule,
  Section,
} from "../design-system/chrome.tsx";
import { computed, themeVersion } from "../design-system/measure.ts";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/Button", layout: "padded" as const };

type ThemeChoice = CireTheme | "both";

const THEME_OPTIONS = ["both", "dark", "light"] as const;

const VARIANTS = [
  "primary",
  "cta",
  "outline",
  "quiet",
  "quietDanger",
  "choice",
  "tile",
  "dashed",
  "field",
  "danger",
  "chip",
  "link",
  "subtle",
  "touchLink",
  "bare",
  "bareDanger",
] as const satisfies readonly ButtonVariant[];

const SIZES = ["sm", "md", "lg", "icon", "swatch"] as const satisfies readonly ButtonSize[];

/** The groups `wiki/shared/component-library.md` §cire's `Button` names, in its order. */
const GROUPS: readonly { name: string; variants: readonly ButtonVariant[] }[] = [
  { name: "Commit", variants: ["primary", "cta"] },
  { name: "Secondary", variants: ["outline", "quiet", "dashed"] },
  { name: "Destructive", variants: ["danger", "quietDanger", "bareDanger"] },
  { name: "Text", variants: ["link", "subtle", "touchLink"] },
  { name: "Glyph", variants: ["bare"] },
  { name: "Field", variants: ["field"] },
  { name: "Chrome", variants: ["chip"] },
  { name: "State and fill", variants: ["choice", "tile"] },
];

/** A label each variant carries somewhere in cire, written as the call site writes it. */
const LABEL = {
  primary: "Save changes",
  cta: "Enter your code",
  outline: "Add an event",
  quiet: "Export guests",
  quietDanger: "Deactivate",
  choice: "Phone",
  tile: "Open dashboard",
  dashed: "Create a wedding",
  field: "Vegetarian, no nuts",
  danger: "Delete wedding",
  chip: "See details",
  link: "View listing",
  subtle: "Cancel",
  touchLink: "Sign out",
  bare: "Show more",
  bareDanger: "Remove",
} as const satisfies Readonly<Record<ButtonVariant, string>>;

function themesFor(choice: ThemeChoice): CireTheme[] {
  return choice === "both" ? ["dark", "light"] : [choice];
}

/** One button at one size, with the content that size is for: a word, a glyph, or a picture. */
function Specimen(props: {
  variant: ButtonVariant;
  size: ButtonSize;
  label?: string;
  disabled?: boolean;
  ariaDisabled?: boolean;
  class?: string;
  ref?: (el: HTMLButtonElement) => void;
  /** The group semantics a call site adds: a toggle's `aria-pressed`, a radio's role and `aria-checked`. */
  extra?: { role?: "radio"; "aria-pressed"?: "true" | "false"; "aria-checked"?: "true" | "false" };
}) {
  const label = () => props.label ?? LABEL[props.variant];
  return (
    <Button
      ref={props.ref}
      variant={props.variant}
      size={props.size}
      disabled={props.disabled}
      aria-disabled={props.ariaDisabled ? "true" : undefined}
      aria-label={props.size === "icon" || props.size === "swatch" ? label() : undefined}
      class={props.class}
      {...props.extra}
    >
      {props.size === "icon" ? (
        <span aria-hidden="true">+</span>
      ) : props.size === "swatch" ? (
        <span aria-hidden="true" class="bg-ui-accent-soft block h-10 w-10" />
      ) : (
        label()
      )}
    </Button>
  );
}

/** A wrapper that carries cire's whole `--ui-*` mapping for one theme. */
function CirePanel(props: { theme: CireTheme; children: JSX.Element }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-0 flex-1 basis-80 flex-col gap-5 border p-5"
      style={cireStyle(props.theme)}
    >
      <Eyebrow>cire · {props.theme}</Eyebrow>
      {props.children}
    </div>
  );
}

function Panels(props: { theme: ThemeChoice; children: (theme: CireTheme) => JSX.Element }) {
  return (
    <div class="flex flex-wrap items-start gap-6">
      <For each={themesFor(props.theme)}>
        {(theme) => <CirePanel theme={theme}>{props.children(theme)}</CirePanel>}
      </For>
    </div>
  );
}

interface ThemeArgs extends StoryArgs {
  cireTheme: ThemeChoice;
}

const themeControl = { cireTheme: { kind: "select" as const, options: THEME_OPTIONS } };

/**
 * Every variant at every size, grouped by job. Read across a row for the five
 * sizes of one variant, and down the page for the variants.
 */
export const Variants: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Button"
      intro={
        <>
          Sixteen variants, five sizes, inside cire's <Mono>--ui-*</Mono> mapping. Actions are
          pills; a <Mono>tile</Mono>, a <Mono>field</Mono> and the <Mono>swatch</Mono> size take the
          14px field corner. Labels are written in sentence case and shown as written. cire's fonts
          are not loaded here, so the type is the lab's: judge the face in the app.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        {() => (
          <For each={GROUPS}>
            {(group) => (
              <div class="flex flex-col gap-3">
                <h2 class="text-ui-sm text-ui-ink font-semibold">{group.name}</h2>
                <For each={group.variants}>
                  {(variant) => (
                    <div class="flex flex-col gap-1.5">
                      <Mono muted>{variant}</Mono>
                      <div class="flex flex-wrap items-center gap-3">
                        <For each={SIZES}>
                          {(size) => <Specimen variant={variant} size={size} />}
                        </For>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        )}
      </Panels>
    </Gallery>
  ),
};

/**
 * The states a call site sets rather than the pointer: unavailable two ways,
 * and chosen two ways. Hover and keyboard focus need a pointer and a key, so
 * try them here by hand.
 */
export const States: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Button — states"
      intro={
        <>
          <Mono>disabled</Mono> leaves the tab order; <Mono>aria-disabled</Mono> keeps its tab stop
          and swallows the click. A <Mono>choice</Mono> is marked the same whether its group reads{" "}
          <Mono>aria-pressed</Mono> or <Mono>aria-checked</Mono>. Tab into a panel to see the focus
          ring follow the pill.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        {() => (
          <>
            <Section title="Unavailable">
              <div class="flex flex-wrap items-center gap-3">
                <Specimen variant="primary" size="md" label="Rest" />
                <Specimen variant="primary" size="md" label="Disabled" disabled />
                <Specimen variant="primary" size="md" label="Aria-disabled" ariaDisabled />
                <Specimen variant="quiet" size="md" label="Disabled" disabled />
                <Specimen variant="link" size="md" label="Disabled link" disabled />
              </div>
            </Section>
            <Section title="Chosen, as a toggle group">
              <fieldset class="flex flex-wrap items-center gap-2">
                <legend class="sr-only">Preview</legend>
                <Specimen
                  variant="choice"
                  size="sm"
                  label="Desktop"
                  extra={{ "aria-pressed": "false" }}
                />
                <Specimen
                  variant="choice"
                  size="sm"
                  label="Phone"
                  extra={{ "aria-pressed": "true" }}
                />
              </fieldset>
            </Section>
            <Section title="Chosen, as a radio group">
              <div class="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Picture">
                <Specimen
                  variant="choice"
                  size="swatch"
                  label="Picture 1"
                  extra={{ role: "radio", "aria-checked": "true" }}
                />
                <Specimen
                  variant="choice"
                  size="swatch"
                  label="Picture 2"
                  extra={{ role: "radio", "aria-checked": "false" }}
                />
                <Specimen
                  variant="choice"
                  size="md"
                  label="Sage"
                  extra={{ role: "radio", "aria-checked": "false" }}
                />
                <Specimen
                  variant="choice"
                  size="md"
                  label="Ivory"
                  extra={{ role: "radio", "aria-checked": "true" }}
                />
              </div>
            </Section>
          </>
        )}
      </Panels>
    </Gallery>
  ),
};

/** What a measured corner says about the shape it draws. */
function verdict(el: Element | undefined): string {
  const width = Number.parseFloat(computed(el, "width"));
  const height = Number.parseFloat(computed(el, "height"));
  const radius = Number.parseFloat(computed(el, "border-top-left-radius"));
  if (![width, height, radius].every(Number.isFinite) || width === 0) return "unmeasured";
  if (radius >= Math.min(width, height) / 2) {
    return Math.abs(width - height) < 0.5 ? "a circle" : "a pill";
  }
  return radius === 0 ? "square" : `a ${radius}px corner`;
}

/** One measured specimen: its size, its corner, and the shape those make. */
function Measured(props: {
  variant: ButtonVariant;
  size: ButtonSize;
  note: string;
  class?: string;
}) {
  let el: HTMLButtonElement | undefined;
  const [drawn, setDrawn] = createSignal("unmeasured");
  createEffect(() => {
    themeVersion();
    setDrawn(verdict(el));
  });
  return (
    <div class="flex flex-col items-start gap-2">
      <Specimen
        variant={props.variant}
        size={props.size}
        class={props.class}
        ref={(node) => {
          el = node;
        }}
      />
      <Caption
        name={
          <Mono>
            {props.variant} · {props.size}
            {props.class ? ` · class="${props.class}"` : ""}
          </Mono>
        }
        value={
          <>
            <Readout of={() => el} property="width" /> × <Readout of={() => el} property="height" />{" "}
            · corner <Readout of={() => el} property="border-top-left-radius" /> · {drawn()}
          </>
        }
      />
      <p class="text-ui-xs leading-ui-snug text-ui-ink-secondary max-w-64">{props.note}</p>
    </div>
  );
}

/**
 * The shape claims, measured from the painted button rather than read from its
 * classes: happy-dom computes no layout, so this story is where they are
 * checked.
 */
export const Corners: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Gallery
      title="cire/ui Button — corners"
      intro={
        <>
          Each caption is the computed width, height and top-left corner of the button above it. The
          pill is the <Mono>control</Mono> role at 999px, so a 32px-square <Mono>icon</Mono> button
          is a circle. The last specimen passes a plain <Mono>rounded-none</Mono>: every default
          corner is a <Mono>base:</Mono> one, so the caller's wins.
        </>
      }
    >
      <Panels theme={args.cireTheme}>
        {() => (
          <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-6">
            <Measured variant="primary" size="md" note="An action: the control role, a pill." />
            <Measured
              variant="outline"
              size="icon"
              note="A boxed glyph: 32px square, so a circle."
            />
            <Measured variant="quiet" size="icon" note="The same circle on a hairline border." />
            <Measured variant="tile" size="md" note="A block: the field role, 14px." />
            <Measured variant="field" size="md" note="Holds a value: the field role, 14px." />
            <Measured
              variant="choice"
              size="swatch"
              note="Frames a picture: the field role whatever the variant."
            />
            <Measured
              variant="chip"
              size="md"
              class="rounded-none"
              note="A caller's plain corner beats the variant's."
            />
          </div>
        )}
      </Panels>
      <Section title="What to look at">
        <Rule>
          Every action is a pill and every label sits at normal tracking in a medium weight. The{" "}
          <Mono>icon</Mono> captions read 32px × 32px and a circle. Nothing here is uppercase.
        </Rule>
      </Section>
    </Gallery>
  ),
};

interface PlaygroundArgs extends StoryArgs {
  label: string;
  variant: ButtonVariant;
  size: ButtonSize;
  disabled: boolean;
  cireTheme: CireTheme;
}

/** One button with live args. */
export const Playground: Story<PlaygroundArgs> = {
  args: {
    label: "Save changes",
    variant: "primary",
    size: "md",
    disabled: false,
    cireTheme: "dark",
  },
  controls: {
    variant: { kind: "select", options: VARIANTS },
    size: { kind: "select", options: SIZES },
    cireTheme: { kind: "select", options: ["dark", "light"] },
  },
  render: (args) => (
    <CirePanel theme={args.cireTheme}>
      <div class="flex items-center justify-center p-6">
        <Specimen
          variant={args.variant}
          size={args.size}
          label={args.label}
          disabled={args.disabled}
        />
      </div>
    </CirePanel>
  ),
};

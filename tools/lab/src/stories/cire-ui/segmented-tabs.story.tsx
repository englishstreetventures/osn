import SegmentedTabs, { type SegmentedItem } from "@cire/ui/segmented-tabs";
import { createSignal, For, type JSX } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Caption, Eyebrow } from "../design-system/chrome.tsx";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/SegmentedTabs", layout: "padded" as const };

type ThemeChoice = CireTheme | "both";
const THEME_OPTIONS = ["both", "dark", "light"] as const;
const themesFor = (choice: ThemeChoice): CireTheme[] =>
  choice === "both" ? ["dark", "light"] : [choice];

/**
 * The portal tokens the glass reads beyond the contract, as the host portal
 * sets them: its spring (the `cubic-bezier` it declares before its `linear()`
 * one), its inner lip and first lift, and the glass's light edge.
 */
const PORTAL = {
  dark: {
    "--ease-spring": "cubic-bezier(0.34, 1.32, 0.64, 1)",
    "--inner-lip": "inset 0 1px 0 oklch(100% 0 0 / 0.045)",
    "--elev-1": "0 1px 2px oklch(0% 0 0 / 0.32)",
    "--glass-edge": "oklch(100% 0 0 / 0.1)",
  },
  light: {
    "--ease-spring": "cubic-bezier(0.34, 1.32, 0.64, 1)",
    "--inner-lip": "inset 0 1px 0 oklch(100% 0 0 / 0.6)",
    "--elev-1": "0 1px 2px oklch(30% 0.02 340 / 0.12)",
    "--glass-edge": "oklch(100% 0 0 / 0.7)",
  },
} satisfies Record<CireTheme, JSX.CSSProperties>;

function CirePanel(props: { theme: CireTheme; children: JSX.Element }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-0 flex-1 basis-80 flex-col gap-5 border p-5"
      style={{ ...cireStyle(props.theme), ...PORTAL[props.theme] }}
    >
      <Eyebrow>cire · {props.theme}</Eyebrow>
      {props.children}
    </div>
  );
}

function Panels(props: { theme: ThemeChoice; children: () => JSX.Element }) {
  return (
    <div class="flex flex-wrap items-start gap-6">
      <For each={themesFor(props.theme)}>
        {(theme) => <CirePanel theme={theme}>{props.children()}</CirePanel>}
      </For>
    </div>
  );
}

interface ThemeArgs extends StoryArgs {
  cireTheme: ThemeChoice;
}
const themeControl = { cireTheme: { kind: "select" as const, options: THEME_OPTIONS } };

/** Stand-in glyphs, drawn as the portal's 24-unit stroked icons are. */
function glyph(path: string) {
  return (props: { class?: string; "aria-hidden"?: "true"; strokeWidth?: number }) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={props.strokeWidth ?? 2}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={props["aria-hidden"]}
      class={props.class}
    >
      <path d={path} />
    </svg>
  );
}
const Rows = glyph("M4 6h16M4 12h16M4 18h16");
const Pencil = glyph("M4 20h4L19 9l-4-4L4 16v4z");
const Check = glyph("M20 6 9 17l-5-5");
const Sheet = glyph("M4 4h16v16H4zM4 10h16M10 4v16");
const EyeOff = glyph(
  "M3 3l18 18M10.6 6.1A9 9 0 0 1 21 12a14 14 0 0 1-2.2 3M6.6 6.6A14 14 0 0 0 3 12s3 6 9 6a8.8 8.8 0 0 0 4-.9",
);

/** Moves its own highlight: a strip the reader can work. */
function Working<V extends string>(props: {
  items: SegmentedItem<V>[];
  initial: V;
  label: string;
  semantics: "tabs" | "radio" | "current";
  iconOnly?: boolean;
  scroll?: boolean;
  refuse?: V;
}) {
  const [value, setValue] = createSignal(props.initial);
  return (
    <div class="flex flex-col gap-2">
      <SegmentedTabs
        items={props.items}
        value={value()}
        onChange={(next) => {
          if (next !== props.refuse) setValue(() => next);
        }}
        label={props.label}
        semantics={props.semantics}
        iconOnly={props.iconOnly}
        tipAttribute="data-tip"
        scroll={props.scroll}
        tabId={(v) => `lab-${props.label}-${v}`}
        panelId={() => `lab-${props.label}-panel`}
      />
      <Caption name="chosen" value={value()} />
    </div>
  );
}

/** The vendor portal's two views: `aria-current` buttons. */
export const TwoItems: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Panels theme={args.cireTheme}>
      {() => (
        <Working
          items={[
            { value: "listings", label: "Listings" },
            { value: "enquiries", label: "Enquiries" },
          ]}
          initial="listings"
          label="Views"
          semantics="current"
        />
      )}
    </Panels>
  ),
};

/** Six sections with their icons, a hidden one marked by its eye: a tablist. */
export const FiveItems: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Panels theme={args.cireTheme}>
      {() => (
        <Working
          items={[
            { value: "hero", label: "Hero" },
            {
              value: "story",
              label: "Our story",
              icon: EyeOff,
              name: "Our story, hidden from guests",
            },
            { value: "welcome", label: "Welcome" },
            { value: "events", label: "Events" },
            { value: "faq", label: "FAQ" },
          ]}
          initial="hero"
          label="Sections"
          semantics="tabs"
        />
      )}
    </Panels>
  ),
};

/** A module's views with their icons, and the same strip icon-only, as a narrow panel draws it. */
export const Icons: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => {
    const views = [
      { value: "households", label: "Households", icon: Rows },
      { value: "edit", label: "Edit", icon: Pencil },
      { value: "rsvps", label: "RSVPs", icon: Check },
    ];
    return (
      <Panels theme={args.cireTheme}>
        {() => (
          <>
            <Working items={views} initial="households" label="Views" semantics="tabs" />
            <Working items={views} initial="edit" label="Views (icons)" semantics="tabs" iconOnly />
          </>
        )}
      </Panels>
    );
  },
};

/** The edit modes: a radiogroup. Spreadsheet import is refused here, as an unsaved draft refuses it. */
export const Radio: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => (
    <Panels theme={args.cireTheme}>
      {() => (
        <Working
          items={[
            { value: "editor", label: "Web editor", icon: Pencil },
            { value: "import", label: "Spreadsheet import", icon: Sheet },
          ]}
          initial="editor"
          label="How do you want to edit?"
          semantics="radio"
          refuse="import"
        />
      )}
    </Panels>
  ),
};

/** An RSVP list's events with their counts and a "New" mark, scrolling sideways in a narrow box. */
export const Counts: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => {
    const count = (n: number) => (chosen: boolean) => (
      <span
        class={`font-ui-mono text-ui-xs ${chosen ? "text-ui-accent-ink" : "text-ui-ink-secondary"}`}
      >
        {n}
      </span>
    );
    const events = [
      { value: "mehndi", label: "Mehndi", after: count(84) },
      {
        value: "ceremony",
        label: "Ceremony",
        name: "Ceremony, 140 guests, changed since you last looked",
        after: (chosen: boolean) => (
          <>
            {count(140)(chosen)}
            <span class="text-ui-xs tracking-ui-wider text-ui-accent-ink uppercase">New</span>
          </>
        ),
      },
      { value: "reception", label: "Reception", after: count(212) },
      { value: "brunch", label: "Farewell brunch", after: count(36) },
    ];
    return (
      <Panels theme={args.cireTheme}>
        {() => (
          <div class="max-w-72">
            <Working items={events} initial="ceremony" label="Events" semantics="tabs" scroll />
          </div>
        )}
      </Panels>
    );
  },
};

/** A dot the colour of a reply, standing for its word. */
function dot(colour: string) {
  return (props: { class?: string; "aria-hidden"?: "true" }) => (
    <span
      aria-hidden={props["aria-hidden"]}
      class={`inline-block size-2.5 shrink-0 rounded-full ${props.class ?? ""}`}
      style={{ background: colour }}
    />
  );
}

/**
 * An RSVP list's reply filter: a radiogroup with a count after each word, then
 * the same strip as a phone draws it — the replies as their dots, "All" keeping
 * its word.
 */
export const Marks: Story<ThemeArgs> = {
  args: { cireTheme: "both" },
  controls: themeControl,
  render: (args) => {
    const count = (n: number) => (chosen: boolean) => (
      <span
        class={`font-ui-mono text-ui-xs ${chosen ? "text-ui-accent-ink" : "text-ui-ink-secondary"}`}
      >
        {n}
      </span>
    );
    const replies = (marks: boolean) => [
      { value: "all", label: "All", name: "All, 12 guests", after: count(12) },
      {
        value: "attending",
        label: "Attending",
        name: "Attending, 5 guests",
        icon: dot("#3f8f5a"),
        iconOnly: marks,
        after: count(5),
      },
      {
        value: "declined",
        label: "Declined",
        name: "Declined, 2 guests",
        icon: dot("#b23a3a"),
        iconOnly: marks,
        after: count(2),
      },
      {
        value: "maybe",
        label: "Maybe",
        name: "Maybe, 1 guest",
        icon: dot("#c9a46a"),
        iconOnly: marks,
        after: count(1),
      },
    ];
    return (
      <Panels theme={args.cireTheme}>
        {() => (
          <>
            <Working
              items={replies(false)}
              initial="attending"
              label="Filter by reply"
              semantics="radio"
              scroll
            />
            <Working
              items={replies(true)}
              initial="attending"
              label="Filter by reply (phone)"
              semantics="radio"
              scroll
            />
          </>
        )}
      </Panels>
    );
  },
};

import DietaryPresets from "@cire/ui/dietary-presets";
import { createSignal, For, type JSX } from "solid-js";

import { Eyebrow } from "../design-system/chrome.tsx";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/DietaryPresets", layout: "padded" as const };

/*
 * The dietary pills a guest ticks on the invite and an organiser in the reply
 * editor. A ticked pill wears `Button`'s `choice` look — a gold edge, the
 * readable gold word and a 2px ring — and an unticked one goes halfway under
 * the pointer. Tab to a pill to see the house outline 2px off its edge. Each
 * story shows both of cire's ramps; the lab loads no cire face.
 */

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

function BothRamps(props: { children: () => JSX.Element }) {
  return (
    <div class="flex flex-wrap items-start gap-6">
      <For each={["dark", "light"] as const}>
        {(theme) => <CirePanel theme={theme}>{props.children()}</CirePanel>}
      </For>
    </div>
  );
}

/** A picker with its own state, so a pill can be ticked and unticked by hand. */
function Picker(props: { initial: readonly string[]; wrap?: boolean }) {
  const [value, setValue] = createSignal<readonly string[]>(props.initial);
  return <DietaryPresets value={value()} onChange={setValue} wrap={props.wrap} />;
}

/** Wrapped, as the organiser's popover draws it: two ticked, the rest not. */
export const Wrapped = () => (
  <BothRamps>{() => <Picker initial={["vegan", "gluten"]} wrap />}</BothRamps>
);

/** The phone's sideways track, with room round each pill for its ring and focus outline. */
export const Scrolling = () => <BothRamps>{() => <Picker initial={["vegetarian"]} />}</BothRamps>;

/** Nothing ticked: every pill at rest. */
export const NoneTicked = () => <BothRamps>{() => <Picker initial={[]} wrap />}</BothRamps>;

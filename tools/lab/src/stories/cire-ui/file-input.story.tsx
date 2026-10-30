import FileInput from "@cire/ui/file-input";
import { For, type JSX } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Eyebrow } from "../design-system/chrome.tsx";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/FileInput", layout: "padded" as const };

/**
 * `FileInput`: a native file input whose button is the `quiet` pill at `md`
 * and 34px, the form-field height, with the file name in body ink beside it.
 * One story per state; each panel is cire's mapping in one theme.
 */

const THEMES = ["dark", "light"] as const satisfies readonly CireTheme[];

function CirePanel(props: { theme: CireTheme; children: JSX.Element }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-0 flex-1 basis-80 flex-col gap-5 border p-5"
      style={{ ...cireStyle(props.theme), "color-scheme": props.theme }}
      data-theme-panel={props.theme}
    >
      <Eyebrow>cire · {props.theme}</Eyebrow>
      {props.children}
    </div>
  );
}

/** The same picker in each of cire's themes, side by side. */
function BothThemes(props: { children: (theme: CireTheme) => JSX.Element }) {
  return (
    <div class="flex flex-wrap items-start gap-6">
      <For each={THEMES}>
        {(theme) => <CirePanel theme={theme}>{props.children(theme)}</CirePanel>}
      </For>
    </div>
  );
}

/** Puts a named file on the input, as a guest list chosen from disk would be. */
function withFile(input: HTMLInputElement, name: string) {
  // The lab's own test renders stories in a DOM shim with no `DataTransfer`.
  if (typeof DataTransfer === "undefined") return;
  const files = new DataTransfer();
  files.items.add(new File(["name,email\n"], name, { type: "text/csv" }));
  input.files = files.files;
}

/** Nothing chosen: the button and the browser's "no file" words. */
export const Empty = () => (
  <BothThemes>
    {(theme) => (
      <FileInput accept="image/jpeg,image/png,image/webp" aria-label={`Invite picture, ${theme}`} />
    )}
  </BothThemes>
);

/** A file chosen: its name beside the button, in body ink. */
export const FileChosen = () => (
  <BothThemes>
    {(theme) => (
      <FileInput
        accept=".csv,.xlsx"
        aria-label={`Guest list, ${theme}`}
        ref={(el) => queueMicrotask(() => withFile(el, "guests.csv"))}
      />
    )}
  </BothThemes>
);

interface FocusArgs extends StoryArgs {
  cireTheme: CireTheme;
}

/**
 * Keyboard focus: the house outline round the whole picker, since the button
 * inside it cannot take focus. One picker holds focus at a time, so this story
 * shows one theme; switch it in the panel.
 */
export const Focused: Story<FocusArgs> = {
  args: { cireTheme: "dark" },
  controls: { cireTheme: { kind: "select", options: THEMES } },
  render: (args) => (
    <CirePanel theme={args.cireTheme}>
      <FileInput
        accept=".csv,.xlsx"
        aria-label="Guest list"
        // `focusVisible` asks for the keyboard ring whatever the last input was.
        ref={(el) => queueMicrotask(() => el.focus({ focusVisible: true }))}
      />
    </CirePanel>
  ),
};

/** Disabled: the whole picker at 40%, and no pointer hover. */
export const Disabled = () => (
  <BothThemes>
    {(theme) => <FileInput accept="image/*" aria-label={`Gift picture, ${theme}`} disabled />}
  </BothThemes>
);

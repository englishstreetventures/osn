import FileInput from "@cire/ui/file-input";
import { For, type JSX } from "solid-js";

import { Eyebrow } from "../design-system/chrome.tsx";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/FileInput", layout: "padded" as const };

/**
 * `FileInput`: a native file input whose button is the `quiet` pill at `md`
 * and 34px, the form-field height, with the file name in body ink beside it.
 * Each panel is cire's mapping in one theme.
 */

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

/** Puts a named file on the input, as a guest list chosen from disk would be. */
function withFile(input: HTMLInputElement, name: string) {
  // The lab's own test renders stories in a DOM shim with no `DataTransfer`.
  if (typeof DataTransfer === "undefined") return;
  const files = new DataTransfer();
  files.items.add(new File(["name,email\n"], name, { type: "text/csv" }));
  input.files = files.files;
}

function PickerStates() {
  return (
    <div class="flex flex-col gap-4">
      <span class="text-ui-xs text-ui-ink-secondary">Empty</span>
      <FileInput accept="image/jpeg,image/png,image/webp" aria-label="Invite picture" />
      <span class="text-ui-xs text-ui-ink-secondary">A file chosen</span>
      <FileInput
        accept=".csv,.xlsx"
        aria-label="Guest list"
        ref={(el) => queueMicrotask(() => withFile(el, "guests.csv"))}
      />
      <span class="text-ui-xs text-ui-ink-secondary">
        Tab to one for its focus outline; disabled
      </span>
      <FileInput accept="image/*" aria-label="Gift picture" disabled />
    </div>
  );
}

/** Empty, with a file chosen, focusable and disabled, in both of cire's themes. */
export const States = () => (
  <div class="flex flex-wrap items-start gap-6">
    <For each={["dark", "light"] as const}>
      {(theme) => (
        <CirePanel theme={theme}>
          <PickerStates />
        </CirePanel>
      )}
    </For>
  </div>
);

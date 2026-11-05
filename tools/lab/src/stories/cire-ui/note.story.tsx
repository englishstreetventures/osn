import Note from "@cire/ui/note";
import type { NoticeSize } from "@shared/ui/ui/notice";
import { For, type JSX } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Eyebrow } from "../design-system/chrome.tsx";
import { type CireTheme, cireStyle } from "./cire-mapping.ts";

export const meta = { title: "cire/ui/Note", layout: "padded" as const };

/**
 * Cire's standing note: `Notice`'s accent tone led by a ✦, "Note" read in its
 * place. Placed only where the owner asks for one. Each story shows both of
 * cire's ramps.
 */

const WORDS =
  "Preview — try the RSVP as a guest would. Nothing you send here is saved, and the couple sees nothing.";

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

/** The default: the compact box, for a note beside a control or in a sidebar. */
export const Small = () => <BothRamps>{() => <Note>{WORDS}</Note>}</BothRamps>;

/** No box: the star, the word and the line, in readable gold. */
export const Inline = () => (
  <BothRamps>
    {() => <Note size="inline">Adjusted to stay readable: body text, buttons.</Note>}
  </BothRamps>
);

/** The page-level box, `Notice`'s default size. */
export const Medium = () => (
  <BothRamps>
    {() => (
      <Note size="md">
        Every event is shown in preview; try the RSVP, nothing you send is saved.
      </Note>
    )}
  </BothRamps>
);

interface NoteArgs extends StoryArgs {
  size: NoticeSize;
  alert: boolean;
  body: string;
}

export const Playground: Story<NoteArgs> = {
  args: { size: "sm", alert: false, body: WORDS },
  controls: { size: { kind: "select", options: ["inline", "sm", "md"] } },
  render: (args) => (
    <BothRamps>
      {() => (
        <Note size={args.size} alert={args.alert}>
          {args.body}
        </Note>
      )}
    </BothRamps>
  ),
};

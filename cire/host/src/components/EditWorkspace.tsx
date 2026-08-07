import type { JSX } from "solid-js";
import { createSignal, createUniqueId, For, Show } from "solid-js";

import { haptic } from "../lib/haptics";
import { confirmNavigation } from "../lib/unsaved-guard";
import ImportPanel, { type ImportKind } from "./ImportPanel";

/** The two ways to change this module's data. */
type EditMode = "editor" | "import";

const MODES: { id: EditMode; label: string; hint: string }[] = [
  { id: "editor", label: "Web editor", hint: "Edit here, row by row" },
  { id: "import", label: "Spreadsheet import", hint: "Upload a CSV and preview the diff" },
];

/**
 * A module's Edit sub-tab: the same data, two ways in — the on-page editor, or a
 * CSV upload. They are the same job (this module's rows, previewed as a diff,
 * applied in one write), so they belong behind one choice rather than in two
 * different corners of the portal. Import used to sit above the guest list on the
 * Guests module's READ tab and carried BOTH sheets, which is how the events
 * import ended up somewhere an organiser editing the schedule would never look.
 *
 * The editor is the default: it needs no file, no template, and no format guide.
 *
 * Switching to import UNMOUNTS the editor, so an unsaved draft would go with it —
 * hence {@link confirmNavigation}, the same guard the module rail asks before it
 * swaps a dirty write surface out. The editor registers its dirty-check while
 * mounted, so a clean draft switches silently.
 *
 * `editor` is a function, not a slot: rendering it eagerly would mount (and,
 * being lazy, fetch) the editor chunk even when the organiser lands straight in
 * import mode.
 */
export default function EditWorkspace(props: {
  weddingId: string;
  kind: ImportKind;
  editor: () => JSX.Element;
}) {
  const [mode, setMode] = createSignal<EditMode>("editor");
  const baseId = createUniqueId();
  const hintId = (id: EditMode) => `${baseId}-${id}-hint`;

  function choose(next: EditMode) {
    if (next === mode()) return;
    // Leaving the editor with unsaved work is a real loss (the draft is local
    // until Apply), so it gets the same "are you sure" a module switch does.
    if (
      mode() === "editor" &&
      !confirmNavigation("You have unsaved changes. Leave without saving?")
    )
      return;
    haptic("step");
    setMode(next);
  }

  return (
    <div class="flex flex-col gap-6">
      {/* A radiogroup, not a tablist: the two panels below are alternative ways
          to do one job rather than two views of one thing, and the shell already
          owns the tablist above this. Arrow keys come free with the native radio
          semantics of a `role="radio"` group only if we wire them, so the labels
          stay real buttons and each is its own tab stop — a two-item group is
          under the threshold where roving focus earns its complexity. */}
      <div
        role="radiogroup"
        aria-label="How do you want to edit?"
        class="border-border bg-surface/30 flex flex-wrap gap-1 self-start rounded-sm border p-1"
      >
        <For each={MODES}>
          {(m) => (
            <button
              type="button"
              /* `aria-describedby`, not `title` (C-L1). A `title` tooltip needs a
                 hover: it is unreachable on touch, unreachable by keyboard, and
                 announced inconsistently by AT — so the only sentence explaining
                 what the two modes actually DO was missing for exactly the users
                 who can't infer it from a two-word label. The hint is visible
                 text below the group now, and each control points at its own. */
              aria-describedby={hintId(m.id)}
              /* A real <input type="radio"> would be the tag for this, and the
                 lint rule is right in general. Not here: choosing a mode can be
                 REFUSED (an unsaved draft, confirm declined), and a native radio
                 has already moved its own checked state by the time the handler
                 runs — leaving the dot on a mode the panel didn't switch to,
                 with no signal change to re-render it back. `aria-checked` is
                 derived from the signal, so a refusal simply never moves it. */
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
              role="radio"
              aria-checked={mode() === m.id}
              onClick={() => choose(m.id)}
              class="font-body relative flex items-center gap-2 rounded-sm px-3.5 py-1.5 text-[0.74rem] tracking-[0.12em] whitespace-nowrap uppercase transition-colors duration-(--dur-fast) ease-(--ease-out)"
              classList={{
                "bg-gold/12 text-gold": mode() === m.id,
                "text-text-muted hover:text-text hover:bg-surface/60": mode() !== m.id,
              }}
            >
              {m.label}
            </button>
          )}
        </For>
      </div>

      {/* The hints, as real text. Only the active one is shown — both would be a
          paragraph of chrome above every edit surface — but BOTH ids exist for
          `aria-describedby` to point at, and a description an AT can't resolve is
          the same as no description. The inactive one is `hidden`, which keeps it
          out of the accessibility tree while staying resolvable by id. */}
      <For each={MODES}>
        {(m) => (
          <p
            id={hintId(m.id)}
            hidden={mode() !== m.id}
            class="font-body text-text-muted -mt-3 text-[0.8rem]"
          >
            {m.hint}
          </p>
        )}
      </For>

      <Show when={mode() === "editor"}>{props.editor()}</Show>
      <Show when={mode() === "import"}>
        <ImportPanel weddingId={props.weddingId} kind={props.kind} />
      </Show>
    </div>
  );
}

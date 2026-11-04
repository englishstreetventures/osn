import SegmentedTabs from "@cire/ui/segmented-tabs";
import FileSpreadsheet from "lucide-solid/icons/file-spreadsheet";
import TableProperties from "lucide-solid/icons/table-properties";
import type { Component, JSX } from "solid-js";
import { createSignal, createUniqueId, For, lazy, Show, Suspense } from "solid-js";

import { haptic } from "../lib/touch-feedback";
import { confirmNavigation } from "../lib/unsaved-guard";
import type { ImportKind } from "./ImportPanel";
import PanelLoading from "./PanelLoading";
import { createCompact, ViewBar } from "./ViewBar";

/** Split out of the eager portal bundle: ~900 lines dragging in `ChangeHistory`,
 *  `ChangePreview` and `import-templates` for a surface two clicks deep that
 *  most organisers never open. Warmed on intent — see the radio button below. */
const loadImportPanel = () => import("./ImportPanel");
const ImportPanel = lazy(loadImportPanel);

function warmImportPanel(): void {
  // Fire and forget, same as `warmPanel` in ModuleShell.tsx: a failed prefetch
  // just means the real mount pays the cost it would have paid anyway.
  void loadImportPanel().catch(() => {});
}

/** The two ways to change this module's data. */
type EditMode = "editor" | "import";

const MODES: {
  id: EditMode;
  label: string;
  hint: string;
  icon: Component<{ class?: string; strokeWidth?: number; "aria-hidden"?: "true" }>;
}[] = [
  { id: "editor", label: "Web editor", hint: "Edit here, row by row", icon: TableProperties },
  {
    id: "import",
    label: "Spreadsheet import",
    hint: "Upload a CSV and preview the diff",
    icon: FileSpreadsheet,
  },
];

/** Below this panel width the switch shows its icons alone, the label each
 *  one's tooltip and name — the same line as the shell's sub-tabs. */
const NARROW_BAR_REM = 36;

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
  /** True for an owner: the import offers the current rows as a download. */
  canManage?: boolean;
  /** Drawn alone, outside the module shell: whether the switch shows its
   *  icons alone. Inside the shell the panel's width decides. */
  compact?: boolean;
}) {
  const [mode, setMode] = createSignal<EditMode>("editor");
  const { compact } = createCompact(
    () => NARROW_BAR_REM,
    () => props.compact ?? false,
  );
  const baseId = createUniqueId();
  const hintId = (id: EditMode) => `${baseId}-${id}-hint`;

  function choose(next: EditMode) {
    if (next === mode()) return;
    // Leaving the editor with unsaved work is a real loss (the draft is local
    // until Apply), so it gets the same "are you sure" a module switch does.
    if (
      mode() === "editor" &&
      !confirmNavigation({ message: "You have unsaved changes. Leave without saving?" })
    )
      return;
    haptic("step");
    setMode(next);
  }

  return (
    <div class="flex flex-col gap-6">
      {/* The switch sits in the module's view bar, so the way back to the
          other mode is to hand however far down the list the host is.

          A radiogroup, not a tablist: the two panels below are alternative
          ways to do one job rather than two views of one thing, and the shell
          already owns the tablist beside this. Arrow keys come free with the
          native radio semantics of a `role="radio"` group only if we wire them,
          so the labels stay real buttons and each is its own tab stop — a
          two-item group is under the threshold where roving focus earns its
          complexity. */}
      <ViewBar slot="end">
        {/* A hairline sets the mode switch apart from the module's sections
            beside it: two segmented controls, two groups. */}
        <span data-bar-divider aria-hidden="true" class="bg-border h-5 w-px shrink-0" />
        {/* A refused choice (an unsaved draft, confirm declined) never shows
            as made: `aria-checked` follows `mode()`, which `choose` leaves. */}
        <SegmentedTabs
          items={MODES.map((m) => ({
            value: m.id,
            label: m.label,
            icon: m.icon,
            /* The hint is visible text under the bar, and each control points
               at its own: a `title` needs a hover, which touch and the
               keyboard never give. */
            describedBy: hintId(m.id),
          }))}
          value={mode()}
          onChange={choose}
          label="How do you want to edit?"
          semantics="radio"
          iconOnly={compact()}
          tipAttribute="data-tip"
          onIntent={(id) => {
            if (id === "import") warmImportPanel();
          }}
          class="shrink-0"
        />
      </ViewBar>

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
            class="font-body text-text-muted text-ui-sm"
          >
            {m.hint}
          </p>
        )}
      </For>

      <Show when={mode() === "editor"}>{props.editor()}</Show>
      <Show when={mode() === "import"}>
        <Suspense fallback={<PanelLoading />}>
          <ImportPanel weddingId={props.weddingId} kind={props.kind} canManage={props.canManage} />
        </Suspense>
      </Show>
    </div>
  );
}

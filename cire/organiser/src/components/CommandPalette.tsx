import { Dialog } from "@kobalte/core/dialog";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import type { Module } from "../lib/dashboard-route";
import { haptic } from "../lib/haptics";
import { MODULE_NAV } from "../lib/module-nav";
import { setThemePreference, theme } from "../lib/theme";
import type { WeddingSummary } from "./CreateWeddingForm";

/** One runnable row. `group` is the heading it sits under; `keywords` widen the
 *  match without widening the label (a host who types "rsvp" should find
 *  Guests). */
interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  glyph: string;
  keywords: string;
  run: () => void;
}

const OPTION_ID = (index: number) => `cmdk-option-${index}`;

function matches(command: Command, query: string): boolean {
  if (!query) return true;
  const haystack = `${command.label} ${command.hint ?? ""} ${command.keywords} ${command.group}`;
  return haystack.toLowerCase().includes(query.toLowerCase());
}

/**
 * ⌘K — the portal's keyboard route to anywhere.
 *
 * The rail and the switcher are the pointer paths; this is the one that doesn't
 * care where you are. Every destination the chrome offers is reachable from it,
 * which is what lets the chrome itself stay one row tall: an affordance that
 * would otherwise need a permanent button can live here instead.
 *
 * Built as a `combobox` over a `listbox` rather than as a menu, because the
 * input filters rather than types-ahead: the list is the result set, and
 * `aria-activedescendant` keeps focus in the field while the highlight moves.
 * Kobalte's dialog supplies the focus trap, escape-to-close, scroll lock and
 * focus restoration.
 *
 * The ⌘K binding lives here rather than in the shell so the shortcut and the
 * surface it opens can never disagree about whether the palette exists.
 */
export default function CommandPalette(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The open wedding, or null on the list / security views — the "Go to"
   *  group only exists once there is a wedding to go into. */
  wedding: WeddingSummary | null;
  weddings: WeddingSummary[];
  onModule: (module: Module) => void;
  onWedding: (wedding: WeddingSummary) => void;
  onAll: () => void;
  onSecurity: () => void;
  onSignOut: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let listRef: HTMLUListElement | undefined;

  // Memos rather than plain accessors, and not for the arithmetic — the list is
  // a dozen rows and filtering it is free. It is for identity: `<For>`
  // reconciles by reference, so a fresh array of fresh objects on every read
  // would tear down and rebuild every row and heading on each keystroke rather
  // than reordering them.
  const commands = createMemo((): Command[] => {
    const list: Command[] = [];

    const wedding = props.wedding;
    if (wedding) {
      for (const mod of MODULE_NAV) {
        list.push({
          id: `module:${mod.id}`,
          group: "Go to",
          label: mod.label,
          hint: mod.hint,
          glyph: mod.glyph,
          keywords: mod.hint,
          run: () => props.onModule(mod.id),
        });
      }
    }

    for (const other of props.weddings) {
      if (wedding && other.id === wedding.id) continue;
      list.push({
        id: `wedding:${other.id}`,
        group: "Weddings",
        label: other.displayName,
        hint: other.slug,
        glyph: "❦",
        keywords: other.slug,
        run: () => props.onWedding(other),
      });
    }
    list.push({
      id: "weddings:all",
      group: "Weddings",
      label: "All weddings",
      glyph: "☰",
      keywords: "list home back",
      run: () => props.onAll(),
    });

    list.push(
      {
        id: "account:theme",
        group: "Account",
        // Named for what pressing it does, not for the state it reports.
        label: theme() === "dark" ? "Switch to light theme" : "Switch to dark theme",
        glyph: theme() === "dark" ? "☀" : "☾",
        keywords: "theme dark light appearance mode",
        run: () => setThemePreference(theme() === "dark" ? "light" : "dark"),
      },
      {
        id: "account:security",
        group: "Account",
        label: "Security & passkeys",
        glyph: "⚿",
        keywords: "passkey password sessions devices recovery",
        run: () => props.onSecurity(),
      },
      {
        id: "account:signout",
        group: "Account",
        label: "Sign out",
        glyph: "⏻",
        keywords: "log out leave",
        run: () => props.onSignOut(),
      },
    );

    return list;
  });

  const results = createMemo(() => commands().filter((command) => matches(command, query())));

  /** The heading a row sits under, or null when the row above shares it — the
   *  list is already grouped by construction, so a change of group is the
   *  whole test. */
  const heading = (index: number) => {
    const rows = results();
    const row = rows[index];
    if (!row) return null;
    return index === 0 || rows[index - 1]!.group !== row.group ? row.group : null;
  };

  function close() {
    haptic("dismiss");
    props.onOpenChange(false);
  }

  function run(index: number) {
    const command = results()[index];
    if (!command) return;
    // Close first: the command navigates, and a dialog still trapping focus
    // while the view behind it swaps is how focus ends up on `<body>`.
    props.onOpenChange(false);
    command.run();
  }

  function onKeyDown(event: KeyboardEvent) {
    const rows = results();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (rows.length === 0 ? 0 : (index + 1) % rows.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (rows.length === 0 ? 0 : (index - 1 + rows.length) % rows.length));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, rows.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(active());
    }
  }

  // Every open starts from an empty query at the top of the list. A palette
  // that reopens holding the last search is a palette you have to clear before
  // you can use it.
  createEffect(() => {
    if (props.open) {
      setQuery("");
      setActive(0);
    }
  });

  // Keep the highlight in range as the result set shrinks under the query.
  // Gated on `open` so a theme change or a refreshed wedding list doesn't run it
  // against a palette nobody is looking at.
  createEffect(() => {
    if (!props.open) return;
    const count = results().length;
    if (active() >= count) setActive(Math.max(0, count - 1));
  });

  // Follow the highlight with the scroll, so arrowing past the fold works.
  createEffect(() => {
    const index = active();
    if (!props.open || !listRef) return;
    listRef.querySelector(`#${OPTION_ID(index)}`)?.scrollIntoView({ block: "nearest" });
  });

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (next) props.onOpenChange(true);
        else close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="sheet-scrim bg-bg/70 fixed inset-0 z-40 backdrop-blur-[2px]" />
        <div class="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
          <Dialog.Content class="sheet-panel border-border bg-surface flex w-full max-w-lg flex-col overflow-hidden rounded-md border shadow-(--elev-2) outline-none">
            <Dialog.Title class="sr-only">Command palette</Dialog.Title>

            <div class="border-border flex items-center gap-3 border-b px-4">
              <span aria-hidden="true" class="text-gold shrink-0 text-[0.9rem]">
                ⌘
              </span>
              <input
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls="cmdk-list"
                aria-activedescendant={results().length > 0 ? OPTION_ID(active()) : undefined}
                aria-label="Search commands"
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                placeholder="Jump to…"
                value={query()}
                onInput={(event) => {
                  setQuery(event.currentTarget.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                class="font-body text-text placeholder:text-text-faint min-w-0 flex-1 bg-transparent py-3.5 text-[0.95rem] outline-none"
              />
              <kbd class="font-body text-text-faint border-border hidden shrink-0 rounded-sm border px-1.5 py-0.5 text-[0.6rem] tracking-[0.1em] uppercase sm:block">
                Esc
              </kbd>
            </div>

            <ul
              ref={listRef}
              id="cmdk-list"
              role="listbox"
              aria-label="Commands"
              class="flex max-h-[min(22rem,52vh)] min-h-0 flex-col overflow-y-auto p-1.5"
            >
              <For each={results()}>
                {(command, index) => (
                  <>
                    <Show when={heading(index())}>
                      {(group) => (
                        <li
                          role="presentation"
                          class="font-body text-text-faint px-3 pt-2.5 pb-1.5 text-[0.6rem] tracking-[0.18em] uppercase"
                        >
                          {group()}
                        </li>
                      )}
                    </Show>
                    <li
                      id={OPTION_ID(index())}
                      role="option"
                      aria-selected={active() === index()}
                      onPointerMove={() => setActive(index())}
                      onClick={() => run(index())}
                      class={`font-body flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2 transition-colors duration-(--dur-fast) ${
                        active() === index() ? "bg-gold/10 text-gold" : "text-text-muted"
                      }`}
                    >
                      <span aria-hidden="true" class="w-4 shrink-0 text-center text-[0.9em]">
                        {command.glyph}
                      </span>
                      <span class="min-w-0 flex-1 truncate text-[0.85rem]">{command.label}</span>
                      <Show when={command.hint}>
                        {(hint) => (
                          <span class="text-text-faint hidden max-w-[45%] shrink-0 truncate text-[0.7rem] sm:block">
                            {hint()}
                          </span>
                        )}
                      </Show>
                    </li>
                  </>
                )}
              </For>

              <Show when={results().length === 0}>
                <li
                  role="presentation"
                  class="font-body text-text-muted px-3 py-6 text-center text-[0.82rem]"
                >
                  Nothing matches “{query()}”.
                </li>
              </Show>
            </ul>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}

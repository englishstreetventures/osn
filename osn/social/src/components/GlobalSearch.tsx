import { clsx } from "@osn/ui/lib/utils";
import { Input } from "@osn/ui/ui/input";
import { useNavigate } from "@solidjs/router";
import { createSignal, For, Show } from "solid-js";

import { createSearchController, type SearchRow } from "../lib/search";
import { OrganisationRow, PersonRow, useSearchActions } from "./SearchResultRows";

const LISTBOX_ID = "global-search-results";
const optionId = (index: number) => `global-search-option-${index}`;

/**
 * The accessible name for an option. Because the option itself is the
 * activation target, the name has to carry what activating it will do —
 * otherwise a screen-reader user hears a name with no affordance.
 */
function optionLabel(row: SearchRow): string {
  if (row.kind === "organisation") {
    const { name, handle, isMember } = row.organisation;
    return `${name}, @${handle}${isMember ? ", member" : ""}, open organisation`;
  }
  const { handle, displayName, connectionStatus } = row.person;
  const who = displayName ? `${displayName}, @${handle}` : `@${handle}`;
  switch (connectionStatus) {
    case "connected":
      return `${who}, already connected`;
    case "pending_sent":
      return `${who}, request already sent`;
    case "pending_received":
      return `${who}, accept connection request`;
    default:
      return `${who}, send connection request`;
  }
}

/**
 * The shell search bar: a live combobox in the desktop rail. People and
 * organisations come back in one request and render as one flat listbox
 * (people first, then organisations) so arrow keys walk the whole result set.
 * The dropdown deliberately carries no section headings — a listbox may only
 * contain options, and org rows are already distinguishable by their squared
 * avatar. The `/search` page, which has room, does group them.
 *
 * Mobile doesn't mount this: search there is a bottom-nav destination
 * (`/search`), thumb-reachable in a way a header field is not. Both surfaces
 * share `createSearchController`, so debounce, abort and the optimistic status
 * overrides behave identically.
 */
export function GlobalSearch(props: { token: string }) {
  const navigate = useNavigate();
  const controller = createSearchController(() => props.token, { limit: 6, orgLimit: 3 });
  const actions = useSearchActions(() => props.token, controller);

  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(-1);

  const rows = () => controller.flat();
  const showPanel = () => open() && !controller.tooShort();

  function close() {
    setOpen(false);
    setActiveIndex(-1);
  }

  function onKeyDown(event: KeyboardEvent) {
    const list = rows();
    if (event.key === "Escape") {
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (list.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const last = list.length - 1;
      // -1 means "nothing active yet". Both directions wrap, so ArrowUp from
      // the bare field jumps to the last result — the usual combobox affordance.
      setActiveIndex((current) =>
        event.key === "ArrowDown"
          ? current < 0 || current === last
            ? 0
            : current + 1
          : current <= 0
            ? last
            : current - 1,
      );
      return;
    }
    if (event.key === "Enter") {
      const row = list[activeIndex()];
      if (!row) return;
      event.preventDefault();
      activate(row);
    }
  }

  /**
   * Activating an option — by Enter or by click. A person's option connects (or
   * accepts, when they asked first); an organisation's option navigates.
   */
  function activate(row: SearchRow) {
    if (row.kind === "person") {
      actions.activate(row.person);
    } else {
      close();
      navigate(`/organisations/${row.organisation.handle}`);
    }
  }

  return (
    <div
      class="relative px-3 pt-3"
      onFocusIn={() => setOpen(true)}
      onFocusOut={(event) => {
        // Only close when focus actually leaves the combobox — clicking a
        // result button must not tear the panel down before the click lands.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      <label class="sr-only" for="global-search-input">
        Search people and organisations
      </label>
      <div class="relative">
        <span
          class="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm"
          aria-hidden="true"
        >
          @
        </span>
        <Input
          id="global-search-input"
          type="search"
          autocomplete="off"
          placeholder="Search"
          class="rounded-pill h-9 pl-7"
          role="combobox"
          aria-expanded={showPanel()}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex() >= 0 ? optionId(activeIndex()) : undefined}
          value={controller.query()}
          onInput={(event) => {
            controller.setQuery(event.currentTarget.value);
            setActiveIndex(-1);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      <Show when={showPanel()}>
        <div class="border-border bg-background rounded-card absolute top-14 right-3 left-3 z-30 border p-1 shadow-lg">
          {/* The status line lives outside the listbox: a listbox may only
              contain options, so "Searching…" can't be a child of the <ul>. */}
          <Show when={rows().length === 0}>
            <p class="text-muted-foreground text-body px-3 py-4 text-center" aria-live="polite">
              {controller.failed()
                ? "Search is unavailable right now. Try again in a moment."
                : controller.loading()
                  ? "Searching…"
                  : `No results for "${controller.submitted()}"`}
            </p>
          </Show>
          {/* Options carry no nested button or link. An ARIA listbox owns
              activation through virtual focus (`aria-activedescendant` + Enter),
              and assistive tech flattens an option to its accessible name — so
              a nested control is announced as text and cannot be operated. The
              whole row is the activation target instead, for pointer and
              keyboard alike, and the trailing Connect / Accept text is a
              non-interactive affordance label. The `/search` page, which is a
              plain list rather than a combobox, keeps real buttons. */}
          <ul id={LISTBOX_ID} role="listbox" aria-label="Search results">
            <For each={rows()}>
              {(row, index) => (
                <li
                  id={optionId(index())}
                  role="option"
                  aria-selected={activeIndex() === index()}
                  aria-label={optionLabel(row)}
                  class={clsx(
                    "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2",
                    activeIndex() === index() && "bg-muted/60",
                  )}
                  onMouseEnter={() => setActiveIndex(index())}
                  onClick={() => activate(row)}
                >
                  <Show
                    when={row.kind === "person" ? row.person : null}
                    fallback={
                      <Show when={row.kind === "organisation" ? row.organisation : null}>
                        {(organisation) => <OrganisationRow organisation={organisation()} />}
                      </Show>
                    }
                  >
                    {(person) => (
                      <PersonRow
                        person={person()}
                        controller={controller}
                        actions={actions}
                        interactive={false}
                      />
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  );
}

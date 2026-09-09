import { useAuth } from "@osn/client/solid";
import { Input } from "@osn/ui/ui/input";
import { For, onMount, Show } from "solid-js";

import { OrganisationLink, PersonRow, useSearchActions } from "../components/SearchResultRows";
import { createSearchController } from "../lib/search";

/**
 * The full-page search surface, and the mobile shell's Search tab. Desktop
 * reaches search through the rail's live combobox instead, but this route
 * stays available at any width — a page is the better home for a long result
 * list, and it is linkable.
 *
 * Unlike the rail dropdown this is not a combobox: results are ordinary page
 * content under section headings, so there is no virtual focus to manage and
 * no listbox purity constraint on the markup.
 */
export function SearchPage() {
  const { session } = useAuth();
  const token = () => session()?.accessToken ?? "";

  const controller = createSearchController(token, { limit: 15, orgLimit: 8 });
  const actions = useSearchActions(token, controller);

  let inputRef: HTMLInputElement | undefined;
  // The tab exists to search, so the keyboard should already be up on arrival.
  onMount(() => inputRef?.focus());

  const hasResults = () => controller.people().length > 0 || controller.organisations().length > 0;

  return (
    <main class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
      <h1 class="text-foreground text-display mb-4 font-medium">Search</h1>

      <Show
        when={session()}
        fallback={
          <div class="text-muted-foreground border-border rounded-card text-body border border-dashed py-16 text-center">
            Sign in to search people and organisations.
          </div>
        }
      >
        <div class="relative mb-6">
          <label class="sr-only" for="search-page-input">
            Search people and organisations
          </label>
          <span
            class="text-muted-foreground pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-sm"
            aria-hidden="true"
          >
            @
          </span>
          <Input
            ref={inputRef}
            id="search-page-input"
            type="search"
            autocomplete="off"
            placeholder="Search by name or @handle"
            class="rounded-pill h-11 pl-8"
            value={controller.query()}
            onInput={(event) => controller.setQuery(event.currentTarget.value)}
          />
        </div>

        <Show
          when={!controller.tooShort()}
          fallback={
            <p class="text-muted-foreground text-body py-12 text-center">
              Start typing to find people and organisations.
            </p>
          }
        >
          <Show
            when={hasResults()}
            fallback={
              <p class="text-muted-foreground text-body py-12 text-center" aria-live="polite">
                {controller.failed()
                  ? "Search is unavailable right now. Try again in a moment."
                  : controller.loading()
                    ? "Searching…"
                    : `No results for "${controller.submitted()}"`}
              </p>
            }
          >
            <Show when={controller.people().length > 0}>
              <h2 class="text-subtle text-meta mb-1 px-3">People</h2>
              <ul class="mb-6 flex flex-col gap-0.5">
                <For each={controller.people()}>
                  {(person) => (
                    <li class="hover:bg-muted/50 active:bg-muted/50 flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors">
                      <PersonRow person={person} controller={controller} actions={actions} />
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            <Show when={controller.organisations().length > 0}>
              <h2 class="text-subtle text-meta mb-1 px-3">Organisations</h2>
              <ul class="flex flex-col gap-0.5">
                <For each={controller.organisations()}>
                  {(organisation) => (
                    <li>
                      <OrganisationLink
                        organisation={organisation}
                        class="hover:bg-muted/50 active:bg-muted/50 flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors"
                      />
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </Show>
    </main>
  );
}

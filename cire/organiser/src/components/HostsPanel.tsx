import { useAuth } from "@osn/client/solid";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import SectionIntro from "./SectionIntro";

interface HostRow {
  osnProfileId: string;
  /** Present only on a freshly-added host (the add response echoes the handle);
   *  the list endpoint returns ids only, so existing rows show the id. */
  handle?: string;
  role: "host";
  createdAt: number;
}

/** One autocomplete suggestion from `GET /api/organiser/handle-search`. */
interface HandleSuggestion {
  profileId: string;
  handle: string;
  displayName: string | null;
}

/** Debounce window (ms) before a typed prefix triggers a handle-search fetch. */
const SEARCH_DEBOUNCE_MS = 280;
/** Minimum prefix length before we bother the search endpoint (osn-api also floors at 2). */
const MIN_SEARCH_LEN = 2;
/** Stable DOM id for the suggestion listbox (aria-controls target). */
const LISTBOX_ID = "host-handle-suggestions";
/** Per-option DOM id, referenced by aria-activedescendant for keyboard nav. */
const optionId = (i: number) => `host-handle-option-${i}`;

interface HostsPanelProps {
  weddingId: string;
  /** True when the signed-in organiser owns this wedding. Owners can add/remove
   *  co-hosts; co-hosts see the list read-only. */
  canManage: boolean;
}

/**
 * Hosts section of a wedding's dashboard. Lists the wedding's co-hosts and — for
 * the owner — lets them add another organiser by OSN handle or remove one. A
 * co-host gets access to this wedding's dashboard; only the owner manages the
 * list.
 */
export default function HostsPanel(props: HostsPanelProps) {
  const { authFetch } = useAuth();
  const [hosts, setHosts] = createSignal<HostRow[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [handle, setHandle] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [addError, setAddError] = createSignal<string | null>(null);

  // --- Handle autocomplete state ---------------------------------------------
  const [suggestions, setSuggestions] = createSignal<HandleSuggestion[]>([]);
  const [open, setOpen] = createSignal(false);
  // Index of the keyboard-highlighted suggestion; -1 = none highlighted.
  const [activeIdx, setActiveIdx] = createSignal(-1);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  // Monotonic request id so a slow earlier fetch can't clobber a newer result.
  let searchSeq = 0;

  const endpoint = () => apiUrl(`/api/organiser/weddings/${props.weddingId}/hosts`);

  onCleanup(() => clearTimeout(debounceTimer));

  function closeSuggestions() {
    setOpen(false);
    setActiveIdx(-1);
  }

  /** Fetch handle suggestions for the current input, debounced + race-safe. */
  async function runSearch(raw: string) {
    const q = raw.trim();
    const normalised = q.startsWith("@") ? q.slice(1) : q;
    if (normalised.length < MIN_SEARCH_LEN) {
      setSuggestions([]);
      closeSuggestions();
      return;
    }
    const seq = ++searchSeq;
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/handle-search?q=${encodeURIComponent(q)}`),
      );
      // A newer keystroke already superseded this request — drop the result.
      if (seq !== searchSeq) return;
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        // FAIL-SOFT: a search outage must never block manual typing.
        setSuggestions([]);
        closeSuggestions();
        return;
      }
      const body = (await res.json()) as { profiles?: HandleSuggestion[] };
      const list = Array.isArray(body.profiles) ? body.profiles : [];
      setSuggestions(list);
      setActiveIdx(-1);
      setOpen(list.length > 0);
    } catch (err) {
      if (seq !== searchSeq) return;
      if (isAuthExpired(err)) return redirectToLogin();
      // Network blip — fail soft, keep the manual path usable.
      setSuggestions([]);
      closeSuggestions();
    }
  }

  function onHandleInput(value: string) {
    setHandle(value);
    setAddError(null);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runSearch(value), SEARCH_DEBOUNCE_MS);
  }

  /** Pick a suggestion: fill the input with its handle and close the list. */
  function pick(s: HandleSuggestion) {
    setHandle(`@${s.handle}`);
    setSuggestions([]);
    closeSuggestions();
  }

  function onHandleKeyDown(e: KeyboardEvent) {
    if (!open() || suggestions().length === 0) {
      // ArrowDown re-opens the list if we have stale suggestions to show.
      if (e.key === "ArrowDown" && suggestions().length > 0) {
        e.preventDefault();
        setOpen(true);
        setActiveIdx(0);
      }
      return;
    }
    const last = suggestions().length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIdx((i) => (i >= last ? 0 : i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIdx((i) => (i <= 0 ? last : i - 1));
        break;
      case "Enter": {
        const i = activeIdx();
        if (i >= 0 && i <= last) {
          // Choosing a suggestion shouldn't also submit the add form.
          e.preventDefault();
          pick(suggestions()[i]!);
        }
        break;
      }
      case "Escape":
        e.preventDefault();
        closeSuggestions();
        break;
    }
  }

  onMount(async () => {
    try {
      const res = await authFetch(endpoint());
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error("Failed to load");
      const body = (await res.json()) as { hosts: HostRow[] };
      setHosts(body.hosts);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Could not load hosts. Is the API running?");
    } finally {
      setLoading(false);
    }
  });

  async function add(e: Event) {
    e.preventDefault();
    const value = handle().trim();
    if (!value) {
      setAddError("Enter an OSN handle, like @alice.");
      return;
    }
    setAddError(null);
    setAdding(true);
    closeSuggestions();
    try {
      const res = await authFetch(endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: value }),
      });
      if (res.status === 401) return redirectToLogin();
      if (res.status === 404) {
        setAddError(`No OSN account found for ${value.startsWith("@") ? value : `@${value}`}.`);
        return;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setAddError(
          body.error === "owner_is_host"
            ? "You already host this wedding as its owner."
            : "That person is already a host.",
        );
        return;
      }
      if (res.status === 503) {
        setAddError("Adding hosts isn't available on this deployment yet.");
        return;
      }
      if (!res.ok) {
        setAddError("Could not add that host. Please try again.");
        return;
      }
      const body = (await res.json()) as { host: HostRow };
      setHosts((prev) => [...prev, body.host]);
      setHandle("");
      setSuggestions([]);
      toast.success(`Added ${body.host.handle ? `@${body.host.handle}` : "host"} as a host.`);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setAddError("Could not add that host. Is the API running?");
    } finally {
      setAdding(false);
    }
  }

  async function remove(host: HostRow) {
    const label = host.handle ? `@${host.handle}` : host.osnProfileId;
    try {
      const res = await authFetch(`${endpoint()}/${encodeURIComponent(host.osnProfileId)}`, {
        method: "DELETE",
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error("Could not remove that host. Please try again.");
        return;
      }
      setHosts((prev) => prev.filter((h) => h.osnProfileId !== host.osnProfileId));
      toast.success(`Removed ${label}.`);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      toast.error("Could not remove that host. Is the API running?");
    }
  }

  return (
    <div class="flex flex-col gap-8">
      <SectionIntro
        eyebrow="Co-hosts"
        title="Share this wedding's dashboard"
        description={
          props.canManage
            ? "Invite a partner or planner to help. Add them by their OSN handle — co-hosts can view and edit everything here, but only you, the owner, can manage who hosts it."
            : "These organisers can view and edit this wedding. The owner manages who's on this list."
        }
      />

      <Show when={props.canManage}>
        <form class="flex flex-col gap-3" onSubmit={add}>
          <div class="flex flex-col gap-1.5">
            <label
              for="host-handle"
              class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase"
            >
              OSN handle
            </label>
            <div class="flex flex-wrap items-center gap-3">
              {/* Combobox: a text input that suggests matching OSN profiles as the
                  organiser types. The manual type-and-submit path is preserved —
                  the dropdown is additive and never required to add a host. */}
              <div class="relative min-w-[12rem] flex-1">
                <input
                  id="host-handle"
                  name="osnHandle"
                  type="text"
                  value={handle()}
                  maxLength={64}
                  placeholder="@alice"
                  autocomplete="off"
                  autocapitalize="none"
                  spellcheck={false}
                  role="combobox"
                  aria-expanded={open()}
                  aria-controls={LISTBOX_ID}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    open() && activeIdx() >= 0 ? optionId(activeIdx()) : undefined
                  }
                  aria-invalid={addError() ? "true" : undefined}
                  aria-describedby={addError() ? "host-handle-error" : undefined}
                  onInput={(e) => onHandleInput(e.currentTarget.value)}
                  onKeyDown={onHandleKeyDown}
                  // Delay close so a click on a suggestion (which blurs the input)
                  // still registers before the list unmounts.
                  onBlur={() => setTimeout(closeSuggestions, 120)}
                  onFocus={() => {
                    if (suggestions().length > 0) setOpen(true);
                  }}
                  disabled={adding()}
                  class="border-border bg-bg font-body text-text focus:border-gold w-full rounded-sm border px-3 py-2 text-[0.95rem] transition-colors outline-none placeholder:opacity-40 disabled:opacity-40"
                />
                <Show when={open() && suggestions().length > 0}>
                  <ul
                    id={LISTBOX_ID}
                    role="listbox"
                    aria-label="Matching OSN profiles"
                    class="border-border bg-bg absolute top-full right-0 left-0 z-10 mt-1 max-h-60 overflow-auto rounded-sm border shadow-lg"
                  >
                    <For each={suggestions()}>
                      {(s, i) => (
                        <li
                          id={optionId(i())}
                          role="option"
                          aria-selected={activeIdx() === i()}
                          // onMouseDown (not click) so the input's onBlur doesn't
                          // close the list before the selection lands.
                          onMouseDown={(e) => {
                            e.preventDefault();
                            pick(s);
                          }}
                          onMouseEnter={() => setActiveIdx(i())}
                          class="flex cursor-pointer flex-col gap-0.5 px-3 py-2 text-left"
                          classList={{
                            "bg-surface": activeIdx() === i(),
                          }}
                        >
                          <span class="font-body text-gold-dim text-[0.9rem]">@{s.handle}</span>
                          <Show when={s.displayName}>
                            <span class="font-body text-text-muted text-[0.78rem]">
                              {s.displayName}
                            </span>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
              <button
                type="submit"
                disabled={adding()}
                class="border-gold bg-gold font-body text-bg hover:bg-gold-dim rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
              >
                {adding() ? "Adding…" : "Add host"}
              </button>
            </div>
          </div>
          <Show when={addError()}>
            <p
              id="host-handle-error"
              role="alert"
              class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]"
            >
              {addError()}
            </p>
          </Show>
        </form>
      </Show>

      <Show when={loading()}>
        <div class="flex flex-col gap-3">
          <For each={[1, 2]}>
            {() => <div class="bg-surface h-[52px] animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <p
          role="alert"
          class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]"
        >
          {error()}
        </p>
      </Show>

      <Show when={!loading() && !error()}>
        <Show
          when={hosts().length > 0}
          fallback={
            <p class="border-border bg-surface/30 text-text-muted rounded-sm border p-6 text-[0.88rem]">
              No co-hosts yet.{" "}
              {props.canManage
                ? "Add one above to share this wedding."
                : "Only the owner manages this wedding for now."}
            </p>
          }
        >
          <ul class="flex flex-col gap-2">
            <For each={hosts()}>
              {(host) => (
                <li class="border-border bg-surface/30 flex items-center justify-between gap-4 rounded-sm border px-4 py-3">
                  <span class="font-body text-text text-[0.92rem]">
                    {host.handle ? (
                      <span class="text-gold-dim">@{host.handle}</span>
                    ) : (
                      <span
                        class="text-text-muted font-mono text-[0.82rem] tracking-[0.04em]"
                        title="OSN profile id"
                      >
                        {host.osnProfileId}
                      </span>
                    )}
                  </span>
                  <Show when={props.canManage}>
                    <button
                      type="button"
                      onClick={() => void remove(host)}
                      class="font-body text-text-muted hover:text-error text-[0.72rem] tracking-[0.1em] uppercase underline-offset-4 transition hover:underline"
                      aria-label={`Remove ${host.handle ? `@${host.handle}` : "host"}`}
                    >
                      Remove
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}

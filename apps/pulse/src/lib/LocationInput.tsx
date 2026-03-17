import { createSignal, createEffect, onCleanup, For, Show } from "solid-js";
import { composeLabel, type PhotonFeature } from "./utils";

export function LocationInput(props: { value: string; onValue: (v: string) => void }) {
  const [inputValue, setInputValue] = createSignal(props.value);
  const [searchQuery, setSearchQuery] = createSignal(props.value);
  const [suggestions, setSuggestions] = createSignal<PhotonFeature[]>([]);
  const [open, setOpen] = createSignal(false);
  let selecting = false;

  createEffect(() => {
    const q = searchQuery();
    if (q.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&lang=en`,
          { signal: controller.signal },
        );
        const json = (await res.json()) as { features: PhotonFeature[] };
        setSuggestions(json.features ?? []);
        setOpen(json.features.length > 0);
      } catch (err) {
        if (!(err instanceof Error && err.name === "AbortError")) {
          // ignore non-abort fetch errors silently
        }
      }
    }, 300);
    onCleanup(() => {
      clearTimeout(timer);
      controller.abort();
    });
  });

  function select(feature: PhotonFeature) {
    const label = composeLabel(feature.properties);
    setInputValue(label); // update display only — does not re-trigger search
    props.onValue(label);
    setSuggestions([]);
    setOpen(false);
  }

  function handleInput(e: InputEvent & { currentTarget: HTMLInputElement }) {
    const v = e.currentTarget.value;
    setInputValue(v);
    setSearchQuery(v); // triggers the fetch effect
    props.onValue(v);
  }

  function handleBlur() {
    if (selecting) return;
    setOpen(false);
  }

  return (
    <div class="relative">
      <input
        id="location"
        type="text"
        value={inputValue()}
        onInput={handleInput}
        onBlur={handleBlur}
        onFocus={() => suggestions().length > 0 && setOpen(true)}
        class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
      />
      <Show when={open() && suggestions().length > 0}>
        <ul class="absolute z-10 mt-1 w-full rounded-md border border-border bg-card shadow-lg">
          <For each={suggestions()}>
            {(feature) => (
              <li
                class="px-3 py-2 text-sm text-foreground cursor-pointer hover:bg-muted"
                onMouseDown={() => {
                  selecting = true;
                  select(feature);
                }}
                onMouseUp={() => {
                  selecting = false;
                }}
              >
                {composeLabel(feature.properties)}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

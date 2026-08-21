import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { createStore, produce } from "solid-js/store";

import { ControlsPanel } from "./lab/controls.tsx";
import { inferControl } from "./lab/infer-control.ts";
import { loadRegistry, storyFileCount } from "./lab/registry.ts";
import {
  BACKDROPS,
  backdrop,
  hash,
  isBare,
  selectStory,
  setBackdrop,
  setTheme,
  setViewport,
  theme,
  viewport,
  VIEWPORTS,
  type Backdrop,
  type ViewportName,
} from "./lab/state.ts";
import type { ControlSpec, StoryArgs, StoryEntry, StoryLayout } from "./lab/types.ts";

const LAYOUT_CLASS = {
  centered: "flex size-full items-center justify-center p-8",
  padded: "size-full overflow-auto p-8",
  fullscreen: "size-full",
} satisfies Record<StoryLayout, string>;

const BACKDROP_CLASS = {
  app: "bg-background",
  paper: "bg-white",
  ink: "bg-[#0b0b0c]",
  grid: "bg-background bg-lab-grid",
  checker: "bg-background bg-lab-checker",
} satisfies Record<Backdrop, string>;

interface StoryFrameProps {
  entry: StoryEntry;
  args: StoryArgs;
}

function StoryFrame(props: StoryFrameProps) {
  return <div class={LAYOUT_CLASS[props.entry.layout]}>{props.entry.story.render(props.args)}</div>;
}

export function Lab() {
  const [registry] = createResource(loadRegistry);
  const entries = () => registry()?.entries ?? [];
  const failures = () => registry()?.failures ?? [];

  const [query, setQuery] = createSignal("");
  const [nonce, setNonce] = createSignal(0);
  const [showArgs, setShowArgs] = createSignal(true);

  const current = createMemo(() => {
    const list = entries();
    return list.find((entry) => entry.id === hash()) ?? list[0];
  });

  // A bare load, or a hash pointing at a story that has since been renamed,
  // lands on the first story — and the URL is corrected to say so.
  createEffect(() => {
    const entry = current();
    if (entry && hash() !== entry.id) selectStory(entry.id);
  });

  const [args, setArgs] = createStore<StoryArgs>({});
  // Swapping stories has to clear the previous story's keys as well as add
  // the new ones, so this rewrites the object rather than merging into it.
  const resetArgs = () => {
    const defaults = { ...current()?.story.args };
    setArgs(
      produce((draft) => {
        for (const key of Object.keys(draft)) delete draft[key];
        Object.assign(draft, defaults);
      }),
    );
  };
  createEffect(resetArgs);

  const specs = createMemo(() => {
    const story = current()?.story;
    const out: Record<string, ControlSpec> = {};
    for (const [name, value] of Object.entries(story?.args ?? {})) {
      const spec = story?.controls?.[name] ?? inferControl(value);
      if (spec) out[name] = spec;
    }
    return out;
  });

  const groups = createMemo(() => {
    const needle = query().trim().toLowerCase();
    const map = new Map<string, StoryEntry[]>();
    for (const entry of entries()) {
      if (needle && !entry.id.toLowerCase().includes(needle)) continue;
      const list = map.get(entry.title);
      if (list) list.push(entry);
      else map.set(entry.title, [entry]);
    }
    return [...map.entries()];
  });

  // Arrow keys step through the flat list, but only when the focus is not in
  // a control — otherwise a number input becomes unusable.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    // A story that owns the arrows has already said so. `@shared/sortable`'s
    // grip moves a row on Arrow Up/Down and calls `preventDefault()`; this
    // listener is on `window`, so it runs after Solid's delegated handler on
    // `document` and sees that flag. Without this check the lab stepped to the
    // NEXT STORY on every attempted row move, which made the keyboard half of
    // that package — the half with no other way to be exercised — untestable
    // here. Any story that handles the arrows itself gets the same protection.
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    // A CSS3D story renders live, editable DOM inside the preview; stepping
    // the story list out from under someone mid-edit is the same papercut.
    if (target?.isContentEditable) return;
    const list = entries();
    const index = list.findIndex((entry) => entry.id === current()?.id);
    const next = list[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      event.preventDefault();
      selectStory(next.id);
    }
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  // Identity changes on every recompute, so a keyed <Show> tears the story
  // down and builds it again — which is what "remount" has to mean for a
  // canvas holding a WebGL context.
  const previewKey = createMemo(() => {
    const entry = current();
    nonce();
    return entry ? { entry } : undefined;
  });

  const preview = (
    <div class={`size-full ${BACKDROP_CLASS[backdrop()]}`}>
      <div
        class="mx-auto h-full"
        style={
          viewport() === "full"
            ? undefined
            : { "max-width": `${VIEWPORTS[viewport()]}px`, "box-shadow": "0 0 0 1px var(--border)" }
        }
      >
        <Show when={previewKey()} keyed>
          {(key) => <StoryFrame entry={key.entry} args={args} />}
        </Show>
      </div>
    </div>
  );

  if (isBare()) return preview;

  const chip =
    "cursor-pointer rounded-md border border-border bg-background px-2 py-1 text-meta text-muted-foreground hover:bg-muted";

  return (
    <div class="bg-background text-foreground flex h-full w-full">
      <aside class="border-border flex w-64 shrink-0 flex-col border-r">
        <div class="border-border flex items-center gap-2 border-b p-3">
          <span class="text-title font-medium">Lab</span>
          <span class="text-meta text-subtle">{entries().length}</span>
        </div>
        <input
          class="border-border bg-background text-meta focus:ring-ring m-3 rounded-md border px-2 py-1 outline-none focus:ring-2"
          placeholder="Filter…"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <nav class="flex-1 overflow-y-auto px-2 pb-4">
          <Show
            when={!registry.loading}
            fallback={<p class="text-meta text-subtle p-2">Loading…</p>}
          >
            <For
              each={groups()}
              fallback={
                <p class="text-meta text-subtle p-2">
                  {storyFileCount === 0
                    ? "No *.story.tsx files found yet."
                    : "Nothing matches that filter."}
                </p>
              }
            >
              {([title, list]) => (
                <div class="mb-3">
                  <div class="text-meta text-subtle px-2 py-1 tracking-wide uppercase">{title}</div>
                  <For each={list}>
                    {(entry) => (
                      <button
                        class={`text-body block w-full cursor-pointer truncate rounded-md px-2 py-1 text-left ${
                          entry.id === current()?.id
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted"
                        }`}
                        onClick={() => selectStory(entry.id)}
                      >
                        {entry.name}
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>

          <Show when={failures().length > 0}>
            <div class="border-destructive/40 mt-2 rounded-md border p-2">
              <div class="text-meta text-destructive font-medium">
                {failures().length} file(s) failed to load
              </div>
              <For each={failures()}>
                {(failure) => (
                  <div class="text-meta text-muted-foreground mt-1">
                    <div class="truncate">{failure.file}</div>
                    <div class="text-subtle">{failure.error}</div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </nav>
      </aside>

      <main class="flex min-w-0 flex-1 flex-col">
        <header class="border-border flex items-center gap-2 border-b px-3 py-2">
          <span class="text-body truncate font-medium">{current()?.id ?? "—"}</span>
          <span class="text-meta text-subtle truncate">{current()?.file ?? ""}</span>
          <div class="ml-auto flex items-center gap-1.5">
            <select
              class={chip}
              value={backdrop()}
              onChange={(event) => setBackdrop(event.currentTarget.value as Backdrop)}
            >
              <For each={BACKDROPS}>{(name) => <option value={name}>{name}</option>}</For>
            </select>
            <select
              class={chip}
              value={viewport()}
              onChange={(event) => setViewport(event.currentTarget.value as ViewportName)}
            >
              <For each={Object.keys(VIEWPORTS)}>
                {(name) => <option value={name}>{name}</option>}
              </For>
            </select>
            <button class={chip} onClick={() => setTheme(theme() === "dark" ? "light" : "dark")}>
              {theme() === "dark" ? "dark" : "light"}
            </button>
            <button class={chip} onClick={() => setNonce(nonce() + 1)}>
              remount
            </button>
            <button class={chip} onClick={() => setShowArgs(!showArgs())}>
              args
            </button>
            <a class={chip} href={`?bare#/${current()?.id ?? ""}`} target="_blank" rel="noreferrer">
              open
            </a>
          </div>
        </header>

        <div class="flex min-h-0 flex-1">
          <div class="min-w-0 flex-1 overflow-hidden">{preview}</div>
          <Show when={showArgs()}>
            <div class="border-border w-64 shrink-0 border-l">
              <ControlsPanel
                args={args}
                specs={specs()}
                onChange={(name, value) => setArgs(name, value)}
                onReset={resetArgs}
              />
            </div>
          </Show>
        </div>
      </main>
    </div>
  );
}

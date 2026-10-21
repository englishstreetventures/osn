import { createSignal, For, Show } from "solid-js";

import { closestCenter } from "./collision";
import { DragDropProvider, DragDropSensors, useDragDropContext } from "./context";
import { createDraggable, createDroppable } from "./droppable";
import { createSortableList } from "./list";
import { createSortable, maybeTransformStyle, SortableProvider } from "./sortable";

/**
 * Rendered by the component lab (`bun run dev:lab`) — a story living next to
 * the package it exercises rather than in `tools/lab`. Nothing imports this
 * file at build time; the lab finds it by glob.
 *
 * ## Why this bench exists
 *
 * Three things about a drag are invisible to every test tier we have, and all
 * three are the difference between a list that feels right and one that does
 * not:
 *
 * - **Drag feel** — does the row track the pointer without lag or easing?
 * - **The shift/settle animation** — do the rows between the dragged one and
 *   its target open a gap, and does the list settle rather than snap on drop?
 * - **Grip hover / focus styling** — is the affordance findable with a mouse
 *   and visible with a keyboard?
 *
 * happy-dom computes no layout, so the unit tests stub every rect and can only
 * assert the numbers. This is where you look at it.
 *
 * The shift-aside in particular shipped broken once: `transform` returned
 * `null` for every non-dragged row, so the "rows shifting aside" styling
 * animated nothing while every drop-semantics test stayed green. A bench would
 * have caught it in a second.
 *
 * See `wiki/shared/drag-and-drop.md`.
 */
export const meta = { title: "shared/sortable", layout: "padded" as const };

const EVENTS = ["Ceremony", "Cocktails", "Dinner", "Speeches", "Dancing", "Send-off"];

function Row(props: {
  id: string;
  label: string;
  index: () => number;
  count: () => number;
  item: ReturnType<ReturnType<typeof createSortableList>["item"]>;
  active: () => boolean;
}) {
  const sortable = createSortable(props.id);
  return (
    <li
      ref={sortable.ref}
      style={maybeTransformStyle(sortable.transform())}
      class="border-border bg-card flex items-center gap-3 rounded-lg border p-3"
      classList={{
        "shadow-lg ring-primary/40 z-10 ring-2": sortable.isActiveDraggable(),
        // Animate the OTHER rows shifting aside, never the dragged one — that
        // must track the pointer without easing. Only while a drag is live, so
        // the post-drop settle isn't double-animated.
        "transition-transform": props.active() && !sortable.isActiveDraggable(),
      }}
    >
      <button
        {...sortable.dragActivators}
        {...props.item.gripProps()}
        // `touch-none` is required — without it the browser scrolls instead of
        // handing the gesture over. `py-2` brings the grip to the WCAG 2.5.8
        // 24px minimum target.
        class="text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:ring-ring cursor-grab touch-none rounded px-1 py-2 text-lg leading-none focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing"
      >
        ⠿
      </button>
      <span class="flex-1">{props.label}</span>
      <span class="text-muted-foreground text-xs tabular-nums">
        {props.index() + 1} / {props.count()}
      </span>
      <For each={[-1, 1] as const}>
        {(delta) => (
          <button
            {...props.item.moveProps(delta)}
            class="border-border text-muted-foreground hover:text-foreground sr-only rounded border px-2 py-1 text-xs focus:not-sr-only focus:relative"
          >
            {props.item.moveLabel(delta)}
          </button>
        )}
      </For>
    </li>
  );
}

function List(props: { initial: string[]; label: string }) {
  const [items, setItems] = createSignal(props.initial);
  const [phase, setPhase] = createSignal<string>("—");

  const reorder = createSortableList({
    ids: items,
    labelFor: (id) => String(id),
    noun: "event",
    onMove: (from, to) => {
      const next = [...items()];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      setItems(next);
    },
    // The package reports phases; a consumer decides what they mean. The host
    // portal maps these to haptics — here they are just printed, which is the
    // cheapest way to see that `step` fires once per row crossed rather than
    // once per pointer event.
    onPhase: setPhase,
  });

  return (
    <DragDropProvider {...reorder.dragHandlers} collisionDetector={closestCenter}>
      <DragDropSensors />
      <DragInner label={props.label} items={items} reorder={reorder} phase={phase} />
    </DragDropProvider>
  );
}

/** Split out so it can read `useDragDropContext`, which only resolves under the provider. */
function DragInner(props: {
  label: string;
  items: () => string[];
  reorder: ReturnType<typeof createSortableList>;
  phase: () => string;
}) {
  // Non-null: this only ever renders inside the provider above.
  const [state] = useDragDropContext()!;
  /** True while a drag is live — gates the shift transition on the other rows. */
  const active = state.dragging;
  return (
    <section class="flex w-96 flex-col gap-3">
      <header class="flex items-baseline justify-between">
        <h3 class="text-sm font-medium">{props.label}</h3>
        <span class="text-muted-foreground text-xs">
          last phase: <code>{props.phase()}</code>
        </span>
      </header>
      <ul class="flex flex-col gap-2">
        <SortableProvider ids={props.items()}>
          <For each={props.items()}>
            {(id, index) => (
              <Row
                id={id}
                label={id}
                index={index}
                count={() => props.items().length}
                item={props.reorder.item(id, index, () => props.items().length)}
                active={active}
              />
            )}
          </For>
        </SortableProvider>
      </ul>
      <p {...props.reorder.hintProps()}>{props.reorder.hintText}</p>
      <p {...props.reorder.liveRegionProps()}>{props.reorder.announcement()}</p>
      <Show when={props.reorder.announcement()}>
        {(text) => (
          <p class="text-muted-foreground text-xs">
            announced: <em>{text()}</em>
          </p>
        )}
      </Show>
    </section>
  );
}

/**
 * The everyday case. Drag the grip; watch the rows between it and the drop
 * target open a gap, and the list settle on release.
 *
 * Then put the mouse down and use the keyboard: Tab to a grip, Arrow Up/Down to
 * move a row, and Tab once more to reveal the `sr-only` move buttons that exist
 * for browse-mode screen readers. The announcement each move produces is
 * printed under the list.
 */
export const Reorder = () => <List label="Schedule" initial={EVENTS} />;

/**
 * Two lists, one `DragDropProvider`. Collision detection is scoped to the
 * `SortableProvider` a row sits under, so a row dragged from one list can never
 * land in the other however far you drag it — try it.
 *
 * That is deliberate rather than a limitation: moving an item between lists is
 * a re-bucketing (a semantic change), not a re-order.
 */
export const MultipleLists = () => (
  <div class="flex flex-wrap gap-10">
    <List label="Day one" initial={["Mehndi", "Sangeet", "Dinner"]} />
    <List label="Day two" initial={["Ceremony", "Lunch", "Reception"]} />
  </div>
);

/**
 * A long list, for the two things a short one hides: whether the drag keeps up
 * with a fast pointer over many rows, and whether `step` fires once per row
 * crossed rather than once per pointer event (watch the phase readout).
 */
export const LongList = () => (
  <List label="Twenty rows" initial={Array.from({ length: 20 }, (_, i) => `Item ${i + 1}`)} />
);

function Chip(props: { id: string }) {
  const item = createDraggable(props.id);
  return (
    <li
      ref={item.ref}
      style={maybeTransformStyle(item.transform())}
      classList={{ "relative z-30 shadow-lg": item.isActiveDraggable() }}
      class="border-border bg-card flex items-center gap-2 rounded-md border px-2 py-1 text-sm"
    >
      <button
        type="button"
        {...item.dragActivators}
        class="cursor-grab touch-none active:cursor-grabbing"
        aria-label={`Drag ${props.id}`}
      >
        ⠿
      </button>
      {props.id}
    </li>
  );
}

function Place(props: { id: string; guests: string[] }) {
  const zone = createDroppable(props.id);
  return (
    <section
      ref={zone.ref}
      class="border-border min-h-24 w-56 rounded-lg border p-3"
      classList={{ "border-primary ring-primary/40 ring-2": zone.isOver() }}
    >
      <h3 class="mb-2 text-sm font-semibold">{props.id}</h3>
      <ul class="flex flex-wrap gap-2">
        <For each={props.guests}>{(guest) => <Chip id={guest} />}</For>
      </ul>
    </section>
  );
}

/**
 * Drop zones: names dragged between containers rather than re-ordered within
 * one. What to look at: the chip tracks the pointer and paints above the
 * containers it crosses; only the container under the pointer lights; a release
 * between containers puts the chip back where it was. Scroll the page with the
 * wheel mid-drag to check the far container is still found.
 */
export const DropZones = () => {
  const [places, setPlaces] = createSignal<Record<string, string[]>>({
    "Not seated": ["Ada", "Bo", "Cleo", "Dot"],
    "Table 1": [],
    "Table 2": [],
  });
  return (
    <DragDropProvider
      onDragEnd={({ draggable, droppable }) => {
        if (!droppable) return;
        setPlaces((now) => {
          const next: Record<string, string[]> = {};
          for (const [place, guests] of Object.entries(now)) {
            next[place] = guests.filter((g) => g !== draggable.id);
          }
          next[String(droppable.id)] = [
            ...(next[String(droppable.id)] ?? []),
            String(draggable.id),
          ];
          return next;
        });
      }}
    >
      <DragDropSensors />
      <div class="flex flex-wrap gap-6">
        <For each={Object.keys(places())}>
          {(place) => <Place id={place} guests={places()[place] ?? []} />}
        </For>
      </div>
    </DragDropProvider>
  );
};

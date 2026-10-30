import Button, { buttonClass } from "@cire/ui/button";
import { cardClass } from "@cire/ui/card";
import Disclosure from "@cire/ui/disclosure";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { useAuth } from "@shared/rp-auth/solid";
import {
  closestCenter,
  createDraggable,
  createDroppable,
  createSortable,
  createSortableList,
  DragDropProvider,
  DragDropSensors,
  maybeTransformStyle,
  SortableProvider,
} from "@shared/sortable";
import { Chip, type ChipTone } from "@shared/ui/ui/chip";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Select } from "@shared/ui/ui/select";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../lib/api";
import { ensureEventsLoaded, type EventRow, eventsAccessor } from "../lib/events-store";
import { FORM_ACTION_CLASS } from "../lib/form-field";
import { haptic } from "../lib/haptics";
import { downloadLockedExport, LOCKED_EXPORTS } from "../lib/locked-exports";
import {
  guestName,
  refusalMessage,
  type RsvpBadge,
  rsvpBadge,
  type SeatingChart,
  type SeatingGuest,
  SeatingRequestError,
  type SeatingTable,
  seatAnnouncement,
  seatingApi,
} from "../lib/seating-api";
import { sameButOrder } from "../lib/sortable-rows";
import ReorderControls from "./ReorderControls";

const PLACE_CLASS = `${cardClass({ padding: "sm" })} transition-ui-colors duration-(--dur-fast) ease-(--ease-out)`;

/** The drop zone that unseats a guest dropped on it. Table ids are `stb_…`. */
const NOT_SEATED = "not-seated";

/** A word on every badge, so the colour never carries the meaning alone. */
const BADGE_TONE = {
  Declined: "danger",
  "Invite withdrawn": "danger",
  Maybe: "accent",
  "No reply": "neutral",
} as const satisfies Record<RsvpBadge, ChipTone>;

interface SeatingViewProps {
  weddingId: string;
  weddingSlug: string;
  /** Owner or editor: may set out tables and seat guests. A viewer reads. */
  canEdit: boolean;
  /** Owner: may download the venue file. */
  canManage: boolean;
}

/**
 * The seating chart for one event at a time ([[wiki/cire/cire-seating]]).
 *
 * Two ways to seat, move or unseat a guest, each complete on its own: drag
 * their row onto a table (or back onto "Not seated"), or choose a table from
 * their menu — the keyboard, screen-reader and phone path, since a touch drag
 * cannot scroll the page mid-gesture. Every change is said in the status line, which is also the
 * live region. Tables are re-ordered in "Arrange tables", a uniform list where
 * the sortable package's keyboard path applies as it does everywhere else.
 *
 * State is the view's own: it is dropped with the view, so it holds a wedding's
 * guest names only while the chart is on screen.
 */
export default function SeatingView(props: SeatingViewProps) {
  const { authFetch } = useAuth();
  const events = eventsAccessor(props.weddingId);
  const [eventsFailed, setEventsFailed] = createSignal(false);
  const [eventId, setEventId] = createSignal<string | null>(null);
  const [chart, setChart] = createSignal<SeatingChart | null>(null);
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [status, setStatus] = createSignal("");

  /** A live region speaks only when its text changes; clear it first so a
   *  repeated sentence is said again. */
  const say = (message: string) => {
    setStatus("");
    setStatus(message);
  };

  onMount(() => {
    ensureEventsLoaded(props.weddingId, async () => {
      const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/events")));
      if (res.status === 401) redirectToLogin();
      if (!res.ok) throw new Error(`events ${res.status}`);
      return (await res.json()) as EventRow[];
    }).catch((err: unknown) => {
      if (isAuthExpired(err)) return redirectToLogin();
      setEventsFailed(true);
    });
  });

  const sortedEvents = createMemo(() =>
    (events() ?? []).toSorted((a, b) => a.sortOrder - b.sortOrder),
  );

  // The first event, once the list is in, unless one is already chosen.
  createEffect(() => {
    const first = sortedEvents()[0];
    if (eventId() === null && first) setEventId(first.id);
  });

  /** Bumped on each load, so a slow answer for an event no longer on screen
   *  is dropped rather than painted over the current one. */
  let loadGeneration = 0;
  const load = async (id: string) => {
    const generation = ++loadGeneration;
    setLoadFailed(false);
    try {
      const next = await seatingApi.chart(authFetch, props.weddingId, id);
      if (generation === loadGeneration) setChart(next);
    } catch {
      if (generation === loadGeneration) setLoadFailed(true);
    }
  };
  createEffect(
    on(eventId, (id) => {
      setChart(null);
      if (id) void load(id);
    }),
  );

  const tables = createMemo(() =>
    (chart()?.tables ?? []).toSorted((a, b) => a.sortOrder - b.sortOrder),
  );
  const tableById = createMemo(() => new Map(tables().map((t) => [t.id, t])));
  /** The tables' ids in order. Both lists iterate these and look each table up
   *  through `sameButOrder`, so a re-order moves a card or a row rather than
   *  rebuilding it (and a rename form left open stays open); any other change
   *  to a table rebuilds it, as an edit always has. */
  const tableIds = createMemo(() => tables().map((t) => t.id), undefined, {
    equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
  });
  const tableRow = (id: string) =>
    createMemo(() => tableById().get(id), undefined, { equals: sameButOrder });
  const guestsAt = createMemo(() => {
    const byTable = new Map<string, SeatingGuest[]>();
    for (const guest of chart()?.guests ?? []) {
      const key = guest.tableId ?? NOT_SEATED;
      const list = byTable.get(key);
      if (list) list.push(guest);
      else byTable.set(key, [guest]);
    }
    return byTable;
  });
  const seatedCount = (tableId: string) => guestsAt().get(tableId)?.length ?? 0;

  const summary = createMemo(() => {
    const guests = chart()?.guests ?? [];
    const seated = guests.filter((g) => g.tableId !== null).length;
    const declined = guests.filter((g) => g.rsvp === "declined").length;
    const noReply = guests.filter((g) => g.rsvp === null && !g.withdrawn).length;
    return `${seated} of ${guests.length} seated · ${declined} declined · ${noReply} no reply`;
  });

  const patchGuest = (guestId: string, tableId: string | null) =>
    setChart((now) =>
      now
        ? { ...now, guests: now.guests.map((g) => (g.id === guestId ? { ...g, tableId } : g)) }
        : now,
    );

  /** Seat, move or unseat a guest: shown at once, then saved; a refusal puts
   *  them back and says why. */
  async function seat(guest: SeatingGuest, tableId: string | null) {
    const id = eventId();
    if (!id || guest.tableId === tableId) return;
    const from = guest.tableId;
    const to = tableId === null ? null : (tableById().get(tableId) ?? null);
    const name = guestName(guest);
    // A full table is refused here, as the menu refuses it, rather than sent
    // for the server to refuse.
    if (to && seatedCount(to.id) >= to.capacity) {
      haptic("reject");
      say(refusalMessage("table_full", name, to.name));
      return;
    }
    patchGuest(guest.id, tableId);
    try {
      await seatingApi.seat(authFetch, props.weddingId, id, guest.id, tableId);
      haptic("commit");
      say(seatAnnouncement(name, to, from));
    } catch (err) {
      patchGuest(guest.id, from);
      haptic("reject");
      say(
        refusalMessage(
          err instanceof SeatingRequestError ? err.code : null,
          name,
          to?.name ?? null,
        ),
      );
    }
  }

  // ── Tables ───────────────────────────────────────────────────────────────

  const [newName, setNewName] = createSignal("");
  const [newCapacity, setNewCapacity] = createSignal("10");

  async function addTable(e: Event) {
    e.preventDefault();
    const id = eventId();
    const capacity = Number(newCapacity());
    if (!id || !Number.isInteger(capacity) || capacity < 1) return;
    const name = newName().trim() || `Table ${tables().length + 1}`;
    try {
      const { table } = await seatingApi.createTable(authFetch, props.weddingId, id, {
        name,
        capacity,
      });
      setChart((now) => (now ? { ...now, tables: [...now.tables, table] } : now));
      setNewName("");
      haptic("commit");
      say(`${table.name} added.`);
    } catch (err) {
      haptic("reject");
      say(
        err instanceof SeatingRequestError && err.code === "table_limit"
          ? "This event already has as many tables as it can hold."
          : "Could not add that table.",
      );
    }
  }

  async function saveTable(table: SeatingTable, patch: { name: string; capacity: number }) {
    try {
      const { table: saved } = await seatingApi.updateTable(
        authFetch,
        props.weddingId,
        table.id,
        patch,
      );
      setChart((now) =>
        now ? { ...now, tables: now.tables.map((t) => (t.id === saved.id ? saved : t)) } : now,
      );
      haptic("commit");
      say(`${saved.name} saved.`);
      return true;
    } catch (err) {
      haptic("reject");
      say(
        err instanceof SeatingRequestError && err.code === "capacity_below_seated"
          ? `${table.name} has more guests seated than that. Move some first.`
          : `Could not save ${table.name}.`,
      );
      return false;
    }
  }

  async function deleteTable(table: SeatingTable) {
    const seated = seatedCount(table.id);
    const ok = window.confirm(
      seated > 0
        ? `Delete ${table.name}? Its ${seated} ${seated === 1 ? "guest goes" : "guests go"} back to Not seated.`
        : `Delete ${table.name}?`,
    );
    if (!ok) return;
    try {
      await seatingApi.deleteTable(authFetch, props.weddingId, table.id);
      setChart((now) =>
        now
          ? {
              ...now,
              tables: now.tables.filter((t) => t.id !== table.id),
              guests: now.guests.map((g) => (g.tableId === table.id ? { ...g, tableId: null } : g)),
            }
          : now,
      );
      haptic("commit");
      say(`${table.name} deleted.`);
    } catch {
      haptic("reject");
      say(`Could not delete ${table.name}.`);
    }
  }

  const arrange = createSortableList({
    ids: () => tables().map((t) => t.id),
    labelFor: (id) => untrack(() => tableById().get(String(id))?.name) ?? "table",
    noun: "table",
    onPhase: haptic,
    onMove: (from, to) => {
      const id = eventId();
      if (!id) return;
      const order = tables().map((t) => t.id);
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved!);
      const rank = new Map(order.map((tableId, i) => [tableId, i]));
      // Only a table whose place changed gets a new object.
      setChart((now) =>
        now
          ? {
              ...now,
              tables: now.tables.map((t) => {
                const sortOrder = rank.get(t.id) ?? t.sortOrder;
                return sortOrder === t.sortOrder ? t : { ...t, sortOrder };
              }),
            }
          : now,
      );
      seatingApi.reorderTables(authFetch, props.weddingId, id, order).catch(() => {
        arrange.clearAnnouncement();
        haptic("reject");
        say("Could not save the order of the tables.");
        void load(id);
      });
    },
  });

  // ── Print ────────────────────────────────────────────────────────────────

  // Printing the page while the chart is on screen prints the chart. The sheet
  // is built when the page starts printing and dropped when it stops, so a
  // chart on screen keeps no hidden copy of itself current; <html> carries the
  // mark for the same span, and the stylesheet then hides every other child of
  // <body>. The button and the browser's own print both fire the pair.
  const [printing, setPrinting] = createSignal(false);
  onMount(() => {
    const before = () => {
      // With no chart on screen (loading, failed, no events) the page prints
      // as it looks.
      if (!chart()) return;
      document.documentElement.setAttribute("data-print-sheet", "");
      setPrinting(true);
    };
    const after = () => {
      setPrinting(false);
      document.documentElement.removeAttribute("data-print-sheet");
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    onCleanup(() => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
      after();
    });
  });

  async function downloadCsv() {
    try {
      await downloadLockedExport(
        authFetch,
        props.weddingId,
        props.weddingSlug,
        LOCKED_EXPORTS.seating,
      );
    } catch {
      say("Could not download the seating chart. Try again.");
    }
  }

  return (
    <div class="flex flex-col gap-6">
      <Show
        when={sortedEvents().length > 0}
        fallback={
          <Show
            when={events() !== null}
            fallback={
              <p class="font-body text-text-muted text-ui-sm">
                {eventsFailed() ? "Couldn't load your events. Refresh to try again." : "Loading…"}
              </p>
            }
          >
            <EmptyState
              title="No events yet"
              description="A seating chart belongs to one event. Add your events first."
            />
          </Show>
        }
      >
        <div class="flex flex-wrap items-end justify-between gap-4">
          <Field label="Event">
            {(field) => (
              <Select
                {...field}
                size="sm"
                onChange={(e) => setEventId(e.currentTarget.value)}
                class="min-w-56"
              >
                {/* Each option carries its own selection, so a refreshed event
                    list, which rebuilds the options, keeps showing the event
                    whose chart is on screen. */}
                <For each={sortedEvents()}>
                  {(event) => (
                    <option value={event.id} selected={event.id === eventId()}>
                      {event.name}
                    </option>
                  )}
                </For>
              </Select>
            )}
          </Field>
          {/* The event picker is a filter — which chart to show — so it is a 28px
              pill, and the bar's actions beside it are its height (DESIGN.md
              §4, "One form-field height"). */}
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" class="h-7" onClick={() => window.print()}>
              Print
            </Button>
            <Show when={props.canManage}>
              <Button variant="outline" size="sm" class="h-7" onClick={() => void downloadCsv()}>
                Download seating CSV
              </Button>
            </Show>
          </div>
        </div>

        <div class="flex flex-col gap-1">
          <Show
            when={chart()}
            fallback={
              <p class="font-body text-text-muted text-ui-sm">
                {loadFailed()
                  ? "Couldn't load the seating chart. Refresh to try again."
                  : "Loading…"}
              </p>
            }
          >
            <p class="font-body text-text text-ui-sm" data-numeric>
              {summary()}
            </p>
          </Show>
          {/* The live region: every seat, move, refusal and table change is said
              here, and shown, so a sighted host sees what a screen reader hears. */}
          <output aria-live="polite" class="font-body text-gold-ink text-ui-sm block min-h-5">
            {status()}
          </output>
        </div>

        <Show when={chart()}>
          {(current) => (
            <>
              <Show when={props.canEdit}>
                <form class="flex flex-wrap items-end gap-3" onSubmit={addTable}>
                  <Field label="Table name">
                    {(field) => (
                      <Input
                        size="form"
                        {...field}
                        value={newName()}
                        placeholder={`Table ${tables().length + 1}`}
                        maxLength={80}
                        onInput={(e) => setNewName(e.currentTarget.value)}
                        class="w-48"
                      />
                    )}
                  </Field>
                  <Field label="Seats">
                    {(field) => (
                      <Input
                        size="form"
                        {...field}
                        type="number"
                        min="1"
                        max="100"
                        value={newCapacity()}
                        onInput={(e) => setNewCapacity(e.currentTarget.value)}
                        class="w-24"
                      />
                    )}
                  </Field>
                  <Button class={FORM_ACTION_CLASS} type="submit" variant="primary" size="sm">
                    Add table
                  </Button>
                </form>

                <Show when={tables().length > 1}>
                  <Disclosure summary="Arrange tables">
                    <DragDropProvider {...arrange.dragHandlers} collisionDetector={closestCenter}>
                      <DragDropSensors />
                      <p {...arrange.hintProps()}>{arrange.hintText}</p>
                      <ol class="flex flex-col gap-1">
                        <SortableProvider ids={tableIds()}>
                          <For each={tableIds()}>
                            {(id, index) => (
                              <Show when={tableRow(id)()} keyed>
                                {(table) => (
                                  <ArrangeRow
                                    table={table}
                                    item={arrange.item(table.id, index, () => tableIds().length)}
                                  />
                                )}
                              </Show>
                            )}
                          </For>
                        </SortableProvider>
                      </ol>
                      <p {...arrange.liveRegionProps()}>{arrange.announcement()}</p>
                    </DragDropProvider>
                  </Disclosure>
                </Show>
              </Show>

              <DragDropProvider
                onDragStart={() => haptic("pickup")}
                onDragEnd={({ draggable, droppable }) => {
                  if (!droppable) return;
                  const guest = current().guests.find((g) => g.id === draggable.id);
                  if (!guest) return;
                  void seat(guest, droppable.id === NOT_SEATED ? null : String(droppable.id));
                }}
              >
                <DragDropSensors />
                <div class="grid gap-6 @4xl/panel:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)]">
                  <Place
                    id={NOT_SEATED}
                    title="Not seated"
                    class="self-start"
                    guests={guestsAt().get(NOT_SEATED) ?? []}
                    tables={tables()}
                    seatedCount={seatedCount}
                    canEdit={props.canEdit}
                    onSeat={seat}
                  />
                  <div class="flex flex-col gap-4">
                    <Show
                      when={tables().length > 0}
                      fallback={
                        <EmptyState
                          title="No tables yet"
                          description={
                            props.canEdit
                              ? "Add a table, then drag guests onto it or choose their table from their menu."
                              : "Nobody has set out tables for this event yet."
                          }
                        />
                      }
                    >
                      <For each={tableIds()}>
                        {(id) => (
                          <Show when={tableRow(id)()} keyed>
                            {(table) => (
                              <Place
                                id={table.id}
                                title={table.name}
                                table={table}
                                guests={guestsAt().get(table.id) ?? []}
                                tables={tables()}
                                seatedCount={seatedCount}
                                canEdit={props.canEdit}
                                onSeat={seat}
                                onSave={(patch) => saveTable(table, patch)}
                                onDelete={() => void deleteTable(table)}
                              />
                            )}
                          </Show>
                        )}
                      </For>
                    </Show>
                  </div>
                </div>
              </DragDropProvider>

              <Show when={printing()}>
                <Portal ref={markPrintSheet}>
                  <PrintSheet chart={current()} tables={tables()} guestsAt={guestsAt()} />
                </Portal>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}

function ArrangeRow(props: {
  table: SeatingTable;
  item: ReturnType<ReturnType<typeof createSortableList>["item"]>;
}) {
  const sortable = createSortable(props.table.id);
  return (
    <li
      ref={sortable.ref}
      style={maybeTransformStyle(sortable.transform())}
      class="bg-surface/30 flex items-center gap-2 rounded-sm px-2 py-1"
      classList={{ "relative z-30 shadow-(--elev-2)": sortable.isActiveDraggable() }}
    >
      <ReorderControls sortable={sortable} item={props.item} />
      <span class="font-body text-text text-ui-sm">{props.table.name}</span>
    </li>
  );
}

/**
 * The "Not seated" list or one table: a drop zone holding guest rows. A table
 * also carries its count and, for an editor, its rename and delete.
 */
function Place(props: {
  id: string;
  title: string;
  table?: SeatingTable;
  guests: SeatingGuest[];
  tables: SeatingTable[];
  seatedCount: (tableId: string) => number;
  canEdit: boolean;
  onSeat: (guest: SeatingGuest, tableId: string | null) => Promise<void>;
  onSave?: (patch: { name: string; capacity: number }) => Promise<boolean>;
  onDelete?: () => void;
  class?: string;
}) {
  const zone = createDroppable(props.id);
  const headingId = createUniqueId();
  const [editing, setEditing] = createSignal(false);
  const [name, setName] = createSignal("");
  const [capacity, setCapacity] = createSignal("");

  const startEdit = () => {
    setName(props.table?.name ?? "");
    setCapacity(String(props.table?.capacity ?? ""));
    setEditing(true);
  };
  const save = async (e: Event) => {
    e.preventDefault();
    const seats = Number(capacity());
    if (!props.onSave || !name().trim() || !Number.isInteger(seats) || seats < 1) return;
    if (await props.onSave({ name: name().trim(), capacity: seats })) setEditing(false);
  };

  return (
    <section
      ref={zone.ref}
      aria-labelledby={editing() ? undefined : headingId}
      aria-label={editing() ? props.title : undefined}
      data-table-id={props.table?.id}
      data-over={zone.isOver() ? "true" : "false"}
      class={`${PLACE_CLASS} ${props.class ?? ""}`}
      classList={{ "border-gold bg-gold/10": zone.isOver() }}
    >
      <Show
        when={!editing()}
        fallback={
          <form class="flex flex-wrap items-end gap-2" onSubmit={(e) => void save(e)}>
            <Input
              size="form"
              aria-label={`Name of ${props.title}`}
              value={name()}
              maxLength={80}
              onInput={(e) => setName(e.currentTarget.value)}
              class="w-44"
            />
            <Input
              size="form"
              aria-label={`Seats at ${props.title}`}
              type="number"
              min="1"
              max="100"
              value={capacity()}
              onInput={(e) => setCapacity(e.currentTarget.value)}
              class="w-20"
            />
            <Button class={FORM_ACTION_CLASS} type="submit" variant="primary" size="sm">
              Save
            </Button>
            <Button
              class={FORM_ACTION_CLASS}
              variant="quiet"
              size="sm"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </form>
        }
      >
        <header class="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id={headingId} class="font-body text-text text-ui-base font-medium">
            {props.title}
          </h3>
          <div class="flex items-center gap-2">
            <Show when={props.table}>
              {(table) => (
                <span class="font-body text-text-muted text-ui-sm" data-numeric>
                  {`${props.seatedCount(table().id)} of ${table().capacity}`}
                </span>
              )}
            </Show>
            <Show when={props.canEdit && props.table}>
              <Button
                variant="quiet"
                size="sm"
                aria-label={`Edit ${props.title}`}
                onClick={startEdit}
              >
                Edit
              </Button>
              <Button
                variant="quiet"
                size="sm"
                aria-label={`Delete ${props.title}`}
                onClick={() => props.onDelete?.()}
              >
                Delete
              </Button>
            </Show>
          </div>
        </header>
      </Show>
      <Show
        when={props.guests.length > 0}
        fallback={
          <p class="font-body text-text-faint text-ui-sm">
            {props.table
              ? props.canEdit
                ? "Drop guests here."
                : "No one seated yet."
              : "Everyone is seated."}
          </p>
        }
      >
        <ul class="flex flex-col gap-1">
          <For each={props.guests}>
            {(guest) => (
              <GuestRow
                guest={guest}
                tables={props.tables}
                seatedCount={props.seatedCount}
                canEdit={props.canEdit}
                onSeat={props.onSeat}
              />
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** A guest's "Seat" or "Move": a word that opens a menu, so `subtle`'s text
 *  action, with padding kept so the word is a 24px target. */
const menuTriggerClass = `${buttonClass({ variant: "subtle", size: "sm" })} shrink-0 px-2 py-1`;

/** The keys a menu button opens on, as Kobalte's trigger takes them. */
const MENU_OPEN_KEYS = new Set(["Enter", " ", "ArrowDown", "ArrowUp"]);

/** Hands the event that opened a guest's menu to the menu's own trigger. */
type MenuOpener = (trigger: HTMLElement) => void;

const menuItemClass =
  "font-body text-text-muted text-ui-sm flex w-full cursor-pointer items-center justify-between gap-4 " +
  "rounded-sm px-3 py-2 outline-none transition-ui-colors duration-(--dur-fast) ease-(--ease-out) " +
  "data-[highlighted]:bg-gold/10 data-[highlighted]:text-text " +
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50";

function GuestRow(props: {
  guest: SeatingGuest;
  tables: SeatingTable[];
  seatedCount: (tableId: string) => number;
  canEdit: boolean;
  onSeat: (guest: SeatingGuest, tableId: string | null) => Promise<void>;
}) {
  const item = createDraggable(props.guest.id);
  const name = () => guestName(props.guest);
  const badge = () => rsvpBadge(props.guest);
  return (
    <li
      ref={item.ref}
      style={maybeTransformStyle(item.transform())}
      class="bg-surface flex items-center gap-2 rounded-sm px-2 py-1.5"
      classList={{ "relative z-30 shadow-(--elev-2)": item.isActiveDraggable() }}
    >
      <Show when={props.canEdit && !props.guest.withdrawn}>
        {/* Pointer only. The menu beside it is the keyboard path, so the
            handle stays out of the tab order and out of the accessibility tree. */}
        <button
          type="button"
          tabindex="-1"
          aria-hidden="true"
          data-drag-handle
          class="text-text-faint hover:text-text min-h-6 min-w-6 cursor-grab touch-none active:cursor-grabbing"
          {...item.dragActivators}
        >
          ⠿
        </button>
      </Show>
      <span class="font-body text-text text-ui-sm min-w-0 flex-1 truncate">{name()}</span>
      <Show when={badge()}>
        {(word) => (
          <Chip variant="outline" tone={BADGE_TONE[word()]} data-rsvp-badge>
            {word()}
          </Chip>
        )}
      </Show>
      <Show when={props.canEdit}>
        <GuestMenu
          guest={props.guest}
          tables={props.tables}
          seatedCount={props.seatedCount}
          onSeat={props.onSeat}
        />
      </Show>
    </li>
  );
}

/**
 * A guest's seat menu. Until it is first used it is a plain button that looks
 * like the menu's trigger, so a chart of a thousand guests builds no menu state
 * nobody opens. The event that opens it is replayed on Kobalte's own trigger,
 * so the menu opens as Kobalte's would: on a mouse press; on a tap's click, and
 * on a click no press came before (a screen reader's or voice control's); and
 * on the keys of a menu button, where Enter, Space and ArrowDown focus the
 * first item and ArrowUp the last. The state is the menu's own, so a menu
 * mounted again (an editor's role restored) starts closed.
 */
function GuestMenu(props: {
  guest: SeatingGuest;
  tables: SeatingTable[];
  seatedCount: (tableId: string) => number;
  onSeat: (guest: SeatingGuest, tableId: string | null) => Promise<void>;
}) {
  const action = () => (props.guest.tableId === null ? "Seat" : "Move");
  const label = () => `${action()} ${guestName(props.guest)}`;
  const choices = () => (props.guest.withdrawn ? [] : props.tables);
  const [opener, setOpener] = createSignal<MenuOpener | null>(null);
  const replay = (handOver: MenuOpener) => setOpener(() => handOver);
  // A click no press came before; the trigger below opens on one.
  const click: MenuOpener = (trigger) => trigger.click();
  return (
    <Show
      when={opener()}
      fallback={
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded="false"
          aria-label={label()}
          class={menuTriggerClass}
          onPointerDown={(e) => {
            if (e.pointerType === "touch" || e.button !== 0) return;
            // Kobalte opens on a press of anything but a touch.
            replay((trigger) =>
              trigger.dispatchEvent(
                new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
              ),
            );
          }}
          // A mouse press has already swapped this button out by its click, so
          // a click that reaches it is a tap's or one no press came before.
          onClick={() => replay(click)}
          onKeyDown={(e) => {
            if (!MENU_OPEN_KEYS.has(e.key)) return;
            e.preventDefault();
            const key = e.key;
            replay((trigger) => {
              // Focus moves from this button to the trigger in the same task,
              // so assistive tech hears one move, not one to the page between.
              trigger.focus({ preventScroll: true });
              trigger.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
            });
          }}
        >
          {action()}
        </button>
      }
    >
      {(open) => {
        let trigger!: HTMLButtonElement;
        onMount(() => open()(trigger));
        return (
          <DropdownMenu placement="bottom-end" gutter={4}>
            <DropdownMenu.Trigger
              ref={trigger}
              aria-label={label()}
              class={menuTriggerClass}
              onClick={(e: MouseEvent & { currentTarget: HTMLButtonElement }) => {
                // A click no press came before opens the menu, as a tap's does.
                if (e.detail === 0) e.currentTarget.dataset.pointerType = "touch";
              }}
            >
              {action()}
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="border-border bg-surface menu-pop z-50 max-h-80 min-w-56 overflow-y-auto rounded-md border p-1.5 shadow-(--elev-2) outline-none">
                <DropdownMenu.RadioGroup
                  value={props.guest.tableId ?? NOT_SEATED}
                  onChange={(value) =>
                    void props.onSeat(props.guest, value === NOT_SEATED ? null : value)
                  }
                >
                  <DropdownMenu.RadioItem value={NOT_SEATED} class={menuItemClass}>
                    Not seated
                  </DropdownMenu.RadioItem>
                  <For each={choices()}>
                    {(table) => {
                      const seated = () => props.seatedCount(table.id);
                      const full = () =>
                        seated() >= table.capacity && props.guest.tableId !== table.id;
                      return (
                        <DropdownMenu.RadioItem
                          value={table.id}
                          disabled={full()}
                          class={menuItemClass}
                        >
                          <span>{table.name}</span>
                          <span class="sr-only">, </span>
                          <span class="text-text-faint" data-numeric>
                            {`${seated()} of ${table.capacity}`}
                          </span>
                        </DropdownMenu.RadioItem>
                      );
                    }}
                  </For>
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        );
      }}
    </Show>
  );
}

/** Marks the print sheet's portal as the one child of <body> that prints.
 *  A named function rather than an arrow written in the `ref`: Solid compiles a
 *  component's `ref` expression as written, and one wrapped in a condition (as
 *  the mutation tester wraps every arrow) is never called. */
function markPrintSheet(el: HTMLDivElement) {
  el.setAttribute("data-print-sheet", "");
}

/** What the page prints while the chart is on screen: every table of the
 *  event with the guests at it, for the venue. Seated guests only. */
function PrintSheet(props: {
  chart: SeatingChart;
  tables: SeatingTable[];
  guestsAt: Map<string, SeatingGuest[]>;
}) {
  return (
    <article class="seating-print-sheet">
      <h1>{props.chart.event.name}</h1>
      <p>Seating chart</p>
      <For each={props.tables}>
        {(table) => (
          <section>
            <h2>
              {table.name}{" "}
              <span>{`(${props.guestsAt.get(table.id)?.length ?? 0} of ${table.capacity})`}</span>
            </h2>
            <ol>
              <For each={props.guestsAt.get(table.id) ?? []}>
                {(guest) => {
                  const note = guest.withdrawn
                    ? "invite withdrawn"
                    : guest.rsvp === "declined"
                      ? "declined"
                      : null;
                  return (
                    <li>
                      {guestName(guest)}
                      {note ? ` (${note})` : ""}
                    </li>
                  );
                }}
              </For>
            </ol>
          </section>
        )}
      </For>
    </article>
  );
}

import { useAuth } from "@shared/rp-auth/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { haptic } from "../lib/haptics";
import {
  filterRows,
  mergeRows,
  RSVP_FILTERS,
  type RsvpFilterEvent,
  type RsvpFilterKey,
  type RsvpRow,
  type RsvpRowStatus,
  type RsvpStatus,
  statusCounts,
} from "../lib/rsvp-filter";
import SectionIntro from "./SectionIntro";
import EmptyState from "./ui/EmptyState";
import Field, { Input } from "./ui/Field";
import Notice from "./ui/Notice";
import { Table, Td, Th } from "./ui/Table";

interface RsvpViewProps {
  weddingId: string;
  /** Owner/editor may record RSVPs; a viewer sees the read-only summary only. */
  canEdit?: boolean;
}

interface RsvpViewEvent extends RsvpFilterEvent {
  id: string;
  name: string;
  invited: number;
  attending: number;
  declined: number;
  maybe: number;
  responded: number;
  noResponse: number;
}

/** Human label + badge styling per row status. "No reply" is deliberately the
 *  quiet one: it is the most common state early on, and a loud badge on every
 *  second row would drown the answers that did come in. */
const STATUS_META = {
  attending: { label: "Attending", class: "bg-gold text-bg" },
  declined: { label: "Declined", class: "border-error/40 text-error border" },
  maybe: { label: "Maybe", class: "border-gold/40 text-gold border" },
  none: { label: "No reply", class: "border-border text-text-muted border" },
} satisfies Record<RsvpRowStatus, { label: string; class: string }>;

const CHIP_CLASS =
  "border-border hover:border-gold focus-visible:border-gold focus-visible:ring-gold/40 " +
  "font-body text-text-muted aria-pressed:border-gold aria-pressed:text-gold " +
  "flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-[0.75rem] tracking-[0.06em] " +
  "uppercase transition outline-none focus-visible:ring-2";

/** Identifies the row being edited (event + guest) so only one form is open. */
interface EditTarget {
  eventId: string;
  guestId: string;
  guestName: string;
  status: RsvpStatus;
  dietary: string;
}

/**
 * In-dashboard RSVP summary. Per event: a status tally and every guest invited
 * to it — those who replied, with status + dietary + a provenance badge
 * (organiser-entered vs guest-submitted), and those who have not, as "No reply"
 * rows in the same list. Above them sits one search box and one set of status
 * chips, applied to every event at once.
 *
 * Editors get a "Record / Edit" button in each row to enter a phone/paper RSVP
 * on a guest's behalf — the API stamps such rows
 * `consent_source='organiser_attested'` and they VISIBLY OVERWRITE a prior
 * guest reply (platform-plan §3.3). Viewers see the same list, read-only.
 */
export default function RsvpView(props: RsvpViewProps) {
  const { authFetch } = useAuth();
  const [events, setEvents] = createSignal<RsvpViewEvent[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  // The control bar: a search box and one status chip, applied to every event.
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<RsvpFilterKey>("all");

  // The open editor form (one at a time), plus its transient field state.
  const [edit, setEdit] = createSignal<EditTarget | null>(null);
  const [formStatus, setFormStatus] = createSignal<RsvpStatus>("attending");
  const [formDietary, setFormDietary] = createSignal("");
  const [formConsent, setFormConsent] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [formError, setFormError] = createSignal<string | null>(null);

  const load = async () => {
    try {
      const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/rsvps`));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const body = (await res.json()) as { events: RsvpViewEvent[] };
      setEvents(body.events);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Could not load RSVPs. Is the API running?");
    } finally {
      setLoading(false);
    }
  };

  onMount(load);

  const hasEvents = () => events().length > 0;

  // Two memos, both keyed by event id. Without them the merge and the filter
  // ran once per read — and the markup reads them four times per event, on
  // every keystroke. The rows also keep their identity between reads, which is
  // what lets <For> patch the table instead of rebuilding it.
  /** Every guest invited to each event, replied or not, before filtering. */
  const merged = createMemo(
    () => new Map(events().map((event) => [event.id, mergeRows(event)] as const)),
  );
  const shown = createMemo(() => {
    const q = query();
    const f = filter();
    return new Map([...merged()].map(([id, rows]) => [id, filterRows(rows, q, f)] as const));
  });
  const rowsFor = (event: RsvpViewEvent) => merged().get(event.id) ?? [];
  const shownFor = (event: RsvpViewEvent) => shown().get(event.id) ?? [];

  const counts = createMemo(() => statusCounts(merged().values()));
  const shownCount = createMemo(() =>
    [...shown().values()].reduce((total, rows) => total + rows.length, 0),
  );
  const filtering = () => query().trim().length > 0 || filter() !== "all";

  const openEditor = (
    eventId: string,
    guest: { guestId: string; firstName: string; lastName: string },
    existing?: { status: RsvpStatus; dietary: string },
  ) => {
    setFormError(null);
    setFormStatus(existing?.status ?? "attending");
    setFormDietary(existing?.dietary ?? "");
    // Prefill consent when editing a row that already carries dietary text
    // (prior consent assumed) — mirrors the guest form's behaviour.
    setFormConsent((existing?.dietary.trim().length ?? 0) > 0);
    setEdit({
      eventId,
      guestId: guest.guestId,
      guestName: `${guest.firstName} ${guest.lastName}`,
      status: existing?.status ?? "attending",
      dietary: existing?.dietary ?? "",
    });
  };

  /** Open the editor on a list row: prefilled when there is a reply to edit,
   *  blank when the guest has said nothing yet. */
  const openRow = (eventId: string, row: RsvpRow) => {
    if (row.responded && row.status !== "none") {
      openEditor(eventId, row, { status: row.status, dietary: row.dietary });
      return;
    }
    openEditor(eventId, row);
  };

  const closeEditor = () => {
    setEdit(null);
    setSaving(false);
    setFormError(null);
  };

  const isEditing = (eventId: string, guestId: string) => {
    const e = edit();
    return e !== null && e.eventId === eventId && e.guestId === guestId;
  };

  // A filter that hides the row an editor is open on would otherwise leave the
  // form floating under a row that is no longer there — and a Save would write
  // an RSVP the host can't see. Close it instead.
  createEffect(() => {
    const target = edit();
    if (!target) return;
    const rows = shown().get(target.eventId);
    if (!rows?.some((row) => row.guestId === target.guestId)) closeEditor();
  });

  // The count a screen reader hears, held back until the typing stops. Read
  // live, a status region interrupts on every keystroke and says a number the
  // host is already halfway past; the printed line beside it stays immediate,
  // because a sighted host reading a stale number is the worse failure.
  const [announcement, setAnnouncement] = createSignal("");
  createEffect(() => {
    const message = filtering() ? `Showing ${shownCount()} of ${counts().all} guest rows.` : "";
    const timer = setTimeout(() => setAnnouncement(message), 450);
    onCleanup(() => clearTimeout(timer));
  });

  const save = async () => {
    const target = edit();
    if (!target) return;
    const dietary = formDietary().trim();
    if (dietary.length > 0 && !formConsent()) {
      haptic("reject");
      setFormError("Confirm the guest consented before storing dietary requirements.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await authFetch(
        apiUrl(
          `/api/organiser/weddings/${props.weddingId}/guests/${target.guestId}/rsvps/${target.eventId}`,
        ),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: formStatus(),
            dietary,
            dietaryConsent: dietary.length > 0 ? formConsent() : false,
          }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (res.status === 403) {
        haptic("reject");
        setFormError("You don't have permission to record RSVPs.");
        setSaving(false);
        return;
      }
      if (!res.ok) {
        haptic("reject");
        setFormError("Could not save this RSVP. Please try again.");
        setSaving(false);
        return;
      }
      // Recorded. The reload that follows redraws the whole list, so the buzz
      // is the only thing that marks *this* row as the one that changed.
      haptic("commit");
      closeEditor();
      await load();
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      setFormError("Could not save this RSVP. Please try again.");
      setSaving(false);
    }
  };

  return (
    <div class="flex flex-col gap-8">
      <SectionIntro
        eyebrow="RSVPs"
        title="Replies at a glance"
        description={
          props.canEdit
            ? "Who's coming to each event, with dietary notes and who still owes a reply. Search or filter to find a guest, then record a phone or paper reply on their behalf — it overwrites any earlier answer and is marked as host-entered."
            : "Who's coming to each event, with dietary notes and who still owes a reply — updated as guests reply. Read-only; download the full sheet from the Guests tab."
        }
      />

      <Show when={loading()}>
        <div class="flex flex-col gap-3">
          <For each={[1, 2, 3]}>
            {() => <div class="bg-surface h-[120px] animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <Notice tone="error">{error()}</Notice>
      </Show>

      <Show when={!loading() && !error() && !hasEvents()}>
        <EmptyState
          title="No events yet"
          description="Add your events and invite guests — their replies will appear here."
        />
      </Show>

      <Show when={!loading() && !error() && hasEvents()}>
        {/* One bar for the whole page, not one per event: the question a host
            asks — who still owes a reply, who has an allergy — is asked of the
            wedding, and each section keeps its own tallies below regardless. */}
        <div class="flex flex-col gap-2">
          <div class="border-border bg-surface/20 flex flex-wrap items-center gap-3 rounded-sm border p-4">
            <Field label="Search guests" labelHidden class="min-w-[12rem] flex-1">
              {(field) => (
                <Input
                  {...field}
                  type="search"
                  value={query()}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                  placeholder="Search a name, household, code or dietary note…"
                />
              )}
            </Field>
            <div class="flex flex-wrap gap-2" role="group" aria-label="Filter by reply">
              <For each={RSVP_FILTERS}>
                {(chip) => (
                  <button
                    type="button"
                    class={CHIP_CLASS}
                    aria-pressed={filter() === chip.key}
                    onClick={() => setFilter(chip.key)}
                  >
                    {chip.label}
                    <span class="text-text font-mono text-[0.72rem]">{counts()[chip.key]}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
          {/* Two readings of one fact: the printed count updates as you type,
              the announced one waits for you to stop. */}
          <p class="font-body text-text-muted text-[0.78rem]">
            <Show when={filtering()}>
              Showing {shownCount()} of {counts().all} guest rows.
            </Show>
          </p>
          <p role="status" class="sr-only">
            {announcement()}
          </p>
        </div>

        <div class="flex flex-col gap-10">
          <For each={events()}>
            {(event) => (
              <section class="border-border bg-surface/30 flex flex-col gap-4 rounded-sm border p-5">
                <header class="flex flex-wrap items-end justify-between gap-3">
                  <h3 class="font-display text-text text-[1.3rem] leading-none font-light">
                    {event.name}
                  </h3>
                  <dl class="font-body text-text-muted flex flex-wrap gap-x-4 gap-y-1 text-[0.78rem]">
                    <div class="flex items-center gap-1.5">
                      <dt class="text-gold tracking-[0.08em] uppercase">Attending</dt>
                      <dd class="text-text font-mono">{event.attending}</dd>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <dt class="tracking-[0.08em] uppercase">Declined</dt>
                      <dd class="text-text font-mono">{event.declined}</dd>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <dt class="tracking-[0.08em] uppercase">Maybe</dt>
                      <dd class="text-text font-mono">{event.maybe}</dd>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <dt class="tracking-[0.08em] uppercase">No reply</dt>
                      <dd class="text-text font-mono">{event.noResponse}</dd>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <dt class="tracking-[0.08em] uppercase">Invited</dt>
                      <dd class="text-text font-mono">{event.invited}</dd>
                    </div>
                  </dl>
                </header>

                <Show
                  when={rowsFor(event).length > 0}
                  fallback={
                    <p class="font-body text-text-muted text-[0.82rem] italic">
                      No guests to show for this event.
                    </p>
                  }
                >
                  <Show
                    when={shownFor(event).length > 0}
                    fallback={
                      <p class="font-body text-text-muted text-[0.82rem] italic">
                        No guests match this filter.
                      </p>
                    }
                  >
                    <Table label={`Replies for ${event.name}`} class="font-body">
                      <caption class="sr-only">RSVPs for {event.name}</caption>
                      <thead>
                        <tr>
                          <Th>Guest</Th>
                          <Th>Household</Th>
                          <Th>Status</Th>
                          <Th>Dietary</Th>
                          <Show when={props.canEdit}>
                            <Th class="text-right">
                              <span class="sr-only">Actions</span>
                            </Th>
                          </Show>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={shownFor(event)}>
                          {(row) => (
                            <>
                              <tr class="hover:[&>td]:bg-surface">
                                <Td class="align-middle">
                                  {row.firstName} {row.lastName}
                                  <Show when={row.consentSource === "organiser_attested"}>
                                    {" "}
                                    <span
                                      class="border-gold/40 text-gold ml-1 inline-block rounded-sm border px-1.5 py-0.5 text-[0.55rem] tracking-[0.12em] uppercase"
                                      title="Recorded by a host (phone/paper RSVP)"
                                    >
                                      Host-entered
                                    </span>
                                  </Show>
                                </Td>
                                <Td class="text-text-muted align-middle">{row.familyName}</Td>
                                <Td class="align-middle">
                                  <span
                                    class={`font-body inline-block rounded-sm px-1.5 py-0.5 text-[0.6rem] tracking-[0.14em] uppercase ${STATUS_META[row.status].class}`}
                                  >
                                    {STATUS_META[row.status].label}
                                  </span>
                                </Td>
                                <Td class="text-text-muted align-middle">
                                  <Show
                                    when={row.dietary.trim().length > 0}
                                    fallback={<span class="text-text-muted">--</span>}
                                  >
                                    {row.dietary}
                                  </Show>
                                </Td>
                                <Show when={props.canEdit}>
                                  <Td class="text-right align-middle">
                                    <button
                                      type="button"
                                      class="border-border text-text-muted hover:text-text hover:border-gold/40 rounded-sm border px-2.5 py-1 text-[0.7rem] tracking-[0.08em] uppercase"
                                      aria-label={`${row.responded ? "Edit" : "Record"} reply for ${row.firstName} ${row.lastName}`}
                                      onClick={() => openRow(event.id, row)}
                                    >
                                      {row.responded ? "Edit" : "Record"}
                                    </button>
                                  </Td>
                                </Show>
                              </tr>
                              <Show when={props.canEdit && isEditing(event.id, row.guestId)}>
                                {renderEditorRow()}
                              </Show>
                            </>
                          )}
                        </For>
                      </tbody>
                    </Table>
                  </Show>
                </Show>
              </section>
            )}
          </For>
        </div>
      </Show>
    </div>
  );

  /** The editor form body. `guest` names whoever the reply is being recorded
   *  for — the form reads the same whether or not they answered before. */
  function renderEditorForm(guest: { firstName: string; lastName: string }) {
    return (
      <form
        class="border-gold/30 bg-surface/60 flex flex-col gap-3 rounded-sm border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p class="font-body text-text text-[0.82rem]">
          Recording for{" "}
          <span class="text-gold">
            {guest.firstName} {guest.lastName}
          </span>
        </p>

        <label class="font-body text-text-muted flex flex-col gap-1 text-[0.75rem] tracking-[0.06em] uppercase">
          Status
          <select
            class="border-border bg-bg text-text rounded-sm border px-2.5 py-1.5 text-[0.86rem] normal-case"
            value={formStatus()}
            onChange={(e) => setFormStatus(e.currentTarget.value as RsvpStatus)}
            disabled={saving()}
          >
            <option value="attending">Attending</option>
            <option value="declined">Declined</option>
            <option value="maybe">Maybe</option>
          </select>
        </label>

        <label class="font-body text-text-muted flex flex-col gap-1 text-[0.75rem] tracking-[0.06em] uppercase">
          Dietary requirements (optional)
          <textarea
            class="border-border bg-bg text-text rounded-sm border px-2.5 py-1.5 text-[0.86rem] normal-case"
            rows={2}
            maxlength={500}
            value={formDietary()}
            onInput={(e) => setFormDietary(e.currentTarget.value)}
            disabled={saving()}
          />
        </label>

        <Show when={formDietary().trim().length > 0}>
          <label class="font-body text-text-muted flex items-start gap-2.5 text-[0.78rem] leading-relaxed normal-case">
            <input
              type="checkbox"
              class="accent-gold mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
              checked={formConsent()}
              onChange={(e) => setFormConsent(e.currentTarget.checked)}
              disabled={saving()}
            />
            <span>
              I confirm the guest consented to their dietary requirements being stored and shared
              with the caterers for this wedding.
            </span>
          </label>
        </Show>

        <Show when={formError()}>
          <p class="text-error text-[0.78rem]">{formError()}</p>
        </Show>

        <div class="flex items-center gap-2">
          <button
            type="submit"
            class="bg-gold text-bg rounded-sm px-3 py-1.5 text-[0.78rem] tracking-[0.08em] uppercase disabled:opacity-50"
            disabled={saving()}
          >
            {saving() ? "Saving…" : "Save reply"}
          </button>
          <button
            type="button"
            class="border-border text-text-muted hover:text-text rounded-sm border px-3 py-1.5 text-[0.78rem] tracking-[0.08em] uppercase"
            onClick={closeEditor}
            disabled={saving()}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  /** The editor form wrapped in a full-width row, opened under the row it edits. */
  function renderEditorRow() {
    const target = edit();
    if (!target) return null;
    const [firstName, ...rest] = target.guestName.split(" ");
    return (
      <tr>
        <td colSpan={props.canEdit ? 5 : 4} class="border-border border-b px-4 py-3">
          {renderEditorForm({ firstName: firstName ?? "", lastName: rest.join(" ") })}
        </td>
      </tr>
    );
  }
}

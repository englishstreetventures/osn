import { formatDietaryCell } from "@cire/dietary";
import Button from "@cire/ui/button";
import DietaryPresets from "@cire/ui/dietary-presets-popover";
import { useAuth } from "@shared/rp-auth/solid";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { Table, Td, Th } from "@shared/ui/ui/table";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  mapArray,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";

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
  "flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-ui-sm tracking-ui-wide " +
  "uppercase transition outline-none focus-visible:ring-2";

/** Identifies the row being edited (event + guest) so only one form is open. */
interface EditTarget {
  eventId: string;
  guestId: string;
  guestName: string;
  status: RsvpStatus;
  dietary: string;
  /** May hold a key this build does not know; see `RsvpFilterGuest`. */
  dietaryPresets: readonly string[];
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
  const [state, setState] = createStore<{ events: RsvpViewEvent[] }>({ events: [] });
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  // The control bar: a search box and one status chip, applied to every event.
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<RsvpFilterKey>("all");

  // The open editor form (one at a time), plus its transient field state.
  const [edit, setEdit] = createSignal<EditTarget | null>(null);
  const [formStatus, setFormStatus] = createSignal<RsvpStatus>("attending");
  const [formDietary, setFormDietary] = createSignal("");
  const [formPresets, setFormPresets] = createSignal<readonly string[]>([]);
  const [formConsent, setFormConsent] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [formError, setFormError] = createSignal<string | null>(null);

  const load = async () => {
    try {
      const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/rsvps`));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const body = (await res.json()) as { events: RsvpViewEvent[] };
      setState("events", reconcile(body.events, { key: "id" }));
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Could not load RSVPs. Is the API running?");
    } finally {
      setLoading(false);
    }
  };

  onMount(load);

  const hasEvents = () => state.events.length > 0;

  // A store, not a signal: reload writes patch each event's own fields in
  // place, so an event nothing touched keeps its object identity and <For>
  // leaves its <section> alone. That alone is not enough, though — a plain
  // memo over the whole event list reads every event's guests, so it
  // subscribes to all of them and re-merges every row when any one changes.
  // `mapArray` is the fix: its callback runs once per event,
  // cached by identity, so the per-event row memos below only re-run for the
  // event whose own guests actually changed. Everything reads `sections()`.
  const sections = createMemo(
    mapArray(
      () => state.events,
      (event) => {
        const rows = createMemo(() => mergeRows(event));
        const visible = createMemo(() => filterRows(rows(), query(), filter()));
        return { event, rows, visible };
      },
    ),
  );

  const counts = createMemo(() => statusCounts(sections().map((section) => section.rows())));
  const shownCount = createMemo(() =>
    sections().reduce((total, section) => total + section.visible().length, 0),
  );
  const filtering = () => query().trim().length > 0 || filter() !== "all";

  const openEditor = (
    eventId: string,
    guest: { guestId: string; firstName: string; lastName: string },
    existing?: { status: RsvpStatus; dietary: string; dietaryPresets: readonly string[] },
  ) => {
    setFormError(null);
    setFormStatus(existing?.status ?? "attending");
    setFormDietary(existing?.dietary ?? "");
    setFormPresets(existing?.dietaryPresets ?? []);
    // Prefill consent when editing a row that already carries dietary data —
    // presets or free text, since both are what consent authorises. Mirrors the
    // guest form.
    setFormConsent(
      (existing?.dietary.trim().length ?? 0) > 0 || (existing?.dietaryPresets.length ?? 0) > 0,
    );
    setEdit({
      eventId,
      guestId: guest.guestId,
      guestName: `${guest.firstName} ${guest.lastName}`,
      status: existing?.status ?? "attending",
      dietary: existing?.dietary ?? "",
      dietaryPresets: existing?.dietaryPresets ?? [],
    });
  };

  /** Open the editor on a list row: prefilled when there is a reply to edit,
   *  blank when the guest has said nothing yet. */
  const openRow = (eventId: string, row: RsvpRow) => {
    if (row.responded && row.status !== "none") {
      openEditor(eventId, row, {
        status: row.status,
        dietary: row.dietary,
        dietaryPresets: row.dietaryPresets,
      });
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
    const rows = sections()
      .find((section) => section.event.id === target.eventId)
      ?.visible();
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
    const dietaryPresets = formPresets();
    // Presets are special-category exactly as the free text is, so either one
    // being present is what the attestation has to cover.
    const hasDietaryData = dietary.length > 0 || dietaryPresets.length > 0;
    if (hasDietaryData && !formConsent()) {
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
            dietaryPresets,
            dietaryConsent: hasDietaryData ? formConsent() : false,
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
      // Recorded. The reload that follows patches only the row that changed,
      // but that patch still takes a moment to land — the buzz is what tells
      // the host the save landed, not the redraw.
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
            {() => <div class="bg-surface h-30 animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <Notice tone="danger">{error()}</Notice>
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
            <Field label="Search guests" labelHidden class="min-w-48 flex-1">
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
                    <span class="text-text text-ui-xs font-mono">{counts()[chip.key]}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
          {/* Two readings of one fact: the printed count updates as you type,
              the announced one waits for you to stop. */}
          <p class="font-body text-text-muted text-ui-sm">
            <Show when={filtering()}>
              Showing {shownCount()} of {counts().all} guest rows.
            </Show>
          </p>
          <p role="status" class="sr-only">
            {announcement()}
          </p>
        </div>

        <div class="flex flex-col gap-10">
          <For each={sections()}>
            {(section) => (
              <section class="border-border bg-surface/30 flex flex-col gap-4 rounded-sm border p-5">
                <header class="flex flex-wrap items-end justify-between gap-3">
                  <h3 class="font-display text-text text-ui-lg leading-none font-light">
                    {section.event.name}
                  </h3>
                  <dl class="font-body text-text-muted text-ui-sm flex flex-wrap gap-x-4 gap-y-1">
                    <div class="flex items-center gap-1.5">
                      <dt class="text-gold tracking-ui-wider uppercase">Attending</dt>
                      <dd class="text-text font-mono">{section.event.attending}</dd>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <dt class="tracking-ui-wider uppercase">Declined</dt>
                      <dd class="text-text font-mono">{section.event.declined}</dd>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <dt class="tracking-ui-wider uppercase">Maybe</dt>
                      <dd class="text-text font-mono">{section.event.maybe}</dd>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <dt class="tracking-ui-wider uppercase">No reply</dt>
                      <dd class="text-text font-mono">{section.event.noResponse}</dd>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <dt class="tracking-ui-wider uppercase">Invited</dt>
                      <dd class="text-text font-mono">{section.event.invited}</dd>
                    </div>
                  </dl>
                </header>

                <Show
                  when={section.rows().length > 0}
                  fallback={
                    <p class="font-body text-text-muted text-ui-sm italic">
                      No guests to show for this event.
                    </p>
                  }
                >
                  <Show
                    when={section.visible().length > 0}
                    fallback={
                      <p class="font-body text-text-muted text-ui-sm italic">
                        No guests match this filter.
                      </p>
                    }
                  >
                    {/* Fixed layout, so a search that removes rows never makes
                        the browser measure every remaining cell to size the
                        columns again — auto layout does exactly that on each
                        keystroke. The widths below are what it reads instead:
                        room for the widest badge, button and heading in each
                        column, with Dietary taking what is left. The table's
                        floor is their sum, so a phone scrolls the region
                        sideways rather than crushing the columns. `class` lands
                        on the scrolling <section>, hence the `[&>table]` reach. */}
                    <Table
                      label={`Replies for ${section.event.name}`}
                      class={
                        props.canEdit
                          ? "[&>table]:w-[max(100%,45rem)] [&>table]:table-fixed"
                          : "[&>table]:w-[max(100%,37rem)] [&>table]:table-fixed"
                      }
                    >
                      <caption class="sr-only">RSVPs for {section.event.name}</caption>
                      <colgroup>
                        <col class="w-48" />
                        <col class="w-36" />
                        <col class="w-36" />
                        <col />
                        <Show when={props.canEdit}>
                          <col class="w-32" />
                        </Show>
                      </colgroup>
                      <thead>
                        <tr>
                          <Th>Guest</Th>
                          <Th>Household</Th>
                          <Th>Status</Th>
                          <Th>Dietary</Th>
                          <Show when={props.canEdit}>
                            <Th align="end">
                              <span class="sr-only">Actions</span>
                            </Th>
                          </Show>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={section.visible()}>
                          {(row) => (
                            <>
                              <tr class="hover:[&>td]:bg-surface">
                                {/* The text columns break a word that will not
                                    fit: under fixed layout a long name no
                                    longer widens its column, it spills into the
                                    next one. */}
                                <Td valign="middle" class="wrap-break-word">
                                  {row.firstName} {row.lastName}
                                  <Show when={row.consentSource === "organiser_attested"}>
                                    {" "}
                                    <span
                                      class="border-gold/40 text-gold text-ui-xs tracking-ui-wider ml-1 inline-block rounded-sm border px-1.5 py-0.5 uppercase"
                                      title="Recorded by a host (phone/paper RSVP)"
                                    >
                                      Host-entered
                                    </span>
                                  </Show>
                                </Td>
                                <Td tone="muted" valign="middle" class="wrap-break-word">
                                  {row.familyName}
                                </Td>
                                <Td valign="middle">
                                  <span
                                    class={`font-body text-ui-xs tracking-ui-widest inline-block rounded-sm px-1.5 py-0.5 uppercase ${STATUS_META[row.status].class}`}
                                  >
                                    {STATUS_META[row.status].label}
                                  </span>
                                </Td>
                                <Td tone="muted" valign="middle" class="wrap-break-word">
                                  {/* The whole answer, presets and free text,
                                      rendered the way the caterer's sheet
                                      renders it. Showing `dietary` alone left a
                                      preset-only reply blank — a host could
                                      find the row by searching "nuts" and then
                                      see nothing in it. */}
                                  <Show
                                    when={formatDietaryCell(row.dietaryPresets, row.dietary)}
                                    fallback={<span class="text-text-muted">--</span>}
                                  >
                                    {(cell) => cell()}
                                  </Show>
                                </Td>
                                <Show when={props.canEdit}>
                                  <Td align="end" valign="middle">
                                    <Button
                                      variant="quiet"
                                      size="sm"
                                      type="button"
                                      aria-label={`${row.responded ? "Edit" : "Record"} reply for ${row.firstName} ${row.lastName}`}
                                      onClick={() => openRow(section.event.id, row)}
                                    >
                                      {row.responded ? "Edit" : "Record"}
                                    </Button>
                                  </Td>
                                </Show>
                              </tr>
                              <Show
                                when={props.canEdit && isEditing(section.event.id, row.guestId)}
                              >
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
        <p class="font-body text-text text-ui-sm">
          Recording for{" "}
          <span class="text-gold">
            {guest.firstName} {guest.lastName}
          </span>
        </p>

        <label class="font-body text-text-muted text-ui-sm tracking-ui-wide flex flex-col gap-1 uppercase">
          Status
          <select
            class="border-border bg-bg text-text text-ui-base rounded-sm border px-2.5 py-1.5 normal-case"
            value={formStatus()}
            onChange={(e) => setFormStatus(e.currentTarget.value as RsvpStatus)}
            disabled={saving()}
          >
            <option value="attending">Attending</option>
            <option value="declined">Declined</option>
            <option value="maybe">Maybe</option>
          </select>
        </label>

        <div class="font-body text-text-muted text-ui-sm tracking-ui-wide flex flex-col gap-1.5 uppercase">
          Dietary requirements (optional)
          <div class="normal-case">
            <DietaryPresets
              value={formPresets()}
              onChange={setFormPresets}
              disabled={saving()}
              label={`Dietary requirements for ${guest.firstName} ${guest.lastName}`}
            />
          </div>
        </div>

        {/* Free text for whatever the vocabulary has no key for. Always shown
            here rather than behind an "Other" tick: an organiser is copying
            down a reply someone gave on the phone, so the box has to be ready
            for words they are already hearing. */}
        <label class="font-body text-text-muted text-ui-sm tracking-ui-wide flex flex-col gap-1 uppercase">
          Anything else
          <textarea
            class="border-border bg-bg text-text text-ui-base rounded-sm border px-2.5 py-1.5 normal-case"
            rows={2}
            maxlength={500}
            value={formDietary()}
            onInput={(e) => setFormDietary(e.currentTarget.value)}
            disabled={saving()}
          />
        </label>

        {/* Gated on the SAME condition the submit gate and the payload use.
            Gating visibility on the free text alone left a preset-only reply
            attested with no control on screen, and re-stamped that attestation
            on every save. */}
        <Show when={formDietary().trim().length > 0 || formPresets().length > 0}>
          <label class="font-body text-text-muted text-ui-sm flex items-start gap-2.5 leading-relaxed normal-case">
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
          <p class="text-error text-ui-sm">{formError()}</p>
        </Show>

        <div class="flex items-center gap-2">
          {/* Both at the default size, which they were not: Cancel was already a
              `<Button>` at `md` and Save was hand-written at `px-3 py-1.5`, so
              the two controls in this one row were different heights. */}
          <Button variant="primary" type="submit" disabled={saving()}>
            {saving() ? "Saving…" : "Save reply"}
          </Button>
          <Button variant="quiet" type="button" onClick={closeEditor} disabled={saving()}>
            Cancel
          </Button>
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

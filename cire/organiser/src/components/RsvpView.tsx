import { useAuth } from "@osn/client/solid";
import { createSignal, For, onMount, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import SectionIntro from "./SectionIntro";

interface RsvpViewProps {
  weddingId: string;
  /** Owner/editor may record RSVPs; a viewer sees the read-only summary only. */
  canEdit?: boolean;
}

type RsvpStatus = "attending" | "declined" | "maybe";
type ConsentSource = "guest" | "organiser_attested";

interface RsvpViewGuest {
  guestId: string;
  firstName: string;
  lastName: string;
  familyName: string;
  familyCode: string;
  status: RsvpStatus;
  dietary: string;
  consentSource: ConsentSource;
}

interface RsvpViewInvitedGuest {
  guestId: string;
  firstName: string;
  lastName: string;
  familyName: string;
  familyCode: string;
}

interface RsvpViewEvent {
  id: string;
  name: string;
  invited: number;
  attending: number;
  declined: number;
  maybe: number;
  responded: number;
  noResponse: number;
  guests: RsvpViewGuest[];
  unresponded: RsvpViewInvitedGuest[];
}

/** Human label + badge styling per RSVP status. */
const STATUS_META: Record<RsvpStatus, { label: string; class: string }> = {
  attending: { label: "Attending", class: "bg-gold text-bg" },
  declined: { label: "Declined", class: "border-error/40 text-error border" },
  maybe: { label: "Maybe", class: "border-gold/40 text-gold border" },
};

/** Identifies the row being edited (event + guest) so only one form is open. */
interface EditTarget {
  eventId: string;
  guestId: string;
  guestName: string;
  status: RsvpStatus;
  dietary: string;
}

/**
 * In-dashboard RSVP summary. Per event: a status tally and the guests who
 * responded, with status + dietary + a provenance badge (organiser-entered vs
 * guest-submitted). Editors additionally get a "Record / edit" affordance to
 * enter a phone/paper RSVP on a guest's behalf — the API stamps such rows
 * `consent_source='organiser_attested'` and they VISIBLY OVERWRITE a prior
 * guest reply (platform-plan §3.3). Viewers see the read-only view.
 */
export default function RsvpView(props: RsvpViewProps) {
  const { authFetch } = useAuth();
  const [events, setEvents] = createSignal<RsvpViewEvent[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

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
  const hasReplies = (event: RsvpViewEvent) => event.guests.length > 0;

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

  const closeEditor = () => {
    setEdit(null);
    setSaving(false);
    setFormError(null);
  };

  const isEditing = (eventId: string, guestId: string) => {
    const e = edit();
    return e !== null && e.eventId === eventId && e.guestId === guestId;
  };

  const save = async () => {
    const target = edit();
    if (!target) return;
    const dietary = formDietary().trim();
    if (dietary.length > 0 && !formConsent()) {
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
        setFormError("You don't have permission to record RSVPs.");
        setSaving(false);
        return;
      }
      if (!res.ok) {
        setFormError("Could not save this RSVP. Please try again.");
        setSaving(false);
        return;
      }
      closeEditor();
      await load();
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
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
            ? "Who's coming to each event, with dietary notes. Record a phone or paper reply on a guest's behalf — it overwrites any earlier answer and is marked as organiser-entered."
            : "Who's coming to each event, with dietary notes — updated as guests reply. Read-only; download the full sheet from the Guests tab."
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
        <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
          {error()}
        </p>
      </Show>

      <Show when={!loading() && !error() && !hasEvents()}>
        <div class="border-border bg-surface/30 flex flex-col items-start gap-2 rounded-sm border border-dashed p-8 text-center">
          <p class="font-display text-gold-dim w-full text-[1.2rem] italic">No events yet</p>
          <p class="font-body text-text-muted w-full text-[0.85rem] leading-relaxed">
            Add your events and invite guests — their replies will appear here.
          </p>
        </div>
      </Show>

      <Show when={!loading() && !error() && hasEvents()}>
        <div class="flex flex-col gap-10">
          <For each={events()}>
            {(event) => (
              <section class="border-border bg-surface/30 flex flex-col gap-4 rounded-sm border p-5">
                <header class="flex flex-wrap items-end justify-between gap-3">
                  <h3 class="font-display text-text text-[1.3rem] leading-none font-light italic">
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
                  when={hasReplies(event)}
                  fallback={
                    <p class="font-body text-text-muted text-[0.82rem] italic">
                      No replies yet for this event.
                    </p>
                  }
                >
                  <div class="overflow-x-auto">
                    <table class="font-body w-full border-collapse text-[0.86rem]">
                      <caption class="sr-only">RSVPs for {event.name}</caption>
                      <thead>
                        <tr>
                          <th
                            scope="col"
                            class="border-border text-gold border-b px-4 py-2.5 text-left text-[0.7rem] font-normal tracking-[0.1em] whitespace-nowrap uppercase"
                          >
                            Guest
                          </th>
                          <th
                            scope="col"
                            class="border-border text-gold border-b px-4 py-2.5 text-left text-[0.7rem] font-normal tracking-[0.1em] whitespace-nowrap uppercase"
                          >
                            Household
                          </th>
                          <th
                            scope="col"
                            class="border-border text-gold border-b px-4 py-2.5 text-left text-[0.7rem] font-normal tracking-[0.1em] whitespace-nowrap uppercase"
                          >
                            Status
                          </th>
                          <th
                            scope="col"
                            class="border-border text-gold border-b px-4 py-2.5 text-left text-[0.7rem] font-normal tracking-[0.1em] whitespace-nowrap uppercase"
                          >
                            Dietary
                          </th>
                          <Show when={props.canEdit}>
                            <th
                              scope="col"
                              class="border-border text-gold border-b px-4 py-2.5 text-right text-[0.7rem] font-normal tracking-[0.1em] whitespace-nowrap uppercase"
                            >
                              <span class="sr-only">Actions</span>
                            </th>
                          </Show>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={event.guests}>
                          {(guest) => (
                            <>
                              <tr class="hover:[&>td]:bg-surface">
                                <td class="border-border text-text border-b px-4 py-2.5 align-middle">
                                  {guest.firstName} {guest.lastName}
                                  <Show when={guest.consentSource === "organiser_attested"}>
                                    {" "}
                                    <span
                                      class="border-gold/40 text-gold ml-1 inline-block rounded-sm border px-1.5 py-0.5 text-[0.55rem] tracking-[0.12em] uppercase"
                                      title="Recorded by an organiser (phone/paper RSVP)"
                                    >
                                      Organiser-entered
                                    </span>
                                  </Show>
                                </td>
                                <td class="border-border text-text-muted border-b px-4 py-2.5 align-middle">
                                  {guest.familyName}
                                </td>
                                <td class="border-border border-b px-4 py-2.5 align-middle">
                                  <span
                                    class={`font-body inline-block rounded-sm px-1.5 py-0.5 text-[0.6rem] tracking-[0.14em] uppercase ${STATUS_META[guest.status].class}`}
                                  >
                                    {STATUS_META[guest.status].label}
                                  </span>
                                </td>
                                <td class="border-border text-text-muted border-b px-4 py-2.5 align-middle">
                                  <Show
                                    when={guest.dietary.trim().length > 0}
                                    fallback={<span class="text-text-muted">--</span>}
                                  >
                                    {guest.dietary}
                                  </Show>
                                </td>
                                <Show when={props.canEdit}>
                                  <td class="border-border border-b px-4 py-2.5 text-right align-middle">
                                    <button
                                      type="button"
                                      class="border-border text-text-muted hover:text-text hover:border-gold/40 rounded-sm border px-2.5 py-1 text-[0.7rem] tracking-[0.08em] uppercase"
                                      onClick={() =>
                                        openEditor(event.id, guest, {
                                          status: guest.status,
                                          dietary: guest.dietary,
                                        })
                                      }
                                    >
                                      Edit
                                    </button>
                                  </td>
                                </Show>
                              </tr>
                              <Show when={props.canEdit && isEditing(event.id, guest.guestId)}>
                                {renderEditorRow()}
                              </Show>
                            </>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>

                {/* Record a reply for an invited guest who hasn't responded. */}
                <Show when={props.canEdit && event.unresponded.length > 0}>
                  <details class="border-border bg-surface/40 rounded-sm border">
                    <summary class="font-body text-text-muted hover:text-text cursor-pointer px-4 py-2.5 text-[0.78rem]">
                      Record a reply for another guest ({event.unresponded.length} awaiting)
                    </summary>
                    <ul class="flex flex-col gap-1 px-4 pb-3">
                      <For each={event.unresponded}>
                        {(guest) => (
                          <li>
                            <Show
                              when={isEditing(event.id, guest.guestId)}
                              fallback={
                                <button
                                  type="button"
                                  class="text-text-muted hover:text-gold flex w-full items-center justify-between gap-3 py-1.5 text-left text-[0.84rem]"
                                  onClick={() => openEditor(event.id, guest)}
                                >
                                  <span>
                                    {guest.firstName} {guest.lastName}
                                    <span class="text-text-muted"> — {guest.familyName}</span>
                                  </span>
                                  <span class="text-gold text-[0.72rem] tracking-[0.08em] uppercase">
                                    Record
                                  </span>
                                </button>
                              }
                            >
                              <div class="py-2">{renderEditorForm(guest)}</div>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </details>
                </Show>
              </section>
            )}
          </For>
        </div>
      </Show>
    </div>
  );

  /** The editor form body, shared by the responded-row and unresponded-list
   *  entry points. `label` names the guest being edited. */
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

  /** The editor form wrapped in a full-width table row (for the responded table). */
  function renderEditorRow() {
    const target = edit();
    if (!target) return null;
    const [firstName, ...rest] = target.guestName.split(" ");
    return (
      <tr>
        <td colSpan={5} class="border-border border-b px-4 py-3">
          {renderEditorForm({ firstName: firstName ?? "", lastName: rest.join(" ") })}
        </td>
      </tr>
    );
  }
}

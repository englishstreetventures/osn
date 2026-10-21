// The guest + event editor DRAFT store (guest+event editor E5, §8).
//
// Loads the wedding's current server state into a mutable, id-stable SolidJS
// store, tracks dirtiness against the loaded baseline, and (on Save) serialises
// the draft into a DesiredState JSON the `changes/preview` front door consumes.
// The editor front door diffs with `removeManual: true`, so an omitted row reads
// as a delete for whichever half the save's `scope` covers. GuestsEditor saves
// `scope: "guests"` and carries the events only for its attendance columns;
// EventsEditor saves `scope: "events"` and leaves guests/households empty, which
// is safe because the scope tells the diff to leave that half alone.
//
// The draft also holds the change head it was loaded at (`baseRevision`): the
// save sends it, and the API refuses a draft once the head has moved, because a
// row committed since the load would otherwise read as a removal. `rebase`
// recovers from that refusal: it re-seeds from rows loaded at the new head and
// replays the organiser's unsaved edits on top (`replayDraft`).
//
// In-session UNDO + "discard draft" are pure client state: every mutation pushes
// the prior snapshot onto an undo stack, so undo/discard are local — no server
// round-trips while editing (§8). Nothing here talks to the network; the caller
// owns fetch/preview/apply.
//
// Effect is deliberately NOT imported — this is frontend code (cire CLAUDE.md:
// "Effect is backend + DB only — never import it in cire/invites or cire/host").
// Plain Solid primitives + a structural clone, matching events-/guests-store.
import { normaliseGuestEmail, parseGuestEmail } from "@cire/guest-email";
import { batch, createMemo, createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";

import { isDateOnly } from "./event-datetime";
import {
  type ChildrenPolicy,
  isClockTime,
  MAX_RUN_OF_SHOW_ITEMS,
  MAX_RUN_OF_SHOW_LABEL,
  type PlusOnePolicy,
} from "./event-guest-details";
import type { EventRow } from "./events-store";
import {
  isBlankName,
  isHttpUrl,
  isIsoTimestamp,
  isPaletteColorSafe,
  MAX_CELL_LENGTH,
  normaliseName,
} from "./guest-validation";
import type { OrganiserGuestRow } from "./guests-store";
import type { OrganiserHouseholdRow } from "./households-store";
import { browserTimeZone } from "./timezones";

// ── Draft row shapes ─────────────────────────────────────────────────────────
//
// Rows carry a client-only `key` for stable `<For>` identity + a nullable `id`:
// an EXISTING row keeps its server id (so a rename is an update, not remove+
// create), a NEW row has `id: null` (the reconcile mints one server-side).

/** A monotonic client-only key generator for freshly-added rows. */
let keySeq = 0;
const nextKey = () => `new-${++keySeq}`;

/** One item of an event's run of show, as the drawer edits it. */
export interface DraftRunOfShowItem {
  /** Stable `<For>` key (client-only; never sent). */
  readonly key: string;
  /** A 24-hour `HH:MM` in the event's zone, or `""` while not yet set. */
  time: string;
  label: string;
}

export interface DraftEvent {
  /** Stable `<For>` key (client-only; never sent). */
  readonly key: string;
  /** Server id, or `null` for a row added in this session. */
  id: string | null;
  name: string;
  // The remaining event fields are carried verbatim for round-trip fidelity.
  // E5 never mutates them (events are display-only here); E6 will.
  startAt: string;
  endAt: string;
  timezone: string;
  /** The event's About text; `""` when it has none (the column is NOT NULL). */
  description: string;
  /** The venue's name, shown above the address; null when it has none. */
  venueName: string | null;
  address: string | null;
  /** The run of show in the organiser's order; the guest reads it in time order. */
  runOfShow: DraftRunOfShowItem[];
  /** Parking, transport and accessibility notes; null when there are none. */
  gettingThere: string | null;
  /** The guest policy: two presets (null ⇒ not stated) and a note. */
  childrenPolicy: ChildrenPolicy | null;
  plusOnePolicy: PlusOnePolicy | null;
  guestPolicyNote: string | null;
  dressCodeDescription: string | null;
  dressCodePalette: { name: string; color: string }[];
  pinterestUrl: string | null;
  mapsUrl: string | null;
  sortOrder: number;
}

/** The event fields the drawer form edits (everything on {@link DraftEvent}
 *  except the client `key`, the server `id`, and `sortOrder` — those are managed
 *  by the store, not typed into the form). */
export type EventPatch = Partial<
  Pick<
    DraftEvent,
    | "name"
    | "startAt"
    | "endAt"
    | "timezone"
    | "description"
    | "venueName"
    | "address"
    | "runOfShow"
    | "gettingThere"
    | "childrenPolicy"
    | "plusOnePolicy"
    | "guestPolicyNote"
    | "dressCodeDescription"
    | "dressCodePalette"
    | "pinterestUrl"
    | "mapsUrl"
  >
>;

/** A fresh run-of-show item with its own `<For>` key. */
export function runOfShowItem(time = "", label = ""): DraftRunOfShowItem {
  return { key: nextKey(), time, label };
}

export interface DraftGuest {
  readonly key: string;
  id: string | null;
  firstName: string;
  lastName: string;
  nickname: string | null;
  /**
   * The guest's address as the organiser sees and edits it: `""` for none.
   * Absent when the rows came from an API older than the column, and then the
   * draft says nothing about addresses.
   */
  email?: string;
  /**
   * The address as loaded, never edited. The draft sends an address only when
   * `email` differs from it, and sends it back as `emailExpected`, so a save
   * never touches an address the organiser did not change, and never
   * overwrites one a guest saved since the load.
   */
  emailLoaded?: string;
  /** Who gave the loaded address. A guest's own is read-only in the editor:
   *  the organiser may remove it, never change it. */
  emailSource?: "guest" | "organiser_attested" | null;
  /** Client keys of the events this guest attends (matrix cells). Kept as event
   *  KEYS (not ids) so a not-yet-saved event could be referenced later in E6;
   *  serialisation resolves keys → the event's current name for the wire. */
  eventKeys: string[];
}

export interface DraftFamily {
  readonly key: string;
  id: string | null;
  /** Family claim code (`publicId`). Existing households keep theirs so a rename
   *  never re-mints; new households get `null` (the reconcile auto-mints, exactly
   *  like the import — households are ALWAYS coded). */
  publicId: string | null;
  familyName: string;
  guests: DraftGuest[];
}

export interface DraftState {
  events: DraftEvent[];
  families: DraftFamily[];
}

// ── DesiredState wire shapes (mirror cire/api schemas/import.ts) ──────────────
// The editor front door POSTs `{ desiredState: DesiredState }` to changes/preview.
// These are the field-level shapes `diffAgainstDb` reconciles TO — kept in sync
// with `cire/api/src/schemas/import.ts` (DesiredState / ParsedEvent / ParsedFamily
// / ParsedGuest). SOURCE OF TRUTH: that file; this is the client mirror.

interface WireGuest {
  id?: string;
  firstName: string;
  lastName: string;
  nickname: string | null;
  eventNames: string[];
  /** Present only for a guest whose address the organiser changed: `null`
   *  removes it. */
  email?: string | null;
  /** The address the editor loaded, sent with `email`. */
  emailExpected?: string | null;
}
interface WireFamily {
  id?: string;
  publicId?: string;
  familyName: string;
  guests: WireGuest[];
}
interface WireEvent {
  id?: string;
  name: string;
  startAt: string;
  endAt: string;
  timezone: string;
  /** Required by cire-api releases older than the venue name; the current API
   *  ignores it. Always null. */
  location: null;
  /** Left out of a guests save, which governs no event; absent leaves the
   *  stored value. */
  description?: string;
  venueName?: string | null;
  runOfShow?: { time: string; label: string }[];
  gettingThere?: string | null;
  childrenPolicy?: ChildrenPolicy | null;
  plusOnePolicy?: PlusOnePolicy | null;
  guestPolicyNote?: string | null;
  address: string | null;
  dressCodeDescription: string | null;
  dressCodePalette: { name: string; color: string }[];
  pinterestUrl: string | null;
  mapsUrl: string | null;
  sortOrder: number;
}
export interface DesiredStateWire {
  events: WireEvent[];
  families: WireFamily[];
}

// ── Load: server rows → draft ─────────────────────────────────────────────────

/**
 * Whether the API these rows came from reads an event's run of show, notes and
 * guest policy: it sends `runOfShow` on every event. One older than them sends
 * none, and drops them from a save unstored, so the drawer hides them and the
 * save leaves them out. With no events there is nothing to tell by; the API is
 * taken to be current, the one a deploy order of API first gives.
 */
export function readsEventDetails(events: readonly EventRow[]): boolean {
  return events.every((e) => "runOfShow" in e);
}

/**
 * Build a draft from the cached server reads. Events come from the shared events
 * cache (the schedule the guests are invited to); guests come from the flat
 * organiser guest rows (one row per guest, grouped here into households by
 * `familyId`). Attendance is resolved event-id → event key so the matrix is
 * keyed the same way the draft references events.
 *
 * `households` is the household-shaped read, and it is load-bearing rather than
 * decorative: the guest rows can only describe households that HOLD a guest, so
 * a code-only household (added and not yet filled, or emptied by an earlier
 * save) would be missing from the draft — and since the draft is the whole truth
 * for a save, missing reads as DELETED. The pass below appends any household the
 * guest rows didn't cover, so it shows up as an empty card the organiser can
 * fill in or delete on purpose. Appended (not merged in place) so the existing
 * first-seen-guest ordering of populated households is unchanged.
 */
function buildDraft(
  events: EventRow[],
  guests: OrganiserGuestRow[],
  households: OrganiserHouseholdRow[] = [],
): DraftState {
  const draftEvents: DraftEvent[] = events
    .toSorted((a, b) => a.sortOrder - b.sortOrder)
    .map((e) => ({
      key: nextKey(),
      id: e.id,
      name: e.name,
      startAt: e.startAt,
      endAt: e.endAt,
      timezone: e.timezone,
      description: e.description,
      // Absent from an API older than the column: no name.
      venueName: e.venueName ?? null,
      address: e.address,
      // Absent from an API older than them: none of each.
      runOfShow: (e.runOfShow ?? []).map((item) => runOfShowItem(item.time, item.label)),
      gettingThere: e.gettingThere ?? null,
      childrenPolicy: e.childrenPolicy ?? null,
      plusOnePolicy: e.plusOnePolicy ?? null,
      guestPolicyNote: e.guestPolicyNote ?? null,
      dressCodeDescription: e.dressCodeDescription,
      dressCodePalette: (e.dressCodePalette ?? []).map((s) => ({ name: s.name, color: s.color })),
      pinterestUrl: e.pinterestUrl,
      mapsUrl: e.mapsUrl,
      sortOrder: e.sortOrder,
    }));

  const eventKeyById = new Map(draftEvents.filter((e) => e.id).map((e) => [e.id!, e.key]));

  // Group the flat guest rows into households, preserving first-seen order.
  // A plus-one stays out: the household names and removes them, and the save
  // never matches one, so a draft that carried their id could only go stale —
  // once the household removed them, the save would be refused.
  const byFamily = new Map<string, DraftFamily>();
  for (const g of guests) {
    if (g.plusOneOf !== undefined && g.plusOneOf !== null) continue;
    let fam = byFamily.get(g.familyId);
    if (!fam) {
      fam = {
        key: nextKey(),
        id: g.familyId,
        publicId: g.publicId,
        familyName: g.familyName,
        guests: [],
      };
      byFamily.set(g.familyId, fam);
    }
    const guest: DraftGuest = {
      key: nextKey(),
      id: g.guestId,
      firstName: g.firstName,
      lastName: g.lastName,
      nickname: g.nickname,
      // Resolve invited event ids → the draft's event keys; drop any dangling id
      // (an event removed out from under us) defensively.
      eventKeys: g.events.map((id) => eventKeyById.get(id)).filter((k): k is string => Boolean(k)),
    };
    // A row from an API older than addresses carries no `email`; the draft
    // then says nothing about addresses.
    if (g.email !== undefined) {
      guest.email = g.email ?? "";
      guest.emailLoaded = g.email ?? "";
      guest.emailSource = g.emailSource ?? null;
    }
    fam.guests.push(guest);
  }

  for (const h of households) {
    if (byFamily.has(h.familyId)) continue;
    byFamily.set(h.familyId, {
      key: nextKey(),
      id: h.familyId,
      publicId: h.publicId,
      familyName: h.familyName,
      guests: [],
    });
  }

  return { events: draftEvents, families: Array.from(byFamily.values()) };
}

// ── Serialise: draft → DesiredState wire ──────────────────────────────────────

/** The text trimmed, or null when nothing is left. */
function trimmedOrNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Serialise the draft into the DesiredState the editor front door POSTs. Existing
 * rows send their `id` (rename-safe update); new rows omit it (server mints).
 * Attendance is emitted as event NAMES (the wire's `eventNames`), resolved from
 * each guest's event keys through the draft's current event list — so ticking a
 * box after renaming an event still links the right event.
 *
 * `scope` is the save's: a `"guests"` save governs no event, so its events
 * leave out the description and venue name, which can run long and which the
 * server would only store with the change; absent means "leave as stored".
 *
 * `eventDetails` says whether the API reads an event's run of show, notes and
 * guest policy ({@link readsEventDetails}). When it does not, they are left out
 * too, so nothing is sent that would be dropped unstored.
 */
export function toDesiredState(
  draft: DraftState,
  scope: "events" | "guests" | "both" = "both",
  eventDetails = true,
): DesiredStateWire {
  const eventNameByKey = new Map(draft.events.map((e) => [e.key, e.name]));

  const events: WireEvent[] = draft.events.map((e) => {
    const wire: WireEvent = {
      name: e.name,
      startAt: e.startAt,
      endAt: e.endAt,
      timezone: e.timezone,
      // Kept, null, because a cire-api older than the venue name requires it:
      // such an API still takes the save during a deploy, and the current API
      // keeps the key in the change it stores, so that change still applies
      // after a rollback. An older API drops `description` and `venueName`, so
      // values typed while it serves are not stored.
      location: null,
      address: e.address,
      dressCodeDescription: e.dressCodeDescription,
      dressCodePalette: e.dressCodePalette.map((s) => ({ name: s.name, color: s.color })),
      pinterestUrl: e.pinterestUrl,
      mapsUrl: e.mapsUrl,
      sortOrder: e.sortOrder,
    };
    if (scope !== "guests") {
      wire.description = e.description;
      wire.venueName = e.venueName;
    }
    if (scope !== "guests" && eventDetails) {
      // Trimmed, and blank notes are none, so what is stored is what a
      // download writes and a re-upload of it reads back unchanged.
      wire.runOfShow = e.runOfShow.map((item) => ({ time: item.time, label: item.label.trim() }));
      wire.gettingThere = trimmedOrNull(e.gettingThere);
      wire.childrenPolicy = e.childrenPolicy;
      wire.plusOnePolicy = e.plusOnePolicy;
      wire.guestPolicyNote = trimmedOrNull(e.guestPolicyNote);
    }
    if (e.id) wire.id = e.id;
    return wire;
  });

  const families: WireFamily[] = draft.families.map((f) => {
    const wire: WireFamily = {
      familyName: f.familyName,
      guests: f.guests.map((g) => {
        const guest: WireGuest = {
          firstName: g.firstName,
          lastName: g.lastName,
          nickname: g.nickname && g.nickname.trim().length > 0 ? g.nickname.trim() : null,
          eventNames: g.eventKeys
            .map((k) => eventNameByKey.get(k))
            .filter((n): n is string => Boolean(n)),
        };
        if (g.id) guest.id = g.id;
        const email = emailEdit(g);
        if (email) {
          guest.email = email.email;
          guest.emailExpected = email.expected;
        }
        return guest;
      }),
    };
    if (f.id) wire.id = f.id;
    if (f.publicId) wire.publicId = f.publicId;
    return wire;
  });

  return { events, families };
}

/** The error a guest row carries when its address is not one address. */
export const EMAIL_ERROR = "Enter one email address, like name@example.com.";

/** An address in the form the server stores, or null for none. */
function storedEmail(value: string | undefined): string | null {
  const stored = normaliseGuestEmail(value ?? "");
  return stored.length === 0 ? null : stored;
}

/**
 * The address change a guest row sends, or null when the organiser made none.
 * Comparing stored forms means retyping the same address in another case, or
 * with spaces around it, is no change.
 */
function emailEdit(g: DraftGuest): { email: string | null; expected: string | null } | null {
  if (g.email === undefined) return null;
  const email = storedEmail(g.email);
  const expected = storedEmail(g.emailLoaded);
  return email === expected ? null : { email, expected };
}

// ── Replay: keep unsaved edits across a reload ────────────────────────────────

/** The event fields an organiser edits, compared one by one on replay.
 *  `sortOrder` is not one: removing or reordering renumbers every event, so
 *  order is replayed from the sequence of ids instead. */
const EVENT_FIELDS = [
  "name",
  "startAt",
  "endAt",
  "timezone",
  "description",
  "venueName",
  "address",
  "runOfShow",
  "gettingThere",
  "childrenPolicy",
  "plusOnePolicy",
  "guestPolicyNote",
  "dressCodeDescription",
  "dressCodePalette",
  "pinterestUrl",
  "mapsUrl",
] as const;

const GUEST_FIELDS = ["firstName", "lastName", "nickname", "email"] as const;

/** Equal as values. A run of show's client keys are not part of its value:
 *  the fresh rows carry new ones for the same items. */
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a, (k, v: unknown) => (k === "key" ? undefined : v)) ===
  JSON.stringify(b, (k, v: unknown) => (k === "key" ? undefined : v));
const quoted = (name: string) => `“${name.trim() || "Untitled"}”`;

/** What {@link replayDraft} made of the organiser's edits. */
export interface ReplayResult {
  /** The fresh rows with the organiser's edits applied on top. */
  readonly draft: DraftState;
  /** One sentence per edit that could not be kept, or that needs a second look. */
  readonly notes: string[];
}

/**
 * Replay the organiser's unsaved edits onto rows loaded after someone else's
 * change landed, so a stale draft can be saved without redoing the work.
 *
 * The edits are the difference between `baseline` (the rows the draft was
 * loaded from) and `current` (the draft as it stands); both share draft keys,
 * and existing rows are matched to `fresh` by server id:
 *  - a field the organiser changed takes their value, even where the other
 *    change set it too; a field they left alone takes the fresh value;
 *  - a row they removed is removed; a row they added is added, and stays new;
 *  - attendance is replayed as ticks and unticks against the baseline, so a
 *    co-host's own ticks on the same guest survive;
 *  - event order is replayed only when the organiser reordered, as the order
 *    of the events both lists hold; events added elsewhere go last.
 *
 * `notes` names each edit that no longer applies (its row was deleted
 * elsewhere), each new row whose name was also added elsewhere (it may be a
 * duplicate — including the organiser's own save, if that landed without the
 * editor hearing back), and each household the organiser removed that has
 * since gained guests, which go with it.
 */
export function replayDraft(
  baseline: DraftState,
  current: DraftState,
  fresh: DraftState,
): ReplayResult {
  const notes: string[] = [];
  const out: DraftState = structuredClone(fresh);

  // ── Events ──
  const baseEventById = new Map(baseline.events.filter((e) => e.id).map((e) => [e.id!, e]));
  const curEventById = new Map(current.events.filter((e) => e.id).map((e) => [e.id!, e]));
  const freshEventNames = new Set(out.events.map((e) => normaliseName(e.name)));
  const baseEventNames = new Set(baseline.events.map((e) => normaliseName(e.name)));

  /** Current-draft event key → key of the same event in the result. */
  const eventKeyMap = new Map<string, string>();
  const keptEvents: DraftEvent[] = [];
  for (const evt of out.events) {
    const base = evt.id ? baseEventById.get(evt.id) : undefined;
    const cur = evt.id ? curEventById.get(evt.id) : undefined;
    if (base && !cur) continue; // removed by the organiser
    if (base && cur) {
      for (const field of EVENT_FIELDS) {
        if (!same(cur[field], base[field])) {
          Object.assign(evt, { [field]: structuredClone(cur[field]) });
        }
      }
      eventKeyMap.set(cur.key, evt.key);
    }
    keptEvents.push(evt);
  }
  const freshEventIds = new Set(out.events.map((e) => e.id));
  for (const cur of current.events) {
    if (!cur.id || freshEventIds.has(cur.id)) continue;
    const base = baseEventById.get(cur.id);
    if (base && EVENT_FIELDS.some((f) => !same(cur[f], base[f]))) {
      notes.push(`${quoted(cur.name)} was deleted elsewhere, so your changes to it were not kept.`);
    }
  }
  const addedEvents = current.events.filter((e) => !e.id).map((e) => structuredClone(e));
  for (const evt of addedEvents) {
    eventKeyMap.set(evt.key, evt.key);
    const norm = normaliseName(evt.name);
    if (norm && freshEventNames.has(norm) && !baseEventNames.has(norm)) {
      notes.push(
        `An event called ${quoted(evt.name)} was also added elsewhere — check for a duplicate.`,
      );
    }
  }

  // Reordered = the ids both lists still hold appear in a different order.
  const baseOrder = baseline.events.filter((e) => e.id && curEventById.has(e.id)).map((e) => e.id);
  const curOrder = current.events.filter((e) => e.id && baseEventById.has(e.id)).map((e) => e.id);
  let ordered: DraftEvent[];
  if (!same(baseOrder, curOrder)) {
    const position = new Map(current.events.map((e, i) => [e.key, i]));
    const resultToCurrent = new Map([...eventKeyMap].map(([c, r]) => [r, c]));
    const placed = [...keptEvents, ...addedEvents].filter((e) => resultToCurrent.has(e.key));
    placed.sort(
      (a, b) =>
        position.get(resultToCurrent.get(a.key)!)! - position.get(resultToCurrent.get(b.key)!)!,
    );
    ordered = [...placed, ...keptEvents.filter((e) => !resultToCurrent.has(e.key))];
  } else {
    ordered = [...keptEvents, ...addedEvents];
  }
  ordered.forEach((e, i) => {
    e.sortOrder = i;
  });
  out.events = ordered;
  const resultEventKeys = new Set(ordered.map((e) => e.key));
  const eventNameByCurrentKey = new Map(current.events.map((e) => [e.key, e.name]));

  /** Map the organiser's attendance keys onto the result, noting any lost. */
  const mapKeys = (keys: readonly string[], guestName: string): string[] => {
    const mapped: string[] = [];
    for (const k of keys) {
      const r = eventKeyMap.get(k);
      if (r && resultEventKeys.has(r)) mapped.push(r);
      else {
        notes.push(
          `${quoted(guestName)} was invited to ${quoted(eventNameByCurrentKey.get(k) ?? "")}, which was deleted elsewhere.`,
        );
      }
    }
    return mapped;
  };

  // ── Households and guests ──
  const baseFamById = new Map(baseline.families.filter((f) => f.id).map((f) => [f.id!, f]));
  const curFamById = new Map(current.families.filter((f) => f.id).map((f) => [f.id!, f]));
  const freshFamilyNames = new Set(out.families.map((f) => normaliseName(f.familyName)));
  const baseFamilyNames = new Set(baseline.families.map((f) => normaliseName(f.familyName)));

  const keptFamilies: DraftFamily[] = [];
  for (const fam of out.families) {
    const base = fam.id ? baseFamById.get(fam.id) : undefined;
    const cur = fam.id ? curFamById.get(fam.id) : undefined;
    if (base && !cur) {
      const baseGuestIds = new Set(base.guests.map((g) => g.id));
      if (fam.guests.some((g) => !baseGuestIds.has(g.id))) {
        notes.push(
          `${quoted(base.familyName)} gained guests elsewhere; you removed the household, and they go with it when you save.`,
        );
      }
      continue;
    }
    if (base && cur) replayFamily(fam, base, cur);
    keptFamilies.push(fam);
  }
  const freshFamilyIds = new Set(out.families.map((f) => f.id));
  for (const cur of current.families) {
    if (!cur.id || freshFamilyIds.has(cur.id)) continue;
    const base = baseFamById.get(cur.id);
    if (base && withoutKeys(cur) !== withoutKeys(base)) {
      notes.push(
        `${quoted(cur.familyName)} was removed elsewhere, so your changes to it were not kept.`,
      );
    }
  }
  const addedFamilies = current.families
    .filter((f) => !f.id)
    .map((f) => {
      const copy = structuredClone(f);
      const norm = normaliseName(copy.familyName);
      if (norm && freshFamilyNames.has(norm) && !baseFamilyNames.has(norm)) {
        notes.push(
          `A household called ${quoted(copy.familyName)} was also added elsewhere — check for a duplicate.`,
        );
      }
      for (const g of copy.guests) g.eventKeys = mapKeys(g.eventKeys, g.firstName);
      return copy;
    });
  out.families = [...keptFamilies, ...addedFamilies];

  // A tick the fresh rows still hold on an event the organiser removed.
  for (const fam of out.families) {
    for (const g of fam.guests) g.eventKeys = g.eventKeys.filter((k) => resultEventKeys.has(k));
  }
  return { draft: out, notes };

  function replayFamily(fam: DraftFamily, base: DraftFamily, cur: DraftFamily) {
    if (cur.familyName !== base.familyName) fam.familyName = cur.familyName;
    const baseGuestById = new Map(base.guests.filter((g) => g.id).map((g) => [g.id!, g]));
    const curGuestById = new Map(cur.guests.filter((g) => g.id).map((g) => [g.id!, g]));
    const freshFirstNames = new Set(fam.guests.map((g) => normaliseName(g.firstName)));
    const baseFirstNames = new Set(base.guests.map((g) => normaliseName(g.firstName)));

    const kept: DraftGuest[] = [];
    for (const g of fam.guests) {
      const bg = g.id ? baseGuestById.get(g.id) : undefined;
      const cg = g.id ? curGuestById.get(g.id) : undefined;
      if (bg && !cg) continue; // removed by the organiser
      if (bg && cg) {
        for (const field of GUEST_FIELDS) {
          if (cg[field] !== bg[field]) Object.assign(g, { [field]: cg[field] });
        }
        // An address edit stays an edit of the address the organiser saw, not
        // the fresh one: if a guest saved their own since, the server then
        // finds the edit stale and leaves the guest's address alone.
        if (cg.email !== bg.email) g.emailLoaded = bg.emailLoaded;
        const baseKeys = new Set(bg.eventKeys);
        const curKeys = new Set(cg.eventKeys);
        const ticked = cg.eventKeys.filter((k) => !baseKeys.has(k));
        const unticked = bg.eventKeys.filter((k) => !curKeys.has(k));
        if (ticked.length > 0 || unticked.length > 0) {
          const drop = new Set(unticked.map((k) => eventKeyMap.get(k)));
          // A Set keeps insertion order: the fresh ticks first, then the new ones.
          const keys = new Set(g.eventKeys.filter((k) => !drop.has(k)));
          for (const k of mapKeys(ticked, cg.firstName)) keys.add(k);
          g.eventKeys = [...keys];
        }
      }
      kept.push(g);
    }
    const freshGuestIds = new Set(fam.guests.map((g) => g.id));
    for (const cg of cur.guests) {
      if (!cg.id || freshGuestIds.has(cg.id)) continue;
      const bg = baseGuestById.get(cg.id);
      if (bg && withoutKeys(cg) !== withoutKeys(bg)) {
        notes.push(
          `${quoted(cg.firstName)} was removed elsewhere, so your changes to them were not kept.`,
        );
      }
    }
    for (const cg of cur.guests.filter((g) => !g.id)) {
      const copy = structuredClone(cg);
      const norm = normaliseName(copy.firstName);
      if (norm && freshFirstNames.has(norm) && !baseFirstNames.has(norm)) {
        notes.push(
          `${quoted(copy.firstName)} was also added to ${quoted(fam.familyName)} elsewhere — check for a duplicate.`,
        );
      }
      copy.eventKeys = mapKeys(copy.eventKeys, copy.firstName);
      kept.push(copy);
    }
    fam.guests = kept;
  }
}

/** A row serialised without its client keys, for "did the organiser change
 *  it" checks. */
function withoutKeys(value: DraftFamily | DraftGuest): string {
  return JSON.stringify(value, (k, v: unknown) => (k === "key" ? undefined : v));
}

// ── Client-side validation (mirrors guest-event-validation.ts) ────────────────

export interface FieldError {
  /** Draft key of the offending row (family or guest). */
  key: string;
  message: string;
  /** For a run-of-show item's own error, that item's draft key and the field
   *  it is about: the drawer shows it under that field, not above the form. */
  item?: string;
  field?: "time" | "label";
}

/**
 * Field-level validation mirroring the server's rules (§6 "Client mirror") for
 * inline feedback — the server stays authoritative. Blocks Save when non-empty:
 *  Events —
 *   - a non-blank Event Name / Start / Timezone (the hard requirements);
 *   - Start (and End, when present) an ISO-8601-with-offset timestamp;
 *   - http(s)-only Pinterest / Maps URLs;
 *   - each palette swatch a non-blank name + a colour on the theme allow-list;
 *   - name/field length bounds;
 *   - no two events share a name (case/space-insensitive) — the fallback match
 *     key.
 *   End < Start (when both present) is a WARNING server-side (sheet leniency),
 *   NOT a hard error — surfaced via {@link draftWarnings}, not here.
 *  Guests —
 *   - a household needs a non-blank name;
 *   - a guest needs a non-blank first name;
 *   - no two guests in one household share a first name (case/space-insensitive)
 *     — the fallback match key;
 *   - name/nickname length bounds.
 * Empty-household is a WARNING server-side (not blocking), so it's not returned
 * here as a hard error.
 */
export function validateDraft(draft: DraftState): FieldError[] {
  const errors: FieldError[] = [];
  const tooLong = (s: string) => s.length > MAX_CELL_LENGTH;

  // ── Events ──
  const seenEventName = new Map<string, string>();
  for (const evt of draft.events) {
    if (isBlankName(evt.name)) {
      errors.push({ key: evt.key, message: "Event name is required." });
    } else {
      if (tooLong(evt.name)) {
        errors.push({ key: evt.key, message: "Event name is too long." });
      }
      const norm = normaliseName(evt.name);
      if (seenEventName.has(norm)) {
        errors.push({ key: evt.key, message: "Another event already has this name." });
      } else {
        seenEventName.set(norm, evt.key);
      }
    }

    // A date-only value is the drawer's half-filled state (a day picked, no
    // time yet — see `event-datetime.ts`). Still an error, so Save stays shut
    // and nothing invents a midnight, but named precisely: the organiser is one
    // field away, and "not a valid date and time" doesn't say which one.
    if (isBlankName(evt.startAt)) {
      errors.push({ key: evt.key, message: "Start date & time is required." });
    } else if (isDateOnly(evt.startAt)) {
      errors.push({ key: evt.key, message: "Start time is required." });
    } else if (!isIsoTimestamp(evt.startAt)) {
      errors.push({ key: evt.key, message: "Start must be a valid date and time." });
    }
    // End is optional ("" ⇒ open-ended); only shape-check a present value.
    if (isDateOnly(evt.endAt)) {
      errors.push({ key: evt.key, message: "End time is required." });
    } else if (evt.endAt.trim().length > 0 && !isIsoTimestamp(evt.endAt)) {
      errors.push({ key: evt.key, message: "End must be a valid date and time." });
    }

    if (isBlankName(evt.timezone)) {
      errors.push({ key: evt.key, message: "Timezone is required." });
    } else if (tooLong(evt.timezone)) {
      errors.push({ key: evt.key, message: "Timezone is too long." });
    }

    if (evt.venueName && tooLong(evt.venueName)) {
      errors.push({ key: evt.key, message: "Venue name is too long." });
    }
    if (evt.address && tooLong(evt.address)) {
      errors.push({ key: evt.key, message: "Address is too long." });
    }
    if (tooLong(evt.description)) {
      errors.push({ key: evt.key, message: "Description is too long." });
    }
    if (evt.dressCodeDescription && tooLong(evt.dressCodeDescription)) {
      errors.push({ key: evt.key, message: "Dress code description is too long." });
    }
    if (evt.pinterestUrl && !isHttpUrl(evt.pinterestUrl)) {
      errors.push({ key: evt.key, message: "Pinterest link must be an http(s) URL." });
    } else if (evt.pinterestUrl && tooLong(evt.pinterestUrl)) {
      errors.push({ key: evt.key, message: "Pinterest link is too long." });
    }
    if (evt.mapsUrl && !isHttpUrl(evt.mapsUrl)) {
      errors.push({ key: evt.key, message: "Maps link must be an http(s) URL." });
    } else if (evt.mapsUrl && tooLong(evt.mapsUrl)) {
      errors.push({ key: evt.key, message: "Maps link is too long." });
    }
    for (const swatch of evt.dressCodePalette) {
      if (isBlankName(swatch.name)) {
        errors.push({ key: evt.key, message: "A palette swatch needs a name." });
      } else if (tooLong(swatch.name)) {
        errors.push({ key: evt.key, message: "A palette swatch name is too long." });
      }
      if (!isPaletteColorSafe(swatch.color)) {
        errors.push({ key: evt.key, message: "A palette colour isn't an allowed colour value." });
      }
    }

    // The run of show: the cap is the list's, and each item's own errors name
    // it by the number its fields are labelled with, so the drawer can show
    // them under the item.
    if (evt.runOfShow.length > MAX_RUN_OF_SHOW_ITEMS) {
      errors.push({
        key: evt.key,
        message: `A run of show holds at most ${MAX_RUN_OF_SHOW_ITEMS} items.`,
      });
    }
    for (const [i, item] of evt.runOfShow.entries()) {
      const at = (field: "time" | "label", message: string) =>
        errors.push({ key: evt.key, item: item.key, field, message });
      if (!isClockTime(item.time)) at("time", `Item ${i + 1} needs a time.`);
      if (isBlankName(item.label)) at("label", `Item ${i + 1} needs a name.`);
      else if (item.label.trim().length > MAX_RUN_OF_SHOW_LABEL) {
        at("label", `Item ${i + 1} is longer than ${MAX_RUN_OF_SHOW_LABEL} characters.`);
      }
    }
    if (evt.gettingThere && tooLong(evt.gettingThere.trim())) {
      errors.push({ key: evt.key, message: "Getting-there notes are too long." });
    }
    if (evt.guestPolicyNote && tooLong(evt.guestPolicyNote.trim())) {
      errors.push({ key: evt.key, message: "The guest policy note is too long." });
    }
  }

  // ── Guests ──
  for (const fam of draft.families) {
    if (isBlankName(fam.familyName)) {
      errors.push({ key: fam.key, message: "Household name is required." });
    } else if (tooLong(fam.familyName)) {
      errors.push({ key: fam.key, message: "Household name is too long." });
    }

    const seenFirst = new Map<string, string>();
    for (const g of fam.guests) {
      if (isBlankName(g.firstName)) {
        errors.push({ key: g.key, message: "First name is required." });
      } else {
        if (tooLong(g.firstName)) {
          errors.push({ key: g.key, message: "First name is too long." });
        }
        const norm = normaliseName(g.firstName);
        if (seenFirst.has(norm)) {
          errors.push({ key: g.key, message: "Two guests in this household share a first name." });
        } else {
          seenFirst.set(norm, g.key);
        }
      }
      if (tooLong(g.lastName)) {
        errors.push({ key: g.key, message: "Last name is too long." });
      }
      if (g.nickname && tooLong(g.nickname)) {
        errors.push({ key: g.key, message: "Nickname is too long." });
      }
      if (g.email !== undefined && g.email.trim().length > 0 && parseGuestEmail(g.email) === null) {
        errors.push({ key: g.key, message: EMAIL_ERROR });
      }
    }
  }
  return errors;
}

/**
 * Non-blocking client warnings mirroring the server's WARN-don't-reject rules
 * (§6). Distinct from {@link validateDraft} (which BLOCKS Save): a warning is
 * surfaced to nudge the organiser but never disables Save — the server produces
 * the same warning in the preview plan. Currently just End-before-Start (both
 * present): the sheet is lenient here, so the editor is too.
 */
export function draftWarnings(draft: DraftState): string[] {
  const warnings: string[] = [];
  for (const evt of draft.events) {
    if (evt.endAt.trim().length > 0 && isIsoTimestamp(evt.startAt) && isIsoTimestamp(evt.endAt)) {
      if (new Date(evt.endAt).getTime() < new Date(evt.startAt).getTime()) {
        warnings.push(`"${evt.name || "Untitled event"}" ends before it starts.`);
      }
    }
  }
  return warnings;
}

// ── The store hook ────────────────────────────────────────────────────────────

export interface GuestEventDraft {
  /** The reactive draft store (read in components; mutate via the methods). */
  readonly draft: DraftState;
  /** True once `load` has run — components gate rendering on this. */
  readonly loaded: () => boolean;
  /** Any unsaved change vs the loaded baseline. Drives the sticky Save bar. */
  readonly dirty: () => boolean;
  /** Field-level validation errors (empty ⇒ Save allowed). */
  readonly errors: () => FieldError[];
  /** Non-blocking warnings (empty ⇒ nothing to nudge). */
  readonly warnings: () => string[];
  /** True when at least one undo step is available. */
  readonly canUndo: () => boolean;

  /** Replace the draft + baseline from freshly-loaded server rows. `households`
   *  carries the guest-less households the guest rows can't describe;
   *  `baseRevision` is the change head read BEFORE those rows were loaded. */
  load: (
    events: EventRow[],
    guests: OrganiserGuestRow[],
    households: OrganiserHouseholdRow[],
    baseRevision: string,
  ) => void;
  /** Re-seed from rows loaded after someone else's change, keeping the
   *  organiser's unsaved edits on top ({@link replayDraft}). The fresh rows
   *  become the baseline and `baseRevision` the new head, so the draft stays
   *  dirty and its next save is not refused as stale. Returns the notes on
   *  edits that could not be kept or need a second look. */
  rebase: (
    events: EventRow[],
    guests: OrganiserGuestRow[],
    households: OrganiserHouseholdRow[],
    baseRevision: string,
  ) => string[];
  /** The change head the draft was loaded at (`null` before a load / after a
   *  reset). The save sends it so a draft older than the head is refused. */
  readonly baseRevision: () => string | null;
  /** Drop the draft entirely — nothing loaded, nothing dirty, nothing to save.
   *  For when the draft can no longer be trusted and must be re-seeded. */
  reset: () => void;
  /** Whether the API the draft was loaded from reads an event's run of show,
   *  notes and guest policy ({@link readsEventDetails}). */
  readonly eventDetails: () => boolean;

  // Events-tab mutations (each records an undo checkpoint first). A new event's
  // `sortOrder` lands at the end; reorder rewrites every event's `sortOrder` to
  // its new index so the plan writes a stable schedule order.
  addEvent: () => string;
  updateEvent: (key: string, patch: EventPatch) => void;
  removeEvent: (key: string) => void;
  /** Move the event at index `from` to index `to`, rewriting every sortOrder. */
  reorderEvents: (from: number, to: number) => void;

  // Guests-tab mutations (each records an undo checkpoint first).
  addFamily: () => string;
  renameFamily: (key: string, name: string) => void;
  removeFamily: (key: string) => void;
  addGuest: (familyKey: string) => string;
  updateGuest: (
    guestKey: string,
    patch: Partial<Pick<DraftGuest, "firstName" | "lastName" | "nickname" | "email">>,
  ) => void;
  removeGuest: (guestKey: string) => void;
  toggleAttendance: (guestKey: string, eventKey: string) => void;

  /** Undo the last mutation (in-session). */
  undo: () => void;
  /** Discard ALL edits back to the loaded baseline. */
  discard: () => void;
  /** Adopt the current draft as the new baseline (call after a successful save). */
  commit: () => void;

  /** Serialise the current draft to the DesiredState wire payload for a save
   *  of `scope` (see {@link toDesiredState}). */
  toWire: (scope?: "events" | "guests" | "both") => DesiredStateWire;
}

/** A deep structural clone via `unwrap` — snapshots the store for undo/baseline
 *  without leaking Solid proxies. */
function snapshot(draft: DraftState): DraftState {
  return structuredClone(unwrap(draft)) as DraftState;
}

/**
 * Create the guest+event draft controller. One instance per mounted editor; the
 * caller feeds it server rows via {@link GuestEventDraft.load}. All state is
 * local — no fetches here.
 */
export function createGuestEventDraft(): GuestEventDraft {
  const [draft, setDraft] = createStore<DraftState>({ events: [], families: [] });
  const [loaded, setLoaded] = createSignal(false);
  const [baseRevision, setBaseRevision] = createSignal<string | null>(null);
  const [eventDetails, setEventDetails] = createSignal(true);
  const [baseline, setBaseline] = createSignal<string>("");
  // The loaded state itself, kept alongside its fingerprint so "discard" can
  // restore it directly. The undo stack can NOT stand in for it: it is bounded,
  // so a long editing session (every keystroke is a checkpoint) evicts the
  // oldest snapshots and its first entry stops being the baseline.
  const [baselineDraft, setBaselineDraft] = createSignal<DraftState>({ events: [], families: [] });
  // Undo stack of pre-mutation snapshots (bounded — deep editing sessions don't
  // need unbounded history, and the whole draft is small).
  const [undoStack, setUndoStack] = createSignal<DraftState[]>([]);
  const UNDO_LIMIT = 100;

  /** Serialise the draft to a stable string for cheap dirty comparison. */
  const fingerprint = (d: DraftState) => JSON.stringify(toDesiredState(d));

  const dirty = createMemo(() => loaded() && fingerprint(draft) !== baseline());
  const errors = createMemo(() => (loaded() ? validateDraft(draft) : []));
  const warnings = createMemo(() => (loaded() ? draftWarnings(draft) : []));
  const canUndo = () => undoStack().length > 0;

  /** Push the current state onto the undo stack BEFORE a mutation. */
  function checkpoint() {
    setUndoStack((prev) => {
      const next = [...prev, snapshot(draft)];
      return next.length > UNDO_LIMIT ? next.slice(next.length - UNDO_LIMIT) : next;
    });
  }

  function load(
    events: EventRow[],
    guests: OrganiserGuestRow[],
    households: OrganiserHouseholdRow[],
    revision: string,
  ) {
    const built = buildDraft(events, guests, households);
    setEventDetails(readsEventDetails(events));
    setDraft(reconcile(built, { key: "key" }));
    setBaseline(fingerprint(built));
    setBaselineDraft(structuredClone(built));
    setUndoStack([]);
    setBaseRevision(revision);
    setLoaded(true);
  }

  function rebase(
    events: EventRow[],
    guests: OrganiserGuestRow[],
    households: OrganiserHouseholdRow[],
    revision: string,
  ): string[] {
    const fresh = buildDraft(events, guests, households);
    setEventDetails(readsEventDetails(events));
    // `replayDraft` copies what it takes from the live draft and from `fresh`,
    // so neither needs a copy of its own here.
    const { draft: replayed, notes } = replayDraft(baselineDraft(), unwrap(draft), fresh);
    setDraft(reconcile(replayed, { key: "key" }));
    setBaseline(fingerprint(fresh));
    setBaselineDraft(fresh);
    setUndoStack([]);
    setBaseRevision(revision);
    setLoaded(true);
    return notes;
  }

  function reset() {
    const empty: DraftState = { events: [], families: [] };
    // `loaded` first: every memo reading the draft is gated on it, so nothing
    // recomputes against a half-cleared store.
    setLoaded(false);
    setDraft(reconcile(empty, { key: "key" }));
    setBaseline("");
    setBaselineDraft(structuredClone(empty));
    setUndoStack([]);
    setBaseRevision(null);
    setEventDetails(true);
  }

  function eventIndex(key: string) {
    return draft.events.findIndex((e) => e.key === key);
  }

  /** Rewrite every event's `sortOrder` to its current array index — called after
   *  an add/reorder so the plan writes a stable, gap-free schedule order. */
  function renumberEvents() {
    setDraft(
      "events",
      produce((events) => {
        events.forEach((e, i) => {
          e.sortOrder = i;
        });
      }),
    );
  }

  function addEvent(): string {
    checkpoint();
    const key = nextKey();
    setDraft(
      produce((d) => {
        d.events.push({
          key,
          id: null,
          name: "",
          startAt: "",
          endAt: "",
          // Seeded with the organiser's OWN zone rather than blank. A wedding is
          // overwhelmingly in the zone the person planning it is sitting in, and
          // the alternative — an empty required field on every new event — made
          // the zone something to be re-typed by hand each time (which is how a
          // "+10:00 in November" Sydney event happens). Still fully editable in
          // the drawer's dropdown.
          timezone: browserTimeZone(),
          description: "",
          venueName: null,
          address: null,
          runOfShow: [],
          gettingThere: null,
          childrenPolicy: null,
          plusOnePolicy: null,
          guestPolicyNote: null,
          dressCodeDescription: null,
          dressCodePalette: [],
          pinterestUrl: null,
          mapsUrl: null,
          sortOrder: d.events.length,
        });
      }),
    );
    return key;
  }

  function updateEvent(key: string, patch: EventPatch) {
    const ei = eventIndex(key);
    if (ei === -1) return;
    checkpoint();
    const { runOfShow, ...rest } = patch;
    // A run of show is merged by item key, so an item that is only edited
    // keeps its identity: `<For>` keeps its row, and the input being typed in
    // keeps the focus. One batch, so the draft's memos recompute once.
    batch(() => {
      setDraft("events", ei, rest);
      if (runOfShow) setDraft("events", ei, "runOfShow", reconcile(runOfShow, { key: "key" }));
    });
  }

  function removeEvent(key: string) {
    const ei = eventIndex(key);
    if (ei === -1) return;
    checkpoint();
    setDraft("events", (events) => events.filter((e) => e.key !== key));
    // A removed event's key may still be referenced by a guest's attendance;
    // strip those dangling keys so the serialiser doesn't resolve them to a name.
    setDraft(
      "families",
      produce((families) => {
        for (const fam of families) {
          for (const g of fam.guests) {
            g.eventKeys = g.eventKeys.filter((k) => k !== key);
          }
        }
      }),
    );
    renumberEvents();
  }

  function reorderEvents(from: number, to: number) {
    const count = draft.events.length;
    if (from === to || from < 0 || from >= count || to < 0 || to >= count) return;
    checkpoint();
    // Splice AND renumber in one `produce`, not a move followed by a separate
    // `renumberEvents()`. Solid memos are eager, so two store writes recompute
    // `dirty`/`errors`/`warnings` twice — and all three walk every household and
    // guest, so on a large wedding that doubling is most of the cost of a
    // reorder. No intermediate state is observable either way.
    setDraft(
      "events",
      produce((events) => {
        const [moved] = events.splice(from, 1);
        events.splice(to, 0, moved!);
        events.forEach((e, i) => {
          e.sortOrder = i;
        });
      }),
    );
  }

  function familyIndex(key: string) {
    return draft.families.findIndex((f) => f.key === key);
  }
  function findGuest(guestKey: string): { fi: number; gi: number } | null {
    for (let fi = 0; fi < draft.families.length; fi++) {
      const gi = draft.families[fi]!.guests.findIndex((g) => g.key === guestKey);
      if (gi !== -1) return { fi, gi };
    }
    return null;
  }

  function addFamily(): string {
    checkpoint();
    const key = nextKey();
    setDraft(
      produce((d) => {
        d.families.push({ key, id: null, publicId: null, familyName: "", guests: [] });
      }),
    );
    return key;
  }

  function renameFamily(key: string, name: string) {
    const fi = familyIndex(key);
    if (fi === -1) return;
    checkpoint();
    setDraft("families", fi, "familyName", name);
  }

  function removeFamily(key: string) {
    const fi = familyIndex(key);
    if (fi === -1) return;
    checkpoint();
    setDraft("families", (fams) => fams.filter((f) => f.key !== key));
  }

  function addGuest(familyKey: string): string {
    const fi = familyIndex(familyKey);
    if (fi === -1) return "";
    checkpoint();
    const key = nextKey();
    setDraft(
      "families",
      fi,
      "guests",
      produce((gs) => {
        gs.push({
          key,
          id: null,
          firstName: "",
          lastName: "",
          nickname: null,
          email: "",
          emailLoaded: "",
          emailSource: null,
          eventKeys: [],
        });
      }),
    );
    return key;
  }

  function updateGuest(
    guestKey: string,
    patch: Partial<Pick<DraftGuest, "firstName" | "lastName" | "nickname" | "email">>,
  ) {
    const loc = findGuest(guestKey);
    if (!loc) return;
    checkpoint();
    setDraft("families", loc.fi, "guests", loc.gi, patch);
  }

  function removeGuest(guestKey: string) {
    const loc = findGuest(guestKey);
    if (!loc) return;
    checkpoint();
    setDraft("families", loc.fi, "guests", (gs) => gs.filter((g) => g.key !== guestKey));
  }

  function toggleAttendance(guestKey: string, eventKey: string) {
    const loc = findGuest(guestKey);
    if (!loc) return;
    checkpoint();
    setDraft("families", loc.fi, "guests", loc.gi, "eventKeys", (keys) =>
      keys.includes(eventKey) ? keys.filter((k) => k !== eventKey) : [...keys, eventKey],
    );
  }

  function undo() {
    const stack = undoStack();
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1]!;
    setUndoStack(stack.slice(0, -1));
    setDraft(reconcile(prev, { key: "key" }));
  }

  function discard() {
    if (undoStack().length === 0 && !dirty()) return;
    // Restore the LOADED state, not the oldest undo snapshot: the undo stack is
    // capped at UNDO_LIMIT, and every keystroke checkpoints, so in any session
    // long enough to overflow it `stack[0]` is a mid-edit state — discarding to
    // it left edits behind and still reported the draft clean.
    setDraft(reconcile(structuredClone(baselineDraft()), { key: "key" }));
    setUndoStack([]);
  }

  function commit() {
    setBaseline(fingerprint(draft));
    setBaselineDraft(snapshot(draft));
    setUndoStack([]);
  }

  return {
    draft,
    loaded,
    dirty,
    errors,
    warnings,
    canUndo,
    load,
    rebase,
    baseRevision,
    reset,
    addEvent,
    updateEvent,
    removeEvent,
    reorderEvents,
    addFamily,
    renameFamily,
    removeFamily,
    addGuest,
    updateGuest,
    removeGuest,
    toggleAttendance,
    undo,
    discard,
    commit,
    eventDetails,
    toWire: (scope) => toDesiredState(draft, scope, eventDetails()),
  };
}

// The guest + event editor DRAFT store (guest+event editor E5, §8).
//
// Loads the wedding's current server state into a mutable, id-stable SolidJS
// store, tracks dirtiness against the loaded baseline, and (on Save) serialises
// the whole draft into a DesiredState JSON the `changes/preview` front door
// consumes. The draft is the WHOLE TRUTH — the editor front door diffs with
// `removeManual` implicit-true — so the DesiredState carries EVERY event and
// household, not just the mutated ones (an omitted row would read as a delete).
//
// E5 wires up GUESTS only (households, guests, per-guest attendance). Events are
// loaded and carried through UNCHANGED so a guests-only save preserves the
// schedule (id-matched ⇒ update with identical values ⇒ no data loss). E6 will
// add event editing on top of the same store — the shape is designed for that:
// `events` is a first-class editable slice, it's just not mutated here yet.
//
// In-session UNDO + "discard draft" are pure client state: every mutation pushes
// the prior snapshot onto an undo stack, so undo/discard are local — no server
// round-trips while editing (§8). Nothing here talks to the network; the caller
// owns fetch/preview/apply.
//
// Effect is deliberately NOT imported — this is frontend code (cire CLAUDE.md:
// "Effect is backend + DB only — never import it in cire/web or cire/organiser").
// Plain Solid primitives + a structural clone, matching events-/guests-store.
import { createMemo, createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";

import type { EventRow } from "./events-store";
import { isBlankName, MAX_CELL_LENGTH, normaliseName } from "./guest-validation";
import type { OrganiserGuestRow } from "./guests-store";

// ── Draft row shapes ─────────────────────────────────────────────────────────
//
// Rows carry a client-only `key` for stable `<For>` identity + a nullable `id`:
// an EXISTING row keeps its server id (so a rename is an update, not remove+
// create), a NEW row has `id: null` (the reconcile mints one server-side).

/** A monotonic client-only key generator for freshly-added rows. */
let keySeq = 0;
const nextKey = () => `new-${++keySeq}`;

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
  address: string | null;
  dressCodeDescription: string | null;
  dressCodePalette: { name: string; color: string }[];
  pinterestUrl: string | null;
  mapsUrl: string | null;
  sortOrder: number;
}

export interface DraftGuest {
  readonly key: string;
  id: string | null;
  firstName: string;
  lastName: string;
  nickname: string | null;
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
  location: string | null;
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
 * Build a draft from the two cached server reads. Events come from the shared
 * events cache (the schedule the guests are invited to); guests come from the
 * flat organiser guest rows (one row per guest, grouped here into households by
 * `familyId`). Attendance is resolved event-id → event key so the matrix is
 * keyed the same way the draft references events.
 */
function buildDraft(events: EventRow[], guests: OrganiserGuestRow[]): DraftState {
  const draftEvents: DraftEvent[] = events
    .toSorted((a, b) => a.sortOrder - b.sortOrder)
    .map((e) => ({
      key: nextKey(),
      id: e.id,
      name: e.name,
      startAt: e.startAt,
      endAt: e.endAt,
      timezone: e.timezone,
      address: e.address,
      dressCodeDescription: e.dressCodeDescription,
      dressCodePalette: (e.dressCodePalette ?? []).map((s) => ({ name: s.name, color: s.color })),
      pinterestUrl: e.pinterestUrl,
      mapsUrl: e.mapsUrl,
      sortOrder: e.sortOrder,
    }));

  const eventKeyById = new Map(draftEvents.filter((e) => e.id).map((e) => [e.id!, e.key]));

  // Group the flat guest rows into households, preserving first-seen order.
  const byFamily = new Map<string, DraftFamily>();
  for (const g of guests) {
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
    fam.guests.push({
      key: nextKey(),
      id: g.guestId,
      firstName: g.firstName,
      lastName: g.lastName,
      nickname: g.nickname,
      // Resolve invited event ids → the draft's event keys; drop any dangling id
      // (an event removed out from under us) defensively.
      eventKeys: g.events.map((id) => eventKeyById.get(id)).filter((k): k is string => Boolean(k)),
    });
  }

  return { events: draftEvents, families: Array.from(byFamily.values()) };
}

// ── Serialise: draft → DesiredState wire ──────────────────────────────────────

/**
 * Serialise the draft into the DesiredState the editor front door POSTs. Existing
 * rows send their `id` (rename-safe update); new rows omit it (server mints).
 * Attendance is emitted as event NAMES (the wire's `eventNames`), resolved from
 * each guest's event keys through the draft's current event list — so ticking a
 * box after renaming an event still links the right event.
 */
export function toDesiredState(draft: DraftState): DesiredStateWire {
  const eventNameByKey = new Map(draft.events.map((e) => [e.key, e.name]));

  const events: WireEvent[] = draft.events.map((e) => ({
    ...(e.id ? { id: e.id } : {}),
    name: e.name,
    startAt: e.startAt,
    endAt: e.endAt,
    timezone: e.timezone,
    // The draft doesn't carry the venue-name fallback separately; `address` is
    // authoritative (the reconcile writes `address ?? location`).
    location: null,
    address: e.address,
    dressCodeDescription: e.dressCodeDescription,
    dressCodePalette: e.dressCodePalette.map((s) => ({ name: s.name, color: s.color })),
    pinterestUrl: e.pinterestUrl,
    mapsUrl: e.mapsUrl,
    sortOrder: e.sortOrder,
  }));

  const families: WireFamily[] = draft.families.map((f) => ({
    ...(f.id ? { id: f.id } : {}),
    ...(f.publicId ? { publicId: f.publicId } : {}),
    familyName: f.familyName,
    guests: f.guests.map((g) => ({
      ...(g.id ? { id: g.id } : {}),
      firstName: g.firstName,
      lastName: g.lastName,
      nickname: g.nickname && g.nickname.trim().length > 0 ? g.nickname.trim() : null,
      eventNames: g.eventKeys
        .map((k) => eventNameByKey.get(k))
        .filter((n): n is string => Boolean(n)),
    })),
  }));

  return { events, families };
}

// ── Client-side validation (mirrors guest-event-validation.ts) ────────────────

export interface FieldError {
  /** Draft key of the offending row (family or guest). */
  key: string;
  message: string;
}

/**
 * Field-level validation mirroring the server's rules (§6 "Client mirror") for
 * inline feedback — the server stays authoritative. Blocks Save when non-empty:
 *  - a household needs a non-blank name;
 *  - a guest needs a non-blank first name;
 *  - no two guests in one household share a first name (case/space-insensitive)
 *    — the fallback match key;
 *  - name/nickname length bounds.
 * Empty-household is a WARNING server-side (not blocking), so it's not returned
 * here as a hard error.
 */
export function validateDraft(draft: DraftState): FieldError[] {
  const errors: FieldError[] = [];
  const tooLong = (s: string) => s.length > MAX_CELL_LENGTH;
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
    }
  }
  return errors;
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
  /** True when at least one undo step is available. */
  readonly canUndo: () => boolean;

  /** Replace the draft + baseline from freshly-loaded server rows. */
  load: (events: EventRow[], guests: OrganiserGuestRow[]) => void;

  // Guests-tab mutations (each records an undo checkpoint first).
  addFamily: () => string;
  renameFamily: (key: string, name: string) => void;
  removeFamily: (key: string) => void;
  addGuest: (familyKey: string) => string;
  updateGuest: (
    guestKey: string,
    patch: Partial<Pick<DraftGuest, "firstName" | "lastName" | "nickname">>,
  ) => void;
  removeGuest: (guestKey: string) => void;
  toggleAttendance: (guestKey: string, eventKey: string) => void;

  /** Undo the last mutation (in-session). */
  undo: () => void;
  /** Discard ALL edits back to the loaded baseline. */
  discard: () => void;
  /** Adopt the current draft as the new baseline (call after a successful save). */
  commit: () => void;

  /** Serialise the current draft to the DesiredState wire payload. */
  toWire: () => DesiredStateWire;
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
  const [baseline, setBaseline] = createSignal<string>("");
  // Undo stack of pre-mutation snapshots (bounded — deep editing sessions don't
  // need unbounded history, and the whole draft is small).
  const [undoStack, setUndoStack] = createSignal<DraftState[]>([]);
  const UNDO_LIMIT = 100;

  /** Serialise the draft to a stable string for cheap dirty comparison. */
  const fingerprint = (d: DraftState) => JSON.stringify(toDesiredState(d));

  const dirty = createMemo(() => loaded() && fingerprint(draft) !== baseline());
  const errors = createMemo(() => (loaded() ? validateDraft(draft) : []));
  const canUndo = () => undoStack().length > 0;

  /** Push the current state onto the undo stack BEFORE a mutation. */
  function checkpoint() {
    setUndoStack((prev) => {
      const next = [...prev, snapshot(draft)];
      return next.length > UNDO_LIMIT ? next.slice(next.length - UNDO_LIMIT) : next;
    });
  }

  function load(events: EventRow[], guests: OrganiserGuestRow[]) {
    const built = buildDraft(events, guests);
    setDraft(reconcile(built, { key: "key" }));
    setBaseline(fingerprint(built));
    setUndoStack([]);
    setLoaded(true);
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
        gs.push({ key, id: null, firstName: "", lastName: "", nickname: null, eventKeys: [] });
      }),
    );
    return key;
  }

  function updateGuest(
    guestKey: string,
    patch: Partial<Pick<DraftGuest, "firstName" | "lastName" | "nickname">>,
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
    // Rewind to the FIRST snapshot if any, else the current draft is already the
    // baseline. Simpler + robust: rebuild from the baseline fingerprint is not
    // possible (it's a wire shape), so replay to the earliest undo snapshot.
    const stack = undoStack();
    if (stack.length > 0) {
      setDraft(reconcile(stack[0]!, { key: "key" }));
    }
    setUndoStack([]);
  }

  function commit() {
    setBaseline(fingerprint(draft));
    setUndoStack([]);
  }

  return {
    draft,
    loaded,
    dirty,
    errors,
    canUndo,
    load,
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
    toWire: () => toDesiredState(draft),
  };
}

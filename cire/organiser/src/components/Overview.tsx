import { useAuth } from "@osn/client/solid";
import { createMemo, createResource, For, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { ensureEventsLoaded, type EventRow, eventsAccessor } from "../lib/events-store";
import { ensureGuestsLoaded, guestsAccessor, type OrganiserGuestRow } from "../lib/guests-store";
import GettingStarted from "./GettingStarted";
import SectionIntro from "./SectionIntro";

/** The Overview home — the module shell's landing view. It answers "how's the
 *  wedding tracking?" at a glance: a countdown to the date, RSVP totals rolled
 *  up across events, and honest "coming soon" snapshot cards for the planning
 *  modules that don't exist yet (Checklist + Budget land in Phase 1). When the
 *  wedding is brand new — no events, no guests — it shows the Getting-started
 *  checklist as its empty-state instead of empty stat cards.
 *
 *  Data is read from the SHARED weddingId-keyed caches (events + guests stores)
 *  so opening Overview costs nothing extra once another module has loaded, and a
 *  light settings/rsvps read for the date + reply tallies. Everything degrades
 *  softly: a failed sub-read hides its card, never blocks the page. */

interface WeddingProfile {
  weddingDate: string | null;
  guestCountEstimate: number | null;
  currency: string;
  budgetTotalMinor: number | null;
}

interface RsvpEventTally {
  invited: number;
  attending: number;
  declined: number;
  maybe: number;
  responded: number;
  noResponse: number;
}

interface RsvpTotals {
  invited: number;
  attending: number;
  declined: number;
  maybe: number;
  responded: number;
  noResponse: number;
  eventCount: number;
}

interface OverviewData {
  profile: WeddingProfile | null;
  rsvps: RsvpTotals | null;
  events: EventRow[];
  guests: OrganiserGuestRow[];
}

/** Whole days from now (local midnight) to the wedding date (its local midnight),
 *  so "today" reads 0 and a future date reads a positive day count. Returns null
 *  for an unparseable date. */
function daysUntil(isoDate: string): number | null {
  // `YYYY-MM-DD` — parse as a local date (not UTC) so the countdown matches the
  // organiser's calendar rather than shifting a day across timezones.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const [, y, mo, d] = m;
  const target = new Date(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((target.getTime() - today.getTime()) / MS_PER_DAY);
}

function formatWeddingDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

export default function Overview(props: {
  weddingId: string;
  /** Jump to another module (+ optional sub) — wired to the shell's navigation
   *  so an Overview card can send the organiser to the right place. */
  onNavigate: (module: "guests" | "schedule" | "invite" | "settings", sub?: string) => void;
}) {
  const { authFetch } = useAuth();

  const [data] = createResource<OverviewData>(async () => {
    try {
      // Events + guests ride the shared caches (deduped with the other modules).
      // Settings + rsvps are light reads for the date + reply tallies.
      const [settingsRes, rsvpsRes] = await Promise.all([
        authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/settings`)),
        authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/rsvps`)),
        ensureEventsLoaded(props.weddingId, async () => {
          const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/events`));
          if (res.status === 401) {
            redirectToLogin();
            throw new Error("unauthenticated");
          }
          if (!res.ok) throw new Error("events");
          return (await res.json()) as EventRow[];
        }),
        ensureGuestsLoaded(props.weddingId, async () => {
          const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/guests`));
          if (res.status === 401) {
            redirectToLogin();
            throw new Error("unauthenticated");
          }
          if (!res.ok) throw new Error("guests");
          return (await res.json()) as OrganiserGuestRow[];
        }),
      ]);

      if (settingsRes.status === 401 || rsvpsRes.status === 401) {
        redirectToLogin();
      }

      const profile = settingsRes.ok
        ? ((await settingsRes.json()) as { wedding: WeddingProfile }).wedding
        : null;

      let rsvps: RsvpTotals | null = null;
      if (rsvpsRes.ok) {
        const body = (await rsvpsRes.json()) as { events: RsvpEventTally[] };
        rsvps = body.events.reduce<RsvpTotals>(
          (acc, e) => ({
            invited: acc.invited + e.invited,
            attending: acc.attending + e.attending,
            declined: acc.declined + e.declined,
            maybe: acc.maybe + e.maybe,
            responded: acc.responded + e.responded,
            noResponse: acc.noResponse + e.noResponse,
            eventCount: acc.eventCount + 1,
          }),
          {
            invited: 0,
            attending: 0,
            declined: 0,
            maybe: 0,
            responded: 0,
            noResponse: 0,
            eventCount: 0,
          },
        );
      }

      return {
        profile,
        rsvps,
        events: eventsAccessor(props.weddingId)() ?? [],
        guests: guestsAccessor(props.weddingId)() ?? [],
      };
    } catch (err) {
      if (isAuthExpired(err)) redirectToLogin();
      // Soft-fail: an unavailable snapshot shouldn't blank the whole home.
      return { profile: null, rsvps: null, events: [], guests: [] };
    }
  });

  // Households, deduped from the (repeated-per-member) guest rows.
  const householdCount = createMemo(() => {
    const ids = new Set<string>();
    for (const g of data()?.guests ?? []) ids.add(g.familyId);
    return ids.size;
  });
  const eventCount = createMemo(() => data()?.events.length ?? 0);

  // The wedding is "just started" — no schedule and no guests yet — so the home
  // leads with the Getting-started checklist rather than empty stat blocks.
  const isFresh = createMemo(() => eventCount() === 0 && householdCount() === 0);

  const weddingDate = createMemo(() => data()?.profile?.weddingDate ?? null);
  const countdown = createMemo(() => {
    const iso = weddingDate();
    return iso ? daysUntil(iso) : null;
  });

  return (
    <div class="flex flex-col gap-8">
      <SectionIntro
        eyebrow="Overview"
        title="Your wedding at a glance"
        description="The headline numbers — how long to go, who's replied, and what's next. Dig into any module from the sidebar."
      />

      <Show when={data.loading}>
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <For each={[1, 2, 3]}>
            {() => <div class="bg-surface h-[130px] animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={!data.loading}>
        {/* Brand-new wedding ⇒ the checklist is the home. It links straight into
            the modules via the shell's navigation. */}
        <Show when={isFresh()}>
          <GettingStarted
            weddingId={props.weddingId}
            onJump={(tab) => {
              // GettingStarted still speaks the old tab vocabulary; map its jumps
              // onto the module shell.
              if (tab === "events") props.onNavigate("schedule");
              else if (tab === "guests") props.onNavigate("guests", "list");
              else if (tab === "invite") props.onNavigate("invite", "design");
            }}
          />
        </Show>

        <Show when={!isFresh()}>
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* ── Countdown ─────────────────────────────────────────────── */}
            <div class="border-gold/25 from-surface/50 to-surface/20 flex flex-col gap-2 rounded-sm border bg-gradient-to-br p-5">
              <p class="font-body text-gold text-[0.7rem] tracking-[0.18em] uppercase">Countdown</p>
              <Show
                when={weddingDate()}
                fallback={
                  <>
                    <p class="font-display text-text text-[1.5rem] leading-tight font-light italic">
                      No date yet
                    </p>
                    <button
                      type="button"
                      onClick={() => props.onNavigate("settings", "wedding")}
                      class="font-body text-gold-dim hover:text-gold self-start text-[0.78rem] underline-offset-4 transition hover:underline"
                    >
                      Set your wedding date →
                    </button>
                  </>
                }
              >
                {(iso) => (
                  <>
                    <Show
                      when={countdown() !== null}
                      fallback={
                        <p class="font-display text-text text-[1.4rem] leading-tight font-light italic">
                          {formatWeddingDate(iso())}
                        </p>
                      }
                    >
                      {(() => {
                        const days = countdown()!;
                        // Show the count ONCE: a headline number/word with a single
                        // label beneath it (no separate "N days to go" line that
                        // repeats the same figure). "Tomorrow!"/"Today!" and past
                        // dates read as words with no redundant numeral above them.
                        if (days === 0) {
                          return (
                            <p class="font-display text-gold text-[2rem] leading-none font-light">
                              Today!
                            </p>
                          );
                        }
                        if (days === 1) {
                          return (
                            <p class="font-display text-gold text-[2rem] leading-none font-light">
                              Tomorrow!
                            </p>
                          );
                        }
                        const abs = Math.abs(days);
                        const unit = abs === 1 ? "day" : "days";
                        return (
                          <div class="flex flex-col gap-0.5">
                            <p class="font-display text-gold text-[2rem] leading-none font-light tabular-nums">
                              {abs}
                            </p>
                            <p class="font-body text-text text-[0.9rem]">
                              {days > 0 ? `${unit} to go` : `${unit} ago`}
                            </p>
                          </div>
                        );
                      })()}
                    </Show>
                    <p class="font-body text-text-muted text-[0.76rem]">
                      {formatWeddingDate(iso())}
                    </p>
                  </>
                )}
              </Show>
            </div>

            {/* ── RSVP totals ───────────────────────────────────────────── */}
            <div class="border-border bg-surface/30 flex flex-col gap-3 rounded-sm border p-5">
              <p class="font-body text-gold text-[0.7rem] tracking-[0.18em] uppercase">RSVPs</p>
              <Show
                when={data()?.rsvps && data()!.rsvps!.eventCount > 0}
                fallback={
                  <p class="font-body text-text-muted text-[0.85rem] leading-relaxed">
                    Replies will roll up here once you have events and guests.
                  </p>
                }
              >
                {(() => {
                  const r = data()!.rsvps!;
                  return (
                    <>
                      <div class="flex items-baseline gap-2">
                        <span class="font-display text-gold text-[2rem] leading-none tabular-nums">
                          {r.attending}
                        </span>
                        <span class="font-body text-text-muted text-[0.82rem]">
                          attending across {r.eventCount} {r.eventCount === 1 ? "event" : "events"}
                        </span>
                      </div>
                      <dl class="font-body text-text-muted grid grid-cols-2 gap-x-4 gap-y-1 text-[0.78rem]">
                        <div class="flex justify-between gap-2">
                          <dt>Declined</dt>
                          <dd class="text-text font-mono">{r.declined}</dd>
                        </div>
                        <div class="flex justify-between gap-2">
                          <dt>Maybe</dt>
                          <dd class="text-text font-mono">{r.maybe}</dd>
                        </div>
                        <div class="flex justify-between gap-2">
                          <dt>No reply</dt>
                          <dd class="text-text font-mono">{r.noResponse}</dd>
                        </div>
                        <div class="flex justify-between gap-2">
                          <dt>Invited</dt>
                          <dd class="text-text font-mono">{r.invited}</dd>
                        </div>
                      </dl>
                      <button
                        type="button"
                        onClick={() => props.onNavigate("guests", "rsvps")}
                        class="font-body text-gold-dim hover:text-gold self-start text-[0.78rem] underline-offset-4 transition hover:underline"
                      >
                        See replies per event →
                      </button>
                    </>
                  );
                })()}
              </Show>
            </div>

            {/* ── Guests + schedule snapshot ─────────────────────────────── */}
            <div class="border-border bg-surface/30 flex flex-col gap-3 rounded-sm border p-5">
              <p class="font-body text-gold text-[0.7rem] tracking-[0.18em] uppercase">
                Guests &amp; schedule
              </p>
              <dl class="font-body text-text-muted flex flex-col gap-1.5 text-[0.85rem]">
                <div class="flex justify-between gap-2">
                  <dt>Households</dt>
                  <dd class="text-text font-mono">{householdCount()}</dd>
                </div>
                <div class="flex justify-between gap-2">
                  <dt>Events</dt>
                  <dd class="text-text font-mono">{eventCount()}</dd>
                </div>
                <Show when={data()?.profile?.guestCountEstimate != null}>
                  <div class="flex justify-between gap-2">
                    <dt>Guest estimate</dt>
                    <dd class="text-text font-mono">{data()!.profile!.guestCountEstimate}</dd>
                  </div>
                </Show>
              </dl>
              <button
                type="button"
                onClick={() => props.onNavigate("guests", "list")}
                class="font-body text-gold-dim hover:text-gold self-start text-[0.78rem] underline-offset-4 transition hover:underline"
              >
                Open the guest list →
              </button>
            </div>

            {/* ── Checklist snapshot (Phase 1 — placeholder, NEVER fake) ─── */}
            <SnapshotComingSoon
              label="Checklist"
              blurb="Your planning tasks — venue, catering, final head-counts — laid out by how far out they're due. Coming soon."
            />

            {/* ── Budget snapshot (Phase 1 — placeholder, NEVER fake) ─────── */}
            <SnapshotComingSoon
              label="Budget"
              blurb={
                data()?.profile?.budgetTotalMinor != null
                  ? "Track estimates, quotes, and payments against your total. Coming soon."
                  : "Set a total in Settings, then track spending against it here. Coming soon."
              }
              action={
                data()?.profile?.budgetTotalMinor == null
                  ? {
                      label: "Set a budget →",
                      onClick: () => props.onNavigate("settings", "wedding"),
                    }
                  : undefined
              }
            />
          </div>
        </Show>
      </Show>
    </div>
  );
}

/** An honest "not built yet" snapshot card for a planning module that lands in a
 *  later phase. It reads as a promise, not as data — no numbers are invented (the
 *  repo's no-mock-data rule). */
function SnapshotComingSoon(props: {
  label: string;
  blurb: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div class="border-border bg-surface/15 flex flex-col gap-2 rounded-sm border border-dashed p-5">
      <div class="flex items-center justify-between gap-2">
        <p class="font-body text-gold-dim text-[0.7rem] tracking-[0.18em] uppercase">
          {props.label}
        </p>
        <span class="border-border text-text-muted font-body rounded-sm border px-1.5 py-0.5 text-[0.58rem] tracking-[0.14em] uppercase">
          Soon
        </span>
      </div>
      <p class="font-body text-text-muted text-[0.82rem] leading-relaxed">{props.blurb}</p>
      <Show when={props.action}>
        {(action) => (
          <button
            type="button"
            onClick={() => action().onClick()}
            class="font-body text-gold-dim hover:text-gold self-start text-[0.78rem] underline-offset-4 transition hover:underline"
          >
            {action().label}
          </button>
        )}
      </Show>
    </div>
  );
}

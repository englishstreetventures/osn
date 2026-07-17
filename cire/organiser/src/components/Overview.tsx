import { useAuth } from "@osn/client/solid";
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import {
  type BudgetSnapshot,
  ensureBudgetLoaded,
  peekCachedBudget,
  spentSoFar,
  upcomingPayments,
} from "../lib/budget-store";
import { ensureEventsLoaded, type EventRow, eventsAccessor } from "../lib/events-store";
import { ensureGuestsLoaded, guestsAccessor, type OrganiserGuestRow } from "../lib/guests-store";
import { buildAgenda, type AgendaItem } from "../lib/overview-agenda";
import { ensureTasksLoaded, peekCachedTasks, taskCounts, type TaskRow } from "../lib/tasks-store";
import { ensureVendorsLoaded, vendorCount, type VendorRow } from "../lib/vendors-store";
import GettingStarted from "./GettingStarted";
import SectionIntro from "./SectionIntro";

/** The Overview home — the module shell's landing view. It answers "how's the
 *  wedding tracking?" at a glance: a countdown to the date, RSVP totals rolled
 *  up across events, a Checklist card showing the live open-task count, and a
 *  Budget card showing real spend-vs-cap and the next upcoming payment. Both
 *  Checklist and Budget are live sidebar modules with live Overview cards.
 *  When the wedding is brand new — no events, no guests — it shows the
 *  Getting-started checklist as its empty-state instead of empty stat cards.
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
  id: string;
  name: string;
  invited: number;
  attending: number;
  declined: number;
  maybe: number;
  responded: number;
  noResponse: number;
}

interface RsvpEventBreakdown {
  id: string;
  name: string;
  attending: number;
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
  rsvpEvents: RsvpEventBreakdown[];
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

function fmtBudget(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
  } catch {
    return (minor / 100).toFixed(2);
  }
}

const AGENDA_ICON: Record<AgendaItem["kind"], string> = {
  event: "📅",
  payment: "💰",
  task: "✓",
};

/** "Aug 3" style pill label from a `YYYY-MM-DD` key. */
function fmtAgendaDate(dateKey: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return dateKey;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" }).format(
    new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  );
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

/** A thin meter used by the RSVP / Budget / Checklist cards. `over` renders in a
 *  warning tone and is used when a value exceeds its max (e.g. over-budget). */
function ProgressBar(props: {
  value: number;
  max: number;
  tone?: "gold" | "over";
  label?: string;
}) {
  const pct = () =>
    props.max <= 0 ? 0 : Math.min(100, Math.max(0, (props.value / props.max) * 100));
  return (
    <div
      class="bg-surface/60 h-1.5 w-full overflow-hidden rounded-full"
      role="progressbar"
      aria-valuenow={Math.round(pct())}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={props.label ?? "Progress"}
    >
      <div
        class={`h-full rounded-full ${props.tone === "over" ? "bg-red-500/80" : "bg-gold"}`}
        style={{ width: `${pct()}%` }}
      />
    </div>
  );
}

export default function Overview(props: {
  weddingId: string;
  /** Jump to another module (+ optional sub) — wired to the shell's navigation
   *  so an Overview card can send the organiser to the right place. */
  onNavigate: (
    module: "guests" | "schedule" | "checklist" | "budget" | "vendors" | "invite" | "settings",
    sub?: string,
  ) => void;
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
        ensureTasksLoaded(props.weddingId, async () => {
          const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/tasks`));
          if (res.status === 401) {
            redirectToLogin();
            return [];
          }
          if (!res.ok) throw new Error(`tasks ${res.status}`);
          return ((await res.json()) as { tasks: TaskRow[] }).tasks;
        }),
        ensureBudgetLoaded(props.weddingId, async () => {
          const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/budget`));
          if (res.status === 401) {
            redirectToLogin();
            return { items: [], payments: [], budgetTotalMinor: null, currency: "AUD" };
          }
          // Soft-fail: a missing budget endpoint never blocks the rest of Overview.
          if (!res.ok) return { items: [], payments: [], budgetTotalMinor: null, currency: "AUD" };
          return (await res.json()) as BudgetSnapshot;
        }),
        // Vendors — soft-fail: unavailable vendors never block Overview and never
        // cache an empty array on error (which would show "0 vendors" on a backend
        // error). A non-ok / 401 response throws so ensureVendorsLoaded rejects
        // without populating the cache, leaving vendorCount() as null
        // (loading/unknown). The .catch() swallows the rejection so it never
        // bubbles out of the outer Promise.all.
        ensureVendorsLoaded(props.weddingId, async () => {
          const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/vendors`));
          if (res.status === 401) {
            redirectToLogin();
            throw new Error("unauthenticated");
          }
          if (!res.ok) throw new Error(`vendors ${res.status}`);
          return ((await res.json()) as { vendors: VendorRow[] }).vendors;
        }).catch(() => {
          // Swallow the rejection — the cache stays unpopulated (vendorCount null).
        }),
      ]);

      if (settingsRes.status === 401 || rsvpsRes.status === 401) {
        redirectToLogin();
      }

      const profile = settingsRes.ok
        ? ((await settingsRes.json()) as { wedding: WeddingProfile }).wedding
        : null;

      let rsvps: RsvpTotals | null = null;
      let rsvpEvents: RsvpEventBreakdown[] = [];
      if (rsvpsRes.ok) {
        const body = (await rsvpsRes.json()) as { events: RsvpEventTally[] };
        rsvpEvents = body.events.map((e) => ({ id: e.id, name: e.name, attending: e.attending }));
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
        rsvpEvents,
        events: eventsAccessor(props.weddingId)() ?? [],
        guests: guestsAccessor(props.weddingId)() ?? [],
      };
    } catch (err) {
      if (isAuthExpired(err)) redirectToLogin();
      // Soft-fail: an unavailable snapshot shouldn't blank the whole home.
      return { profile: null, rsvps: null, rsvpEvents: [], events: [], guests: [] };
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

  const budgetCurrency = () =>
    peekCachedBudget(props.weddingId)?.currency ?? data()?.profile?.currency ?? "AUD";

  // Reactive clock so the agenda's "today" boundary follows the real calendar
  // day even if the dashboard is left open across midnight (P-W2). Only the
  // date matters to buildAgenda, so we refresh once per local midnight rather
  // than ticking continuously.
  const [nowMs, setNowMs] = createSignal(Date.now());
  if (typeof window !== "undefined") {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleMidnight = () => {
      const now = new Date();
      // 5s past the next local midnight, guarding against sub-second drift.
      const next = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        5,
      ).getTime();
      timer = setTimeout(
        () => {
          setNowMs(Date.now());
          scheduleMidnight();
        },
        Math.max(1000, next - now.getTime()),
      );
    };
    scheduleMidnight();
    onCleanup(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  const agenda = createMemo(() =>
    buildAgenda({
      events: (data()?.events ?? []).map((e) => ({ id: e.id, name: e.name, startAt: e.startAt })),
      payments: peekCachedBudget(props.weddingId)?.payments ?? [],
      tasks: peekCachedTasks(props.weddingId) ?? [],
      now: nowMs(),
      currency: budgetCurrency(),
      horizonDays: 90,
      limit: 6,
    }),
  );

  const vendorCountValue = createMemo(() => vendorCount(props.weddingId));

  const WhatsNext = () => (
    <div class="border-border bg-surface/20 flex flex-col gap-3 rounded-sm border p-5">
      <p class="font-body text-gold text-[0.7rem] tracking-[0.18em] uppercase">What&rsquo;s next</p>
      <Show
        when={agenda().length > 0}
        fallback={
          <p class="font-body text-text-muted text-[0.85rem] leading-relaxed">
            Nothing scheduled yet — add events, payment due dates, or task deadlines.
          </p>
        }
      >
        <ul class="divide-border/40 flex flex-col divide-y">
          <For each={agenda()}>
            {(item) => (
              <li>
                <button
                  type="button"
                  onClick={() =>
                    props.onNavigate(
                      item.kind === "event"
                        ? "schedule"
                        : item.kind === "payment"
                          ? "budget"
                          : "checklist",
                    )
                  }
                  class="hover:bg-surface/40 flex w-full items-center gap-3 py-2 text-left transition-colors"
                >
                  <span class="text-text-muted w-14 shrink-0 font-mono text-[0.76rem] tabular-nums">
                    {fmtAgendaDate(item.date)}
                  </span>
                  <span aria-hidden="true" class="w-4 shrink-0 text-center text-[0.85rem]">
                    {AGENDA_ICON[item.kind]}
                  </span>
                  <span class="text-text grow truncate text-[0.88rem]">{item.label}</span>
                  <Show when={item.overdue}>
                    <span class="font-body shrink-0 text-[0.68rem] tracking-wide text-red-400 uppercase">
                      overdue
                    </span>
                  </Show>
                  <Show when={item.detail}>
                    <span class="text-text-muted shrink-0 font-mono text-[0.8rem] tabular-nums">
                      {item.detail}
                    </span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );

  return (
    <div class="flex flex-col gap-8">
      <SectionIntro
        eyebrow="Overview"
        title="Your wedding at a glance"
        description="The headline numbers — how long to go, who's replied, and what's next. Dig into any module from the sidebar."
      />

      <Show when={data.loading}>
        <div class="flex flex-col gap-4">
          <div class="bg-surface h-[120px] animate-pulse rounded-sm" />
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <For each={[1, 2, 3]}>
              {() => <div class="bg-surface h-[130px] animate-pulse rounded-sm" />}
            </For>
          </div>
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
          <div class="flex flex-col gap-4">
            <WhatsNext />
            <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {/* ── Countdown ─────────────────────────────────────────────── */}
              <div class="border-gold/25 from-surface/50 to-surface/20 flex flex-col gap-2 rounded-sm border bg-gradient-to-br p-5">
                <p class="font-body text-gold text-[0.7rem] tracking-[0.18em] uppercase">
                  Countdown
                </p>
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
                            attending across {r.eventCount}{" "}
                            {r.eventCount === 1 ? "event" : "events"}
                          </span>
                        </div>
                        <ProgressBar value={r.responded} max={r.invited} label="RSVP responses" />
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
                        <Show when={data()!.rsvpEvents.length > 0}>
                          <ul class="font-body text-text-muted flex flex-col gap-0.5 text-[0.78rem]">
                            <For each={data()!.rsvpEvents.slice(0, 5)}>
                              {(e) => (
                                <li class="flex justify-between gap-2">
                                  <span class="truncate">{e.name}</span>
                                  <span class="text-text font-mono tabular-nums">
                                    {e.attending} attending
                                  </span>
                                </li>
                              )}
                            </For>
                            <Show when={data()!.rsvpEvents.length > 5}>
                              <li class="text-text-muted/70">
                                +{data()!.rsvpEvents.length - 5} more
                              </li>
                            </Show>
                          </ul>
                        </Show>
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

              {/* ── Checklist snapshot (Phase 1 — live open-task count) ─────── */}
              <button
                type="button"
                onClick={() => props.onNavigate("checklist")}
                class="border-border bg-surface/15 hover:border-gold/40 flex flex-col gap-2 rounded-sm border p-5 text-left transition-colors"
              >
                <p class="font-body text-gold-dim text-[0.7rem] tracking-[0.18em] uppercase">
                  Checklist
                </p>
                <Show
                  when={taskCounts(props.weddingId)}
                  fallback={<p class="text-text-muted text-[0.82rem]">Loading your tasks…</p>}
                >
                  {(tc) => (
                    <Show
                      when={tc().open > 0}
                      fallback={
                        <p class="text-text-muted text-[0.82rem]">No tasks yet — add your first.</p>
                      }
                    >
                      <p class="text-text text-[0.95rem]">
                        <span class="text-gold text-[1.3rem] font-semibold">{tc().open}</span> open{" "}
                        {tc().open === 1 ? "task" : "tasks"}
                      </p>
                      <p class="text-text-muted text-[0.76rem]">
                        {tc().done} of {tc().total} done
                      </p>
                      <ProgressBar
                        value={tc().done}
                        max={tc().total}
                        label="Checklist completion"
                      />
                    </Show>
                  )}
                </Show>
              </button>

              {/* ── Vendors snapshot (live count) ─────────────────────────── */}
              <button
                type="button"
                onClick={() => props.onNavigate("vendors")}
                class="border-border bg-surface/15 hover:border-gold/40 flex flex-col gap-2 rounded-sm border p-5 text-left transition-colors"
              >
                <p class="font-body text-gold-dim text-[0.7rem] tracking-[0.18em] uppercase">
                  Vendors
                </p>
                <Show
                  when={vendorCountValue() !== null}
                  fallback={<p class="text-text-muted text-[0.82rem]">Loading your vendors…</p>}
                >
                  <Show
                    when={(vendorCountValue() ?? 0) > 0}
                    fallback={
                      <p class="text-text-muted text-[0.82rem]">No vendors yet — add your first.</p>
                    }
                  >
                    <p class="text-text text-[0.95rem]">
                      <span class="text-gold text-[1.3rem] font-semibold">
                        {vendorCountValue()}
                      </span>{" "}
                      {vendorCountValue() === 1 ? "vendor" : "vendors"} tracked
                    </p>
                  </Show>
                </Show>
              </button>

              {/* ── Budget snapshot (Phase 1 — live spend + upcoming payments) ── */}
              <button
                type="button"
                onClick={() => props.onNavigate("budget")}
                class="border-border bg-surface/15 hover:border-gold/40 flex flex-col gap-2 rounded-sm border p-5 text-left transition-colors"
              >
                <p class="font-body text-gold-dim text-[0.7rem] tracking-[0.18em] uppercase">
                  Budget
                </p>
                <Show
                  when={spentSoFar(props.weddingId) !== null}
                  fallback={<p class="text-text-muted text-[0.82rem]">Loading your budget…</p>}
                >
                  <Show
                    when={
                      (peekCachedBudget(props.weddingId)?.budgetTotalMinor ??
                        data()?.profile?.budgetTotalMinor) != null
                    }
                    fallback={
                      <p class="text-text-muted text-[0.82rem]">
                        {(spentSoFar(props.weddingId) ?? 0) > 0
                          ? `${fmtBudget(spentSoFar(props.weddingId)!, budgetCurrency())} tracked — set a total →`
                          : "No budget yet — add your first item."}
                      </p>
                    }
                  >
                    <p class="text-text text-[0.95rem]">
                      <span class="text-gold text-[1.2rem] font-semibold">
                        {fmtBudget(spentSoFar(props.weddingId) ?? 0, budgetCurrency())}
                      </span>{" "}
                      <span class="text-text-muted">
                        of{" "}
                        {fmtBudget(
                          (peekCachedBudget(props.weddingId)?.budgetTotalMinor ??
                            data()?.profile?.budgetTotalMinor)!,
                          budgetCurrency(),
                        )}
                      </span>
                    </p>
                    {(() => {
                      const cap =
                        peekCachedBudget(props.weddingId)?.budgetTotalMinor ??
                        data()?.profile?.budgetTotalMinor;
                      const spent = spentSoFar(props.weddingId) ?? 0;
                      return (
                        <Show when={cap != null}>
                          <ProgressBar
                            value={spent}
                            max={cap!}
                            tone={spent > cap! ? "over" : "gold"}
                            label="Budget spend"
                          />
                          <Show when={spent > cap!}>
                            <p class="text-[0.72rem] text-red-400">Over budget</p>
                          </Show>
                        </Show>
                      );
                    })()}
                  </Show>
                  <Show when={upcomingPayments(props.weddingId).length > 0}>
                    <p class="text-text-muted text-[0.78rem]">
                      Next: {upcomingPayments(props.weddingId)[0]!.label}
                      <Show when={upcomingPayments(props.weddingId)[0]!.dueAt}>
                        {" "}
                        · due {upcomingPayments(props.weddingId)[0]!.dueAt}
                      </Show>
                    </p>
                  </Show>
                </Show>
              </button>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}

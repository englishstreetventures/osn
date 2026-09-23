import Card, { CardCtaButton, CardEyebrow, cardClass } from "@cire/ui/card";
import { useAuth } from "@shared/rp-auth/solid";
import { Meter } from "@shared/ui/ui/meter";
import { Stat } from "@shared/ui/ui/stat";
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import {
  type BudgetSnapshot,
  ensureBudgetLoaded,
  peekCachedBudget,
  spentSoFar,
  upcomingPayments,
} from "../lib/budget-store";
import type { Module } from "../lib/dashboard-route";
import { ensureEventsLoaded, type EventRow, eventsAccessor } from "../lib/events-store";
import { ensureGuestsLoaded, guestsAccessor, type OrganiserGuestRow } from "../lib/guests-store";
import { isModuleLocked, moduleDef } from "../lib/module-nav";
import { buildAgenda, type AgendaItem } from "../lib/overview-agenda";
import { ensureTasksLoaded, peekCachedTasks, taskCounts, type TaskRow } from "../lib/tasks-store";
import { ensureVendorsLoaded, vendorCount, type VendorRow } from "../lib/vendors-store";
import GettingStarted from "./GettingStarted";
import ModuleIcon from "./ModuleIcon";
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

/** Whole days from `nowMs` (local midnight) to the wedding date (its local midnight),
 *  so "today" reads 0 and a future date reads a positive day count. Returns null
 *  for an unparseable date. `nowMs` defaults to `Date.now()` but callers should
 *  pass the midnight-refreshing `nowMs()` signal value so the result stays fresh
 *  if the dashboard is left open across midnight. */
function daysUntil(isoDate: string, nowMs: number = Date.now()): number | null {
  // `YYYY-MM-DD` — parse as a local date (not UTC) so the countdown matches the
  // organiser's calendar rather than shifting a day across timezones.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const [, y, mo, d] = m;
  const target = new Date(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date(nowMs);
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

/** The module each agenda kind sends you to. The row navigates there and carries
 *  that module's own nav icon, read from `MODULE_NAV`, so an agenda row and its module can never
 *  show different marks. */
const AGENDA_MODULE = {
  event: "events",
  payment: "budget",
  task: "checklist",
} as const satisfies Record<AgendaItem["kind"], Module>;

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

/** A card whose whole rectangle is the control — it jumps to a module. The
 *  classes rather than the `<Card>` component, because this one is a `<button>`
 *  and a `<div role="button">` would be the worse answer. */
const cardLinkClass = cardClass({ interactive: true });

export default function Overview(props: {
  weddingId: string;
  /** Entitlement keys active on this wedding. A card for a locked module is not
   *  rendered at all: the shell coerces a locked module back to Overview, so a
   *  card linking to one would be a click that visibly does nothing. */
  entitlements: readonly string[];
  /** Jump to another module (+ optional sub) — wired to the shell's navigation
   *  so an Overview card can send the organiser to the right place. */
  onNavigate: (
    module: "guests" | "events" | "checklist" | "budget" | "vendors" | "invite" | "settings",
    sub?: string,
  ) => void;
}) {
  const { authFetch } = useAuth();

  const vendorsLocked = () => isModuleLocked("vendors", props.entitlements);

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
        // Vendors — not fetched at all while the module is locked: the only
        // thing that reads the count is a card this wedding does not get.
        //
        // Soft-fail otherwise: unavailable vendors never block Overview and
        // never cache an empty array on error (which would show "0 vendors" on
        // a backend error). A non-ok / 401 response throws so
        // ensureVendorsLoaded rejects without populating the cache, leaving
        // vendorCount() as null (loading/unknown). The .catch() swallows the
        // rejection so it never bubbles out of the outer Promise.all.
        vendorsLocked()
          ? Promise.resolve()
          : ensureVendorsLoaded(props.weddingId, async () => {
              const res = await authFetch(
                apiUrl(`/api/organiser/weddings/${props.weddingId}/vendors`),
              );
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

  const budgetCurrency = () =>
    peekCachedBudget(props.weddingId)?.currency ?? data()?.profile?.currency ?? "AUD";

  // Reactive clock so the agenda's "today" boundary follows the real calendar
  // day even if the dashboard is left open across midnight. Only the
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

  // Countdown depends on nowMs() so it recomputes at midnight rather
  // than using a stale Date captured at render time.
  const countdown = createMemo(() => {
    const iso = weddingDate();
    return iso ? daysUntil(iso, nowMs()) : null;
  });

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

  // Memoize upcomingPayments — each call re-filters + re-sorts the
  // full payments array; three raw calls per Budget card render becomes one.
  const upcomingPaymentsMemo = createMemo(() => upcomingPayments(props.weddingId));

  // Memoize spentSoFar — each call re-reduces all budget items; two
  // raw calls per Budget card render becomes one.
  const spentSoFarMemo = createMemo(() => spentSoFar(props.weddingId));

  const WhatsNext = () => (
    <Card>
      <CardEyebrow>What&rsquo;s next</CardEyebrow>
      <Show
        when={agenda().length > 0}
        fallback={
          <p class="font-body text-text-muted text-ui-sm leading-relaxed">
            Nothing scheduled yet — add events, payment due dates, or task deadlines.
          </p>
        }
      >
        {/* The band runs the full width, so the rows run in columns rather than
            one 1300px-wide line of six dated entries with a hole in the middle.
            Order stays chronological, read left-to-right along each row. A rule
            per row rather than `divide-y`, which follows DOM order and so draws
            its lines in the wrong places once the list wraps into columns. */}
        <ul class="grid gap-x-8 @3xl/panel:grid-cols-2 @6xl/panel:grid-cols-3">
          <For each={agenda()}>
            {(item) => (
              <li class="border-border/40 border-t">
                <button
                  type="button"
                  onClick={() => props.onNavigate(AGENDA_MODULE[item.kind])}
                  class="hover:bg-surface/40 flex w-full items-center gap-3 py-2 text-left transition-colors"
                >
                  <span class="text-text-muted text-ui-sm w-14 shrink-0 font-mono tabular-nums">
                    {fmtAgendaDate(item.date)}
                  </span>
                  <ModuleIcon icon={moduleDef(AGENDA_MODULE[item.kind]).icon} />
                  <span class="text-text text-ui-base grow truncate">{item.label}</span>
                  <Show when={item.overdue}>
                    <span class="font-body text-error text-ui-xs shrink-0 tracking-wide uppercase">
                      overdue
                    </span>
                  </Show>
                  <Show when={item.detail}>
                    <span class="text-text-muted text-ui-sm shrink-0 font-mono tabular-nums">
                      {item.detail}
                    </span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Card>
  );

  // No section header of its own: the module shell prints the panel header —
  // the module's label and its one-line hint — directly above this.
  return (
    <div class="flex flex-col gap-8">
      <Show when={data.loading}>
        <div class="flex flex-col gap-4">
          <div class="bg-surface h-30 animate-pulse rounded-sm" />
          {/* Same intrinsic grid as the real cards, so the skeleton has the
              same column count at every width. */}
          <div class="auto-grid [--auto-grid-min:15rem]">
            <For each={[1, 2, 3]}>
              {() => <div class="bg-surface h-32.5 animate-pulse rounded-sm" />}
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
              if (tab === "events") props.onNavigate("events");
              else if (tab === "guests") props.onNavigate("guests", "list");
              else if (tab === "invite") props.onNavigate("invite", "design");
            }}
          />
        </Show>

        <Show when={!isFresh()}>
          {/* The home reads top-down as a briefing: the agenda band first —
              what needs attention, dated — then the module snapshots beneath
              it. The written summary the band will lead
              with slots in at the top of this stack, above `<WhatsNext />`.
              The band earns the full width by laying its rows out in columns —
              see the list inside `WhatsNext`. */}
          <div class="flex flex-col gap-4">
            <WhatsNext />
            {/* The cards themselves need no breakpoints: as many ≥15rem columns
                as fit, so the widescreen fills rows instead of leaving three
                stretched cards on a 1300px row. */}
            <div class="auto-grid [--auto-grid-min:15rem]">
              {/* ── Countdown ─────────────────────────────────────────────── */}
              <Card tone="accent">
                <CardEyebrow>Countdown</CardEyebrow>
                <Show
                  when={weddingDate()}
                  fallback={
                    <>
                      <p class="font-display text-text text-ui-lg leading-tight font-light">
                        No date yet
                      </p>
                      <CardCtaButton onClick={() => props.onNavigate("settings", "wedding")}>
                        Set your wedding date
                      </CardCtaButton>
                    </>
                  }
                >
                  {(iso) => (
                    <>
                      <Show
                        when={countdown() !== null}
                        fallback={
                          <p class="font-display text-text text-ui-lg leading-tight font-light">
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
                              <p class="font-display text-gold text-ui-xl leading-none font-light">
                                Today!
                              </p>
                            );
                          }
                          if (days === 1) {
                            return (
                              <p class="font-display text-gold text-ui-xl leading-none font-light">
                                Tomorrow!
                              </p>
                            );
                          }
                          const abs = Math.abs(days);
                          const unit = abs === 1 ? "day" : "days";
                          return (
                            <Stat value={abs} label={days > 0 ? `${unit} to go` : `${unit} ago`} />
                          );
                        })()}
                      </Show>
                      <p class="font-body text-text-muted text-ui-sm">{formatWeddingDate(iso())}</p>
                    </>
                  )}
                </Show>
              </Card>

              {/* ── RSVP totals ───────────────────────────────────────────── */}
              <Card>
                <CardEyebrow>RSVPs</CardEyebrow>
                <Show
                  when={data()?.rsvps && data()!.rsvps!.eventCount > 0}
                  fallback={
                    <p class="font-body text-text-muted text-ui-sm leading-relaxed">
                      Replies will roll up here once you have events and guests.
                    </p>
                  }
                >
                  {(() => {
                    const r = data()!.rsvps!;
                    return (
                      <>
                        <div class="flex items-baseline gap-2">
                          <span class="font-display text-gold text-ui-xl leading-none tabular-nums">
                            {r.attending}
                          </span>
                          <span class="font-body text-text-muted text-ui-sm">
                            attending across {r.eventCount}{" "}
                            {r.eventCount === 1 ? "event" : "events"}
                          </span>
                        </div>
                        <Meter value={r.responded} max={r.invited} label="RSVP responses" />
                        <dl class="font-body text-text-muted text-ui-sm grid grid-cols-2 gap-x-4 gap-y-1">
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
                          <ul class="font-body text-text-muted text-ui-sm flex flex-col gap-0.5">
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
                        <CardCtaButton onClick={() => props.onNavigate("guests", "rsvps")}>
                          See replies per event
                        </CardCtaButton>
                      </>
                    );
                  })()}
                </Show>
              </Card>

              {/* ── Guests + events snapshot ─────────────────────────────── */}
              <Card>
                <CardEyebrow>Guests &amp; events</CardEyebrow>
                <dl class="font-body text-text-muted text-ui-sm flex flex-col gap-1.5">
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
                <CardCtaButton onClick={() => props.onNavigate("guests", "list")}>
                  Open the guest list
                </CardCtaButton>
              </Card>

              {/* ── Checklist snapshot (Phase 1 — live open-task count) ─────── */}
              <button
                type="button"
                onClick={() => props.onNavigate("checklist")}
                class={cardLinkClass}
              >
                <CardEyebrow>Checklist</CardEyebrow>
                <Show
                  when={taskCounts(props.weddingId)}
                  fallback={<p class="text-text-muted text-ui-sm">Loading your tasks…</p>}
                >
                  {(tc) => (
                    <Show
                      when={tc().open > 0}
                      fallback={
                        <p class="text-text-muted text-ui-sm">No tasks yet — add your first.</p>
                      }
                    >
                      <p class="text-text text-ui-base">
                        <span class="text-gold text-ui-lg font-semibold">{tc().open}</span> open{" "}
                        {tc().open === 1 ? "task" : "tasks"}
                      </p>
                      <p class="text-text-muted text-ui-sm">
                        {tc().done} of {tc().total} done
                      </p>
                      <Meter value={tc().done} max={tc().total} label="Checklist completion" />
                    </Show>
                  )}
                </Show>
              </button>

              {/* ── Vendors snapshot (live count) ─────────────────────────── */}
              {/* Absent while the module is locked. The shell sends a locked
                  module back to Overview, so this card would otherwise be a
                  click that lands on the page it was clicked from. The faded
                  nav row is where the upgrade is offered. */}
              <Show when={!vendorsLocked()}>
                <button
                  type="button"
                  onClick={() => props.onNavigate("vendors")}
                  class={cardLinkClass}
                >
                  <CardEyebrow>Vendors</CardEyebrow>
                  <Show
                    when={vendorCountValue() !== null}
                    fallback={<p class="text-text-muted text-ui-sm">Loading your vendors…</p>}
                  >
                    <Show
                      when={(vendorCountValue() ?? 0) > 0}
                      fallback={
                        <p class="text-text-muted text-ui-sm">No vendors yet — add your first.</p>
                      }
                    >
                      <p class="text-text text-ui-base">
                        <span class="text-gold text-ui-lg font-semibold">{vendorCountValue()}</span>{" "}
                        {vendorCountValue() === 1 ? "vendor" : "vendors"} tracked
                      </p>
                    </Show>
                  </Show>
                </button>
              </Show>

              {/* ── Budget snapshot (Phase 1 — live spend + upcoming payments) ── */}
              <button
                type="button"
                onClick={() => props.onNavigate("budget")}
                class={cardLinkClass}
              >
                <CardEyebrow>Budget</CardEyebrow>
                <Show
                  when={spentSoFarMemo() !== null}
                  fallback={<p class="text-text-muted text-ui-sm">Loading your budget…</p>}
                >
                  <Show
                    when={
                      (peekCachedBudget(props.weddingId)?.budgetTotalMinor ??
                        data()?.profile?.budgetTotalMinor) != null
                    }
                    fallback={
                      <p class="text-text-muted text-ui-sm">
                        {(spentSoFarMemo() ?? 0) > 0
                          ? `${fmtBudget(spentSoFarMemo()!, budgetCurrency())} tracked — set a total →`
                          : "No budget yet — add your first item."}
                      </p>
                    }
                  >
                    <p class="text-text text-ui-base">
                      <span class="text-gold text-ui-lg font-semibold">
                        {fmtBudget(spentSoFarMemo() ?? 0, budgetCurrency())}
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
                      const spent = spentSoFarMemo() ?? 0;
                      return (
                        <Show when={cap != null}>
                          <Meter
                            value={spent}
                            max={cap!}
                            tone={spent > cap! ? "over" : "accent"}
                            label="Budget spend"
                          />
                          <Show when={spent > cap!}>
                            <p class="text-error text-ui-xs">Over budget</p>
                          </Show>
                        </Show>
                      );
                    })()}
                  </Show>
                  <Show when={upcomingPaymentsMemo().length > 0}>
                    <p class="text-text-muted text-ui-sm">
                      Next: {upcomingPaymentsMemo()[0]!.label}
                      <Show when={upcomingPaymentsMemo()[0]!.dueAt}>
                        {" "}
                        · due {upcomingPaymentsMemo()[0]!.dueAt}
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

import Card, { CardCtaButton, cardClass } from "@cire/ui/card";
import Eyebrow from "@cire/ui/eyebrow";
import SkeletonOutline from "@cire/ui/skeleton-outline";
import { useAuth } from "@shared/rp-auth/solid";
import { Meter } from "@shared/ui/ui/meter";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../lib/api";
import {
  type BudgetSnapshot,
  ensureBudgetLoaded,
  peekCachedBudget,
  spentSoFar,
  upcomingPayments,
} from "../lib/budget-store";
import type { Module } from "../lib/dashboard-route";
import {
  ensureEventsLoaded,
  type EventRow,
  eventsAccessor,
  hasCachedEvents,
} from "../lib/events-store";
import {
  ensureGuestsLoaded,
  guestsAccessor,
  hasCachedGuests,
  type OrganiserGuestRow,
} from "../lib/guests-store";
import { isModuleLocked, moduleDef } from "../lib/module-nav";
import { formatMinor } from "../lib/money";
import { buildAgenda, type AgendaItem } from "../lib/overview-agenda";
import { fetchRsvpChanges, type RsvpChanges } from "../lib/rsvp-changes";
import {
  ensureRsvpChangesLoaded,
  ensureRsvpsLoaded,
  type RsvpEvent,
  rsvpChangesAccessor,
  rsvpsAccessor,
  setCachedRsvpChanges,
} from "../lib/rsvps-store";
import {
  ensureSettingsLoaded,
  settingsAccessor,
  type WeddingSettings,
} from "../lib/settings-store";
import { useTasksChanged } from "../lib/tasks-changed";
import {
  ensureTasksLoaded,
  peekCachedTasks,
  readTaskList,
  rereadTasks,
  type TaskList,
  taskCounts,
} from "../lib/tasks-store";
import type { Tier } from "../lib/tiers";
import { ensureVendorsLoaded, vendorCount, type VendorRow } from "../lib/vendors-store";
import GettingStarted from "./GettingStarted";
import ModuleIcon from "./ModuleIcon";
import RsvpChangesCard from "./RsvpChangesCard";
/** The Overview home — the module shell's landing view. It answers "how's the
 *  wedding tracking?" at a glance: a countdown to the date, RSVP totals rolled
 *  up across events, a Checklist card showing the live open-task count, and a
 *  Budget card showing real spend-vs-cap and the next upcoming payment.
 *  When the wedding is brand new — no events, no guests — it shows the
 *  Getting-started checklist as its empty-state instead of empty stat cards.
 *
 *  The Checklist, Budget and Vendors cards follow the wedding's tier: a module
 *  the tier does not include gets no card and no read. The API answers 402 to
 *  those reads, and a refused tasks read would otherwise take the whole
 *  snapshot down with it.
 *
 *  Everything is read through the shared weddingId-keyed caches — settings,
 *  RSVP replies and the changes card, events, guests, tasks, budget, vendors —
 *  so a visit after another module, or an earlier visit, draws at once from
 *  them and reads only what is missing or stale, behind what it shows. The
 *  placeholders show only on a visit that finds a value it waits on missing.
 *  Everything degrades softly: a failed sub-read hides its card, never blocks
 *  the page. */

type WeddingProfile = Pick<
  WeddingSettings,
  "weddingDate" | "guestCountEstimate" | "currency" | "budgetTotalMinor"
>;

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

/**
 * What the overview draws hollow from while it loads (`SkeletonOutline`): an
 * agenda, a countdown, the replies and the counts of a wedding a few months
 * out, run through the same band and cards as the loaded ones. Never shown —
 * every word in the outline is transparent — so they only have to be shaped
 * like a real overview. The owner's call (englishstreetventures/osn#1955):
 * typed samples beside the view, not data.
 */
const sampleAgendaItem = (
  kind: AgendaItem["kind"],
  date: string,
  label: string,
  detail: string | null = null,
): AgendaItem => ({
  key: `${kind}:sample-${date}`,
  kind,
  date,
  label,
  detail,
  sourceId: `sample-${date}`,
  overdue: false,
});

const SAMPLE_AGENDA: readonly AgendaItem[] = [
  sampleAgendaItem("task", "2027-01-08", "Book the florist"),
  sampleAgendaItem("payment", "2027-01-15", "Venue deposit", "$2,400.00"),
  sampleAgendaItem("task", "2027-01-22", "Send the save-the-dates"),
  sampleAgendaItem("event", "2027-02-05", "Engagement drinks"),
  sampleAgendaItem("payment", "2027-02-12", "Photographer", "$900.00"),
  sampleAgendaItem("task", "2027-02-19", "Choose the menu"),
];

const SAMPLE_COUNTDOWN = { date: "2027-03-20", days: 135 } as const;

const SAMPLE_RSVPS: Pick<OverviewData, "rsvps" | "rsvpEvents"> = {
  rsvps: {
    invited: 240,
    attending: 128,
    declined: 24,
    maybe: 8,
    responded: 160,
    noResponse: 80,
    eventCount: 2,
  },
  rsvpEvents: [
    { id: "sample-ceremony", name: "Ceremony", attending: 64 },
    { id: "sample-reception", name: "Reception", attending: 64 },
  ],
};

const SAMPLE_COUNTS = { households: 48, events: 3, estimate: 150 } as const;

/** A card whose whole rectangle is the control — it jumps to a module. The
 *  classes rather than the `<Card>` component, because this one is a `<button>`
 *  and a `<div role="button">` would be the worse answer. */
const cardLinkClass = cardClass({ interactive: true });

/** Under the briefing: the agenda, the side column and the module cards
 *  (`overview-body` in `global.css`, which holds the layout and its reasons). */
const BODY = "overview-body";

export default function Overview(props: {
  weddingId: string;
  /** The wedding's plan tier. A card for a module it does not include is not
   *  rendered at all, and that module's data is not read: the shell coerces a
   *  locked module back to Overview, so a card linking to one would be a click
   *  that visibly does nothing. */
  tier: Tier;
  /** Jump to another module (+ optional sub) — wired to the shell's navigation
   *  so an Overview card can send the organiser to the right place. */
  onNavigate: (
    module: "guests" | "events" | "checklist" | "budget" | "vendors" | "invite" | "settings",
    sub?: string,
  ) => void;
}) {
  const { authFetch } = useAuth();

  const checklistLocked = () => isModuleLocked("checklist", props.tier);
  const budgetLocked = () => isModuleLocked("budget", props.tier);
  const vendorsLocked = () => isModuleLocked("vendors", props.tier);

  // The changes card's summary, read beside the reads below rather than after
  // them. It is not part of `data`, so the page never waits on it, and a read
  // that fails leaves the card out.
  const rsvpChanges = rsvpChangesAccessor(props.weddingId);
  const setRsvpChanges = (next: RsvpChanges) => setCachedRsvpChanges(props.weddingId, next);

  const loadTasks = async () => {
    const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/tasks")));
    if (res.status === 401) {
      redirectToLogin();
      return [];
    }
    if (!res.ok) throw new Error(`tasks ${res.status}`);
    return readTaskList(props.weddingId, (await res.json()) as TaskList);
  };

  // The open wedding's socket says the tasks changed: the checklist card reads
  // them again, one read for however many signals land while a read is out
  // (`rereadTasks`). Never while the module is locked, where the read would be
  // refused and nothing shows it.
  createEffect(
    on(
      useTasksChanged(),
      () => {
        if (checklistLocked()) return;
        rereadTasks(props.weddingId, loadTasks).catch((err: unknown) => {
          if (isAuthExpired(err)) redirectToLogin();
        });
      },
      { defer: true },
    ),
  );

  const settings = settingsAccessor(props.weddingId);
  const replies = rsvpsAccessor(props.weddingId);
  const eventRows = eventsAccessor(props.weddingId);
  const guestRows = guestsAccessor(props.weddingId);

  /** A read's 401 sends the organiser to sign in; anything else it reports. */
  const read = async <T,>(path: string): Promise<T> => {
    const res = await authFetch(apiUrl(weddingPath(props.weddingId, path)));
    if (res.status === 401) {
      redirectToLogin();
      throw new Error("unauthenticated");
    }
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return (await res.json()) as T;
  };

  // Every read, each through its cache, so one that is fresh sends nothing and
  // one that is stale reads again behind what is shown. Settled together, each
  // failure kept to its own card.
  const loads = (async () => {
    const results = await Promise.allSettled([
      // The card's read first: it waits on none of the others.
      ensureRsvpChangesLoaded(props.weddingId, async () => {
        const changes = await fetchRsvpChanges(authFetch, props.weddingId);
        if (!changes) throw new Error("rsvp-changes unavailable");
        return changes;
      }),
      ensureSettingsLoaded(props.weddingId, async () => {
        return (await read<{ wedding: WeddingSettings }>("/settings")).wedding;
      }),
      ensureRsvpsLoaded(props.weddingId, async () => ({
        events: (await read<{ events: RsvpEvent[] }>("/rsvps")).events,
        withBadges: false,
      })),
      ensureEventsLoaded(props.weddingId, () => read<EventRow[]>("/events")),
      ensureGuestsLoaded(props.weddingId, () => read<OrganiserGuestRow[]>("/guests")),
      // Tasks and budget — not fetched at all while their module is locked:
      // the API refuses both reads below Gold, and nothing on this page that
      // reads them is shown.
      checklistLocked() ? Promise.resolve() : ensureTasksLoaded(props.weddingId, loadTasks),
      budgetLocked()
        ? Promise.resolve()
        : ensureBudgetLoaded(props.weddingId, async () => {
            const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/budget")));
            if (res.status === 401) {
              redirectToLogin();
              return { items: [], payments: [], budgetTotalMinor: null, currency: "AUD" };
            }
            // Soft-fail: a missing budget endpoint never blocks the rest of Overview.
            if (!res.ok) {
              return { items: [], payments: [], budgetTotalMinor: null, currency: "AUD" };
            }
            return (await res.json()) as BudgetSnapshot;
          }),
      // Vendors — not fetched at all while the module is locked: the only
      // thing that reads the count is a card this wedding does not get. A
      // failed read leaves the count unknown rather than caching an empty
      // list, which would read as "0 vendors".
      vendorsLocked()
        ? Promise.resolve()
        : ensureVendorsLoaded(props.weddingId, async () => {
            return (await read<{ vendors: VendorRow[] }>("/vendors")).vendors;
          }),
    ]);
    for (const result of results) {
      if (result.status === "rejected" && isAuthExpired(result.reason)) redirectToLogin();
    }
  })();

  // The placeholders wait for the reads when a value the page is built from is
  // not cached at all; a stale one is shown while it is read again. The one
  // exception: events and guests decide whether the home is Getting started or
  // the briefing, so empty rows known out of date wait too. An import may have
  // just filled them, and drawing the guide from them would show a step the
  // organiser has just done as still to do.
  const [settled, setSettled] = createSignal(
    untrack(() => {
      const events = eventRows();
      const guests = guestRows();
      if (settings() === null || replies() === null || events === null || guests === null) {
        return false;
      }
      const stale = !hasCachedEvents(props.weddingId) || !hasCachedGuests(props.weddingId);
      return !(stale && events.length === 0 && guests.length === 0);
    }),
  );
  void loads.finally(() => setSettled(true));

  // The replies' tallies, worked out only when the replies change; the other
  // reads each feed only what they draw.
  const replySummary = createMemo<Pick<OverviewData, "rsvps" | "rsvpEvents">>(() => {
    const body = replies();
    const rsvpEvents = (body?.events ?? []).map((e) => ({
      id: e.id,
      name: e.name,
      attending: e.attending,
    }));
    const rsvps = body
      ? body.events.reduce<RsvpTotals>(
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
        )
      : null;
    return { rsvps, rsvpEvents };
  });
  const data = (): OverviewData => ({
    profile: settings(),
    ...replySummary(),
    events: eventRows() ?? [],
    guests: guestRows() ?? [],
  });

  // Households, deduped from the (repeated-per-member) guest rows.
  const householdCount = createMemo(() => {
    const ids = new Set<string>();
    for (const g of guestRows() ?? []) ids.add(g.familyId);
    return ids.size;
  });
  const eventCount = createMemo(() => eventRows()?.length ?? 0);

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

  // A locked module contributes no rows: each row navigates to its module, and
  // the shell would send a locked one straight back here.
  const agenda = createMemo(() =>
    buildAgenda({
      events: (eventRows() ?? []).map((e) => ({ id: e.id, name: e.name, startAt: e.startAt })),
      payments: budgetLocked() ? [] : (peekCachedBudget(props.weddingId)?.payments ?? []),
      tasks: checklistLocked() ? [] : (peekCachedTasks(props.weddingId) ?? []),
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

  /** The agenda band: what needs attention, dated, in columns. */
  const whatsNext = (items: () => readonly AgendaItem[]) => (
    <Card class="overview-agenda @container/agenda">
      <Eyebrow>What&rsquo;s next</Eyebrow>
      <Show
        when={items().length > 0}
        fallback={
          <p class="font-body text-text-muted text-ui-sm leading-ui-normal">
            Nothing scheduled yet — add events, payment due dates, or task deadlines.
          </p>
        }
      >
        {/* One column beside the replies; two once the card itself is wide,
            where it runs the full width of a mid-size panel. Order stays
            chronological, read left-to-right along each row. A rule per row
            rather than `divide-y`, which follows DOM order and so draws its
            lines in the wrong places once the list wraps into columns. */}
        <ul class="grid gap-x-8 @3xl/agenda:grid-cols-2">
          <For each={items()}>
            {(item) => (
              <li class="border-border/40 border-t">
                {/* Raw: a whole list row is the control, ruled rather than boxed. */}
                <button
                  type="button"
                  // A ruled row of words, not a boxed control: hollow, its
                  // date, glyph and label each draw as themselves.
                  data-skeleton="text"
                  onClick={() => props.onNavigate(AGENDA_MODULE[item.kind])}
                  class="hover:bg-surface/40 transition-ui-colors flex w-full items-center gap-3 py-2 text-left duration-(--dur-fast) ease-(--ease-out)"
                >
                  <span class="text-text-muted text-ui-sm font-ui-mono w-14 shrink-0 tabular-nums">
                    {fmtAgendaDate(item.date)}
                  </span>
                  <ModuleIcon icon={moduleDef(AGENDA_MODULE[item.kind]).icon} />
                  <span class="text-text text-ui-base grow truncate">{item.label}</span>
                  <Show when={item.overdue}>
                    <span class="font-body text-error text-ui-xs tracking-ui-wider shrink-0 uppercase">
                      overdue
                    </span>
                  </Show>
                  <Show when={item.detail}>
                    <span class="text-text-muted text-ui-sm font-ui-mono shrink-0 tabular-nums">
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

  /** The countdown to the date, or the date's absence and the way to set it.
   *  The briefing's first half: no card of its own, the band is the card. */
  const countdownBlock = (date: () => string | null, daysLeft: () => number | null) => (
    <div class="flex flex-col gap-3">
      <Eyebrow>Countdown</Eyebrow>
      <Show
        when={date()}
        fallback={
          <>
            <p class="font-display text-text text-ui-xl leading-ui-tight font-light">No date yet</p>
            <CardCtaButton onClick={() => props.onNavigate("settings", "wedding")}>
              Set your wedding date
            </CardCtaButton>
          </>
        }
      >
        {(iso) => (
          <>
            <Show
              when={daysLeft() !== null}
              fallback={
                <p class="font-display text-text text-ui-xl leading-ui-tight font-light">
                  {formatWeddingDate(iso())}
                </p>
              }
            >
              {(() => {
                const days = daysLeft()!;
                // The count shows ONCE: a headline number or word with one
                // label under it. "Tomorrow!"/"Today!" read as words with no
                // numeral above them.
                if (days === 0 || days === 1) {
                  return (
                    <p class="font-display text-gold-ink text-ui-2xl leading-ui-none font-light">
                      {days === 0 ? "Today!" : "Tomorrow!"}
                    </p>
                  );
                }
                const abs = Math.abs(days);
                const unit = abs === 1 ? "day" : "days";
                return (
                  <p class="flex flex-col gap-1">
                    <span class="font-body text-gold-ink text-ui-2xl leading-ui-none font-light tabular-nums">
                      {abs}
                    </span>
                    <span class="font-body text-text text-ui-base">
                      {days > 0 ? `${unit} to go` : `${unit} ago`}
                    </span>
                  </p>
                );
              })()}
            </Show>
            <p class="font-body text-text-muted text-ui-sm">{formatWeddingDate(iso())}</p>
          </>
        )}
      </Show>
    </div>
  );

  /** The replies across every event: the briefing's second half. Its own
   *  container, so its four figures run in a row once it has the room. */
  const repliesBlock = (summary: () => Pick<OverviewData, "rsvps" | "rsvpEvents"> | undefined) => (
    <div class="@container/replies flex flex-col gap-3">
      <Eyebrow>RSVPs</Eyebrow>
      <Show
        when={summary()?.rsvps && summary()!.rsvps!.eventCount > 0}
        fallback={
          <p class="font-body text-text-muted text-ui-sm leading-ui-normal">
            Replies will roll up here once you have events and guests.
          </p>
        }
      >
        {(() => {
          const r = summary()!.rsvps!;
          return (
            <>
              <div class="flex items-baseline gap-3">
                <span class="font-body text-gold-ink text-ui-2xl leading-ui-none font-light tabular-nums">
                  {r.attending}
                </span>
                <span class="font-body text-text text-ui-base">
                  attending across {r.eventCount} {r.eventCount === 1 ? "event" : "events"}
                </span>
              </div>
              <Meter value={r.responded} max={r.invited} label="RSVP responses" />
              {/* Figure over word, so four of them fit one row of a phone's
                  band at two columns and a wide band's at four. */}
              <dl class="font-body text-text-muted text-ui-sm grid grid-cols-2 gap-x-4 gap-y-3 @md/replies:grid-cols-4">
                <div class="flex flex-col-reverse gap-0.5">
                  <dt>Declined</dt>
                  <dd class="text-text font-ui-mono text-ui-md">{r.declined}</dd>
                </div>
                <div class="flex flex-col-reverse gap-0.5">
                  <dt>Maybe</dt>
                  <dd class="text-text font-ui-mono text-ui-md">{r.maybe}</dd>
                </div>
                <div class="flex flex-col-reverse gap-0.5">
                  <dt>No reply</dt>
                  <dd class="text-text font-ui-mono text-ui-md">{r.noResponse}</dd>
                </div>
                <div class="flex flex-col-reverse gap-0.5">
                  <dt>Invited</dt>
                  <dd class="text-text font-ui-mono text-ui-md">{r.invited}</dd>
                </div>
              </dl>
              <CardCtaButton onClick={() => props.onNavigate("guests", "rsvps")}>
                See replies per event
              </CardCtaButton>
            </>
          );
        })()}
      </Show>
    </div>
  );

  /** The band at the top: how long to go, and how the replies stand. One card
   *  in two halves, split by a hairline once the panel is wide enough for
   *  both side by side, so the two figures a host checks first sit together. */
  const briefing = (
    date: () => string | null,
    daysLeft: () => number | null,
    summary: () => Pick<OverviewData, "rsvps" | "rsvpEvents"> | undefined,
  ) => (
    <Card tone="accent" padding="lg">
      <div class="grid gap-6 @3xl/panel:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @3xl/panel:gap-0">
        <div class="@3xl/panel:pr-8">{countdownBlock(date, daysLeft)}</div>
        <div class="border-border border-t pt-6 @3xl/panel:border-t-0 @3xl/panel:border-l @3xl/panel:pt-0 @3xl/panel:pl-8">
          {repliesBlock(summary)}
        </div>
      </div>
    </Card>
  );

  /** Who is coming to which event: the first five events' attending counts. */
  const byEvent = (summary: () => Pick<OverviewData, "rsvps" | "rsvpEvents"> | undefined) => (
    <Show when={(summary()?.rsvpEvents.length ?? 0) > 0}>
      <Card>
        <Eyebrow>Attending by event</Eyebrow>
        <ul class="font-body text-text-muted text-ui-sm flex flex-col">
          <For each={summary()!.rsvpEvents.slice(0, 5)}>
            {(e) => (
              <li class="border-border/40 flex items-baseline justify-between gap-3 border-t py-1.5 first:border-t-0 first:pt-0">
                <span class="min-w-0 truncate">{e.name}</span>
                <span class="text-text font-ui-mono shrink-0 tabular-nums">
                  {e.attending} attending
                </span>
              </li>
            )}
          </For>
          <Show when={summary()!.rsvpEvents.length > 5}>
            <li class="pt-1.5">+{summary()!.rsvpEvents.length - 5} more</li>
          </Show>
        </ul>
      </Card>
    </Show>
  );

  /** How many households and events the wedding has, and the guest estimate. */
  const guestsCard = (
    households: () => number,
    events: () => number,
    estimate: () => number | null | undefined,
  ) => (
    <Card>
      <Eyebrow>Guests &amp; events</Eyebrow>
      <dl class="font-body text-text-muted text-ui-sm flex flex-col gap-1.5">
        <div class="flex justify-between gap-2">
          <dt>Households</dt>
          <dd class="text-text font-ui-mono">{households()}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt>Events</dt>
          <dd class="text-text font-ui-mono">{events()}</dd>
        </div>
        <Show when={estimate() != null}>
          <div class="flex justify-between gap-2">
            <dt>Guest estimate</dt>
            <dd class="text-text font-ui-mono">{estimate()}</dd>
          </div>
        </Show>
      </dl>
      <CardCtaButton onClick={() => props.onNavigate("guests", "list")}>
        Open the guest list
      </CardCtaButton>
    </Card>
  );

  // No section header of its own: the module shell prints the panel header —
  // the module's label and its one-line hint — directly above this.
  return (
    // Busy while the first read is out: the placeholders are all it holds then.
    <div class="flex flex-col gap-8" aria-busy={settled() ? undefined : "true"}>
      <Show when={!settled()}>
        {/* The agenda band and the first three cards drawn hollow from the
            samples, in the loaded stack and grid, so they take the loaded
            heights at every width (DESIGN.md §4, Hollow rows). */}
        <SkeletonOutline>
          <div class="flex flex-col gap-4">
            {briefing(
              () => SAMPLE_COUNTDOWN.date,
              () => SAMPLE_COUNTDOWN.days,
              () => SAMPLE_RSVPS,
            )}
            <div class={BODY}>
              {whatsNext(() => SAMPLE_AGENDA)}
              <div class="overview-side flex flex-col gap-4">
                {byEvent(() => SAMPLE_RSVPS)}
                {guestsCard(
                  () => SAMPLE_COUNTS.households,
                  () => SAMPLE_COUNTS.events,
                  () => SAMPLE_COUNTS.estimate,
                )}
              </div>
            </div>
          </div>
        </SkeletonOutline>
      </Show>

      <Show when={settled()}>
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
              else if (tab === "invite") props.onNavigate("invite", "template");
            }}
          />
        </Show>

        <Show when={!isFresh()}>
          {/* The home reads top-down as a briefing: the agenda band first —
              what needs attention, dated — then the module snapshots beneath
              it. The written summary the band will lead
              with slots in at the top of this stack, above `whatsNext`.
              The band earns the full width by laying its rows out in columns —
              see the list inside `whatsNext`. */}
          <div class="flex flex-col gap-4">
            {/* ── The briefing: the countdown and the replies ──────────── */}
            {briefing(weddingDate, countdown, replySummary)}

            {/* ── What's next, beside who answered ─────────────────────── */}
            <div class={BODY}>
              {whatsNext(agenda)}
              <div class="overview-side flex flex-col gap-4">
                {/* Renders nothing when its read failed, so it never blanks
                    the column. */}
                <RsvpChangesCard
                  weddingId={props.weddingId}
                  changes={rsvpChanges}
                  setChanges={setRsvpChanges}
                  onNavigate={props.onNavigate}
                />
                {byEvent(replySummary)}
                {guestsCard(householdCount, eventCount, () => data()?.profile?.guestCountEstimate)}
              </div>

              {/* ── The planning modules, one card each ──────────────── */}
              {/* As many ≥15rem columns as fit, each as tall as its own
                  content: a short card does not stretch to a tall one.
                  Empty when every one is locked, and then drawn as nothing. */}
              <div class="auto-grid overview-modules items-start [--auto-grid-min:15rem] empty:hidden">
                {/* ── Checklist snapshot (live open-task count) ─────────────── */}
                {/* Absent while the module is locked, like Vendors below. */}
                <Show when={!checklistLocked()}>
                  <button
                    type="button"
                    onClick={() => props.onNavigate("checklist")}
                    class={cardLinkClass}
                  >
                    <Eyebrow>Checklist</Eyebrow>
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
                            <span class="text-gold-ink text-ui-lg font-semibold">{tc().open}</span>{" "}
                            open {tc().open === 1 ? "task" : "tasks"}
                          </p>
                          <p class="text-text-muted text-ui-sm">
                            {tc().done} of {tc().total} done
                          </p>
                          <Meter value={tc().done} max={tc().total} label="Checklist completion" />
                        </Show>
                      )}
                    </Show>
                  </button>
                </Show>

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
                    <Eyebrow>Vendors</Eyebrow>
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
                          <span class="text-gold-ink text-ui-lg font-semibold">
                            {vendorCountValue()}
                          </span>{" "}
                          {vendorCountValue() === 1 ? "vendor" : "vendors"} tracked
                        </p>
                      </Show>
                    </Show>
                  </button>
                </Show>

                {/* ── Budget snapshot (live spend + upcoming payments) ───────── */}
                {/* Absent while the module is locked, like Vendors above. */}
                <Show when={!budgetLocked()}>
                  <button
                    type="button"
                    onClick={() => props.onNavigate("budget")}
                    class={cardLinkClass}
                  >
                    <Eyebrow>Budget</Eyebrow>
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
                              ? `${formatMinor(spentSoFarMemo()!, budgetCurrency())} tracked — set a total →`
                              : "No budget yet — add your first item."}
                          </p>
                        }
                      >
                        <p class="text-text text-ui-base">
                          <span class="text-gold-ink text-ui-lg font-semibold">
                            {formatMinor(spentSoFarMemo() ?? 0, budgetCurrency())}
                          </span>{" "}
                          <span class="text-text-muted">
                            of{" "}
                            {formatMinor(
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
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}

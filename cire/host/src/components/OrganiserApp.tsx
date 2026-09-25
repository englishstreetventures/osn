import { AuthContext, AuthProvider, useAuth } from "@shared/rp-auth/solid";
import { toast, Toaster } from "@shared/toast";
import { Notice } from "@shared/ui/ui/notice";
import {
  createEffect,
  createResource,
  createSignal,
  lazy,
  on,
  onCleanup,
  onMount,
  type ParentProps,
  type Setter,
  Show,
  Suspense,
  untrack,
} from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { createCommandShortcut } from "../lib/command-shortcut";
import {
  type DashboardRoute,
  DEFAULT_MODULE,
  defaultSub,
  LIST_ROUTE,
  type Module,
  parseRoute,
  serializeRoute,
} from "../lib/dashboard-route";
import { watchForbidden } from "../lib/forbidden-watch";
import { CIRE_API_URL } from "../lib/osn";
import { initTheme } from "../lib/theme";
import { confirmNavigation } from "../lib/unsaved-guard";
import { fetchPurchase } from "../lib/upgrade-api";
import {
  clearUpgradeParams,
  POLL_ATTEMPTS,
  pollDelayMs,
  readUpgradeReturn,
} from "../lib/upgrade-return";
import { invalidateCatalogue } from "../lib/upgrade-store";
import { dropWeddingCaches, openWeddingCaches } from "../lib/wedding-caches";
import { normaliseWeddingRole, ROLE_COPY, surfacesFor } from "../lib/wedding-roles";
import type { WeddingSummary } from "./CreateWeddingForm";
import ModuleShell from "./ModuleShell";
import SecurityPanel from "./SecurityPanel";
import TopBar from "./TopBar";
import WeddingList from "./WeddingList";

/**
 * The palette is the one piece of chrome nobody sees until they ask for it, and
 * it is not small — a dialog, a filtered listbox, the module catalogue and the
 * theme switch. Splitting it out is the portal's only route-level split that
 * costs nothing in reach: the shortcut that summons it lives in
 * `lib/command-shortcut`, so it is bound from the first paint whether or not
 * this chunk has arrived.
 */
const CommandPalette = lazy(() => import("./CommandPalette"));

/**
 * How long after the last check the portal asks the API again, when the tab
 * comes back into view or the organiser moves within the dashboard, which
 * weddings the organiser holds and in what role. Short enough that a removal
 * stops a tab in use showing that wedding within a minute; long enough that
 * flicking between tabs or modules is not a request each time.
 */
const RECHECK_AFTER_MS = 60_000;

/** A wedding-list check still unanswered after this long is abandoned: the
 *  next trigger sends a fresh one rather than waiting on it. */
const RECHECK_ABANDONED_AFTER_MS = 30_000;

type WeddingsState =
  | { kind: "error"; message: string }
  | { kind: "ready"; weddings: WeddingSummary[] };

/**
 * The boundary where a role off the wire becomes one the portal knows.
 *
 * `WeddingSummary.role` is a union asserted over parsed JSON, which makes it a
 * claim rather than a fact. Everything downstream decides what to offer from
 * this field, so a role the portal has never heard of is narrowed to the lowest
 * rank here instead of reaching `surfacesFor()` as an unhandled value.
 */
const withKnownRole = (wedding: WeddingSummary): WeddingSummary => ({
  ...wedding,
  role: normaliseWeddingRole(wedding.role),
});

function Loading(props: { label: string }) {
  return (
    <p class="font-body text-text-muted text-ui-base tracking-ui-wider animate-pulse uppercase">
      {props.label}
    </p>
  );
}

/**
 * Gate: session() is undefined while the SDK restores the session, null
 * when signed out, a Session when signed in.
 */
function RequireAuth(props: ParentProps) {
  const { session } = useAuth();

  createEffect(() => {
    if (session() === null) redirectToLogin();
  });

  return (
    <Show
      when={session()}
      fallback={
        // The signed-in tree owns the page measure (the top bar is full-bleed,
        // so `page-frame` moved inside it). This fallback renders instead of
        // that tree, so it carries its own frame or it sits against the edge.
        <div class="page-frame py-10">
          <Loading label="Checking session…" />
        </div>
      }
    >
      {props.children}
    </Show>
  );
}

/** The chosen wedding's dashboard — the module shell (left module rail +
 *  panel), scoped to whichever wedding the organiser opened. It has no header
 *  of its own: which wedding is open, the role badge and "preview invite" all
 *  live in the top bar now, so the first thing under the chrome is the work.
 *
 *  Access follows the caller's role, and `surfacesFor()` in `lib/wedding-roles`
 *  is what says so — this component asks it and never compares a role itself.
 *  A role with no dashboard surface at all gets {@link RunSheetSeat} instead of
 *  the shell: the API refuses its every read, so rendering the shell would be a
 *  rail of modules that each answer 403.
 *
 *  The active module + sub are fully controlled by the parent (URL-hash driven)
 *  so a deep link / hard refresh restores the exact view; the shell reports
 *  navigation back up via `onModule` / `onSub`. Getting-started (now the Overview
 *  empty-state) and the import both moved into their modules. */
function WeddingDashboard(props: {
  /** The wedding this dashboard belongs to, fixed for the dashboard's life.
   *  Views read it after an `await`, and by then the organiser may have moved
   *  to another wedding; a live read would point their writes at that one. */
  weddingId: string;
  wedding: WeddingSummary;
  /** Active module + sub as accessors so they stay reactive across hash changes
   *  even while the same wedding object stays selected. */
  module: () => Module;
  sub: () => string;
  onModule: (module: Module) => void;
  onSub: (sub: string) => void;
  /** A Settings save changed the name/slug — bubble it up so the wedding list
   *  (and the top bar's switcher) reflect it without a refetch. */
  onWeddingUpdated: (patch: { displayName: string; slug: string }) => void;
}) {
  // One decision, taken once, for every surface below. The API enforces all of
  // it — weddingMember()/weddingEditor()/weddingOwner() — and these flags only
  // keep the portal from offering what those gates would refuse.
  const surfaces = () => surfacesFor(props.wedding.role);

  return (
    <Show when={surfaces().canOpenDashboard} fallback={<RunSheetSeat />}>
      <WeddingCacheScope weddingId={props.weddingId}>
        <ModuleShell
          weddingId={props.weddingId}
          weddingName={props.wedding.displayName}
          weddingSlug={props.wedding.slug}
          canManage={surfaces().canManage}
          canEdit={surfaces().canEdit}
          module={props.module()}
          sub={props.sub()}
          onModule={props.onModule}
          onSub={props.onSub}
          onWeddingUpdated={props.onWeddingUpdated}
          entitlements={props.wedding.entitlements ?? []}
          guestCap={props.wedding.guestCap ?? 100}
        />
      </WeddingCacheScope>
    </Show>
  );
}

/**
 * Holds one wedding's cached rows for exactly as long as its dashboard is on
 * screen.
 *
 * The stores keep guest names, vendor contacts and budget figures in memory,
 * keyed by wedding. This scope opens the wedding's caches before any view
 * below it runs (children are read lazily, after this body) and drops them
 * when it unmounts — on a switch to another wedding, back to the list, to
 * Security, on a role that loses the dashboard, on the wedding leaving the
 * organiser's list, and on sign-out. Once dropped, the stores refuse writes
 * and loads for the wedding, so a request a torn-down view started cannot
 * bring its rows back.
 */
function WeddingCacheScope(props: ParentProps<{ weddingId: string }>) {
  // Read once: a scope belongs to one wedding for its whole life. The parent
  // is keyed on the wedding id, so another wedding gets another scope.
  const weddingId = untrack(() => props.weddingId);
  openWeddingCaches(weddingId);
  onCleanup(() => dropWeddingCaches(weddingId));
  return <>{props.children}</>;
}

/** What a seat with no dashboard surface opens onto.
 *
 *  A helper is handed a job on the day, not the wedding: the guest list, the
 *  budget, the registry and the replies are all refused for them upstream. The
 *  wedding is still listed for them — that is how they reach it at all — so
 *  this says what the seat covers rather than leaving them on a dashboard whose
 *  every panel errors. */
function RunSheetSeat() {
  return (
    <div class="border-border bg-surface/30 flex flex-col gap-2 rounded-sm border border-dashed p-8 text-center">
      <p class="font-display text-text text-ui-md font-light">{ROLE_COPY.helper.label} access</p>
      <p class="font-body text-text-muted text-ui-sm mx-auto max-w-prose leading-relaxed">
        {ROLE_COPY.helper.summary} Ask whoever runs this wedding if you need more.
      </p>
    </div>
  );
}

function initialRoute(): DashboardRoute {
  if (typeof window === "undefined") return LIST_ROUTE;
  return parseRoute(window.location.hash);
}

function Dashboard() {
  const auth = useAuth();
  const { authFetch, logout, session } = auth;
  // Locally-tracked weddings so a freshly-created one shows up without a
  // refetch. Seeded from the initial load.
  const [weddings, writeWeddings] = createSignal<WeddingSummary[] | null>(null);

  // Every local write to the list bumps `listVersion`, so a recheck that was
  // already in flight cannot overwrite it with an older answer (see
  // `recheckWeddings`). It also frees the recheck slot: a trigger arriving
  // after this write must send a new request, not join one whose answer is
  // about to be thrown away.
  let listVersion = 0;
  let recheck: { startedAt: number; done: Promise<void> } | null = null;
  let recheckSeq = 0;
  let lastRecheckedAt = Date.now();
  const setWeddings = ((value: Parameters<Setter<WeddingSummary[] | null>>[0]) => {
    listVersion += 1;
    recheck = null;
    return writeWeddings(value);
  }) as Setter<WeddingSummary[] | null>;

  /**
   * Ask the API again which weddings the organiser holds, and in what role.
   *
   * The API checks the role on every request, so the rows already on screen
   * are what goes stale: an organiser removed from a wedding, or narrowed to
   * a role without the dashboard, keeps reading them until something asks.
   * Applying the answer is enough to stop that — a wedding that left the
   * list drops the route back to the list, a role without the dashboard
   * swaps in its seat, and either way the wedding's cache scope unmounts and
   * drops its rows. A role that keeps the dashboard only changes what the
   * dashboard offers; its rows are still the organiser's to read.
   *
   * Runs on any 403 from a wedding route, and — at most once a minute — when
   * the tab comes back into view or the organiser moves within the
   * dashboard. Concurrent triggers share one request, except a refusal of a
   * request sent after that one started: its answer may predate the change
   * the refusal reports, so a new request is sent. An answer is thrown away
   * if the list was written locally while it was in flight (a created
   * wedding, a rename), and then asked for once more; an answer overtaken by
   * a newer request is thrown away too.
   *
   * `refusedAt` is when the refused request was sent, for a 403 trigger.
   */
  function recheckWeddings(refusedAt?: number, retry = true): Promise<void> {
    if (untrack(weddings) === null) return Promise.resolve();
    if (
      recheck &&
      Date.now() - recheck.startedAt < RECHECK_ABANDONED_AFTER_MS &&
      !(refusedAt !== undefined && refusedAt > recheck.startedAt)
    ) {
      return recheck.done;
    }
    recheckSeq += 1;
    const seq = recheckSeq;
    const version = listVersion;
    const done = (async () => {
      let answer: WeddingSummary[] | null = null;
      try {
        const res = await authFetch(apiUrl("/api/organiser/weddings"));
        // A failed check changes nothing: an empty or partial answer read as
        // "no weddings" would drop every scope.
        if (res.ok) {
          const body = (await res.json()) as { weddings?: unknown };
          if (Array.isArray(body.weddings)) answer = body.weddings as WeddingSummary[];
        }
      } catch (err) {
        if (isAuthExpired(err)) redirectToLogin();
      }
      // Overtaken by a newer check: that one owns the answer.
      if (seq !== recheckSeq) return;
      recheck = null;
      lastRecheckedAt = Date.now();
      if (answer === null) return;
      if (version === listVersion) {
        const next = answer.map(withKnownRole);
        // An unchanged answer is not written: a fresh array would wake every
        // reader of the list for nothing.
        if (JSON.stringify(next) !== JSON.stringify(untrack(weddings))) writeWeddings(next);
      } else if (retry) {
        await recheckWeddings(undefined, false);
      }
    })();
    recheck = { startedAt: Date.now(), done };
    return done;
  }

  /** Recheck unless the last check is under a minute old. */
  function recheckIfDue(): void {
    if (Date.now() - lastRecheckedAt >= RECHECK_AFTER_MS) void recheckWeddings();
  }

  onMount(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") recheckIfDue();
    };
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisibility));
  });

  // Everything below the dashboard fetches through this: the same `authFetch`,
  // plus a recheck of the list whenever the API refuses a wedding route.
  const watchedAuth = {
    ...auth,
    authFetch: watchForbidden(authFetch, (sentAt) => void recheckWeddings(sentAt)),
  };

  /**
   * One wedding's summary, read by id from the live list, keeping the last
   * one seen. A dashboard reads its own wedding through this rather than
   * through the selection, which moves on the moment the organiser does: a
   * view finishing a request after a switch still names its own wedding, and
   * never reads a selection that has since gone away.
   */
  function summaryFor(weddingId: string): () => WeddingSummary {
    let last = untrack(weddings)?.find((w) => w.id === weddingId);
    return () => {
      const found = weddings()?.find((w) => w.id === weddingId);
      if (found) last = found;
      return last!;
    };
  }

  // The single source of navigable state: top-level view + selected wedding +
  // active tab, mirrored into the URL hash so a hard refresh restores it and a
  // shared link reopens it. Seeded from the hash on first paint.
  const [route, setRouteSignal] = createSignal<DashboardRoute>(initialRoute());

  // The ⌘K palette is chrome-level state — it opens over whichever view is
  // showing. Two signals rather than one: `open` is what the dialog reads,
  // `summoned` latches on the first open and never clears, so the chunk is
  // fetched and mounted once instead of on every ⌘K.
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [paletteSummoned, setPaletteSummoned] = createSignal(false);

  function setPalette(open: boolean) {
    if (open) setPaletteSummoned(true);
    setPaletteOpen(open);
  }

  createCommandShortcut(() => setPalette(!paletteOpen()));

  // Warm the chunk while the browser is idle, so the first ⌘K opens on the
  // frame it is pressed rather than after a round trip. Idle, not eager: the
  // point of the split is to keep it off the path to first paint, and putting
  // it back on that path with a bare `import()` at mount would undo it.
  onMount(() => {
    const warm = () => void import("./CommandPalette");
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(warm, { timeout: 4000 });
      onCleanup(() => cancelIdleCallback(id));
    } else {
      const id = setTimeout(warm, 2000);
      onCleanup(() => clearTimeout(id));
    }
  });

  // Write the hash with replaceState by default (tab switches) so they don't
  // pile up history entries; explicit navigations (open a wedding, go back to
  // the list, switch view) push so Back/Forward walks them. Either way the URL
  // stays the source of truth and a manual edit or browser Back/Forward
  // re-syncs via the hashchange listener below.
  function setRoute(next: DashboardRoute, mode: "push" | "replace" = "replace") {
    // A mounted write surface with unsaved edits (the invite builder) gets to
    // veto in-app navigation — switching module/sub/view unmounts it and would
    // silently discard the draft. Browser Back/Forward bypasses this (see
    // lib/unsaved-guard); beforeunload covers tab close/reload.
    if (serializeRoute(next) !== serializeRoute(route()) && !confirmNavigation()) return;
    setRouteSignal(next);
    if (typeof window === "undefined") return;
    const hash = serializeRoute(next);
    if (window.location.hash === hash) return;
    const url = `${window.location.pathname}${window.location.search}${hash}`;
    if (mode === "push") history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }

  // Re-sync from the hash on browser Back/Forward and manual edits. The signal
  // is the source of truth for render; the listener just mirrors external hash
  // changes back into it (it never writes the hash, so no feedback loop).
  function onHashChange() {
    setRouteSignal(parseRoute(window.location.hash));
  }
  onMount(() => {
    window.addEventListener("hashchange", onHashChange);
    // Normalise a legacy / shorthand hash (e.g. `#security`, `#guests`, or "")
    // into the canonical `#/…` form without adding a history entry.
    const canonical = serializeRoute(parseRoute(window.location.hash));
    if (window.location.hash !== canonical) {
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${canonical}`,
      );
    }
  });
  onCleanup(() => {
    if (typeof window !== "undefined") window.removeEventListener("hashchange", onHashChange);
  });

  const view = () => route().view;

  // A module already loaded is served from its cache with no request, so a
  // tab in use can move between modules without the API being asked
  // anything. Every move is a moment to ask.
  createEffect(on(route, recheckIfDue, { defer: true }));

  function selectView(next: "weddings" | "security") {
    if (next === "security")
      setRoute(
        {
          view: "security",
          weddingId: null,
          module: DEFAULT_MODULE,
          sub: defaultSub(DEFAULT_MODULE),
        },
        "push",
      );
    else setRoute(LIST_ROUTE, "push");
  }

  function selectWedding(wedding: WeddingSummary) {
    setRoute(
      {
        view: "weddings",
        weddingId: wedding.id,
        module: DEFAULT_MODULE,
        sub: defaultSub(DEFAULT_MODULE),
      },
      "push",
    );
  }

  function backToList() {
    setRoute(LIST_ROUTE, "push");
  }

  /** Switch module — resets the sub to that module's default (push, so the
   *  module change is a Back-able history entry). */
  function selectModule(module: Module) {
    const r = route();
    if (r.view !== "weddings" || r.weddingId === null) return;
    setRoute({ view: "weddings", weddingId: r.weddingId, module, sub: defaultSub(module) }, "push");
  }

  /** Switch sub within the current module (replace — a sub flip shouldn't pile
   *  up history entries, matching the old tab behaviour). */
  function selectSub(sub: string) {
    const r = route();
    if (r.view !== "weddings" || r.weddingId === null) return;
    setRoute({ view: "weddings", weddingId: r.weddingId, module: r.module, sub }, "replace");
  }

  const [loaded] = createResource<WeddingsState>(async () => {
    try {
      const res = await authFetch(apiUrl("/api/organiser/weddings"));
      if (res.status === 401) {
        redirectToLogin();
        return { kind: "ready", weddings: [] };
      }
      if (!res.ok) return { kind: "error", message: `Could not load weddings (${res.status}).` };
      const body = (await res.json()) as { weddings: WeddingSummary[] };
      const loadedWeddings = body.weddings.map(withKnownRole);
      setWeddings(loadedWeddings);
      return { kind: "ready", weddings: loadedWeddings };
    } catch (err) {
      if (isAuthExpired(err)) {
        redirectToLogin();
        return { kind: "ready", weddings: [] };
      }
      return { kind: "error", message: "Could not load weddings. Is the API running?" };
    }
  });

  const loadError = () => {
    const state = loaded();
    return state?.kind === "error" ? state.message : null;
  };

  // The wedding named by the route, once the list has loaded. A deep link to a
  // wedding the organiser can't load (not owner/host, or gone) resolves to null;
  // the effect below then falls the route back to the list rather than hanging.
  const selected = () => {
    const r = route();
    if (r.view !== "weddings" || r.weddingId === null) return null;
    return weddings()?.find((w) => w.id === r.weddingId) ?? null;
  };

  // Graceful fallback: once the list is loaded, if the route names a wedding
  // that isn't in it, drop back to the list (replace — a dead link shouldn't
  // leave a Back-able entry).
  createEffect(() => {
    const r = route();
    if (r.view !== "weddings" || r.weddingId === null) return;
    const list = weddings();
    if (!list) return; // still loading — don't judge yet
    if (!list.some((w) => w.id === r.weddingId)) setRoute(LIST_ROUTE, "replace");
  });

  /** A Settings save renamed the selected wedding (or moved its slug) — patch
   *  the local list so the header, list, and invite-message copy stay current. */
  function handleWeddingUpdated(weddingId: string, patch: { displayName: string; slug: string }) {
    setWeddings((prev) => (prev ?? []).map((w) => (w.id === weddingId ? { ...w, ...patch } : w)));
  }

  /**
   * Back from Stripe.
   *
   * The entitlement is granted by the webhook, not by this page, so all this
   * does is ask what happened and refresh the list once it has. The params are
   * stripped the moment they are read: `setRoute` rebuilds the URL as
   * `pathname + search + hash` on every hash write and the login bounce carries
   * `search` through, so leaving them would re-run this on every later
   * navigation, refresh and bookmark.
   */
  onMount(() => {
    if (typeof window === "undefined") return;
    const receipt = readUpgradeReturn(window.location.search);
    if (!receipt) return;
    history.replaceState(null, "", clearUpgradeParams(new URL(window.location.href)));

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => {
      cancelled = true;
      // Clearing it, not just flagging it: the flag is only read after the
      // await, so an uncleared timer holds the dashboard's last sleep open for
      // up to its full backoff after teardown.
      if (pollTimer !== undefined) clearTimeout(pollTimer);
    });

    void (async () => {
      /* Sequential by design, and every `await` below is inside this loop on
         purpose: it is a poll with backoff, so running the attempts together
         would defeat both the backoff and the early exit the moment the
         purchase settles. `cancelled` is assigned in the `onCleanup` closure
         above, which the unmodified-loop-condition rule cannot follow. */
      // oxlint-disable no-await-in-loop, no-unmodified-loop-condition
      for (let attempt = 0; attempt < POLL_ATTEMPTS && !cancelled; attempt += 1) {
        let state: Awaited<ReturnType<typeof fetchPurchase>> = null;
        try {
          state = await fetchPurchase(authFetch, receipt.weddingId, receipt.purchaseId);
        } catch {
          // A failed poll is not a failed purchase. Keep asking; the loop is
          // bounded, so this cannot become a spin.
        }
        if (cancelled) return;

        if (state?.status === "succeeded") {
          // The entitlement now exists server-side; the list is what the nav
          // reads, so refetching it is what unlocks the module.
          invalidateCatalogue(receipt.weddingId);
          try {
            const res = await authFetch(apiUrl("/api/organiser/weddings"));
            if (res.ok) {
              const body = (await res.json()) as { weddings: WeddingSummary[] };
              if (!cancelled) setWeddings(body.weddings.map(withKnownRole));
            }
          } catch {
            // The purchase landed even if this refresh did not; a reload shows
            // it. Saying so beats a scary error about a payment that worked.
          }
          if (!cancelled) toast.success("Upgrade complete — the module is unlocked.");
          return;
        }
        if (state?.status === "failed" || state?.status === "expired") {
          if (!cancelled) toast.error("That payment did not go through. Nothing was charged.");
          return;
        }
        // No sleep after the final attempt — there is nothing left to wait
        // for, and sleeping there adds a full backoff to the one path where
        // the webhook is genuinely slow.
        if (attempt === POLL_ATTEMPTS - 1) break;
        await new Promise((resolve) => {
          pollTimer = setTimeout(resolve, pollDelayMs(attempt));
        });
      }
      // oxlint-enable no-await-in-loop, no-unmodified-loop-condition
      // Still pending after the last attempt. Not an error — Stripe is slow
      // sometimes — so the honest message says where it got to.
      if (!cancelled) {
        toast.info("Your payment is still being confirmed. This page will show it once it is.");
      }
    })();
  });

  function handleCreated(wedding: WeddingSummary) {
    setWeddings((prev) => [...(prev ?? []), wedding]);
    // Open the new wedding straight away — the organiser just made it to fill
    // it in.
    selectWedding(wedding);
  }

  async function signOut() {
    await logout();
    redirectToLogin();
  }

  /** What the top bar names when no wedding is open. With one open, the
   *  switcher names it instead and this is unused. */
  const sectionLabel = () => (view() === "security" ? "Security" : "All weddings");

  return (
    <AuthContext.Provider value={watchedAuth}>
      <TopBar
        session={session()}
        wedding={selected()}
        weddings={weddings() ?? []}
        sectionLabel={sectionLabel()}
        onWedding={selectWedding}
        onAll={backToList}
        onSecurity={() => selectView("security")}
        onSignOut={() => void signOut()}
        onOpenPalette={() => setPalette(true)}
      />

      {/* No Suspense fallback on purpose: the palette is an overlay, and a
          spinner where an overlay is about to be is worse than the overlay
          arriving a frame later. */}
      <Show when={paletteSummoned()}>
        <Suspense>
          <CommandPalette
            open={paletteOpen()}
            onOpenChange={setPalette}
            wedding={selected()}
            weddings={weddings() ?? []}
            onModule={selectModule}
            onWedding={selectWedding}
            onAll={backToList}
            onSecurity={() => selectView("security")}
            onSignOut={() => void signOut()}
          />
        </Suspense>
      </Show>

      {/* `@container/page` is the outermost query context for the views that sit
          outside the module shell (the wedding list, the create form). The main
          element carries the page measure: the bar above is full-bleed so its
          hairline runs edge to edge, while its contents share this gutter. */}
      <main class="page-frame @container/page flex flex-col gap-8 py-8 @2xl/frame:py-10">
        <Show when={view() === "security"}>
          <SecurityPanel />
        </Show>

        <Show when={view() === "weddings"}>
          <Show when={loaded()} fallback={<Loading label="Loading weddings…" />}>
            <Show when={loadError()}>
              {(message) => <Notice tone="danger">{message()}</Notice>}
            </Show>

            <Show when={!loadError() && weddings()}>
              {(list) => (
                <Show
                  when={selected()}
                  fallback={
                    <WeddingList
                      weddings={list()}
                      onSelect={(w) => selectWedding(w)}
                      onCreated={handleCreated}
                    />
                  }
                >
                  {(wedding) => (
                    // Keyed on the id: another wedding is another dashboard,
                    // mounted fresh, with its own cache scope. The key is the
                    // function's argument on purpose — Show only calls a
                    // children function that takes one, and an unused `()`
                    // would make `keyed` do nothing.
                    <Show when={wedding().id} keyed>
                      {(weddingId) => {
                        const summary = summaryFor(weddingId);
                        return (
                          <WeddingDashboard
                            weddingId={weddingId}
                            wedding={summary()}
                            module={() => {
                              const r = route();
                              return r.view === "weddings" ? r.module : DEFAULT_MODULE;
                            }}
                            sub={() => {
                              const r = route();
                              return r.view === "weddings" ? r.sub : defaultSub(DEFAULT_MODULE);
                            }}
                            onModule={selectModule}
                            onSub={selectSub}
                            onWeddingUpdated={(patch) => handleWeddingUpdated(weddingId, patch)}
                          />
                        );
                      }}
                    </Show>
                  )}
                </Show>
              )}
            </Show>
          </Show>
        </Show>
      </main>
    </AuthContext.Provider>
  );
}

/**
 * Single root island for the dashboard page. Astro pages cannot share a
 * SolidJS context across islands, so AuthProvider wraps everything here.
 */
export default function OrganiserApp() {
  // The inline boot script already put the right theme on `data-theme` before
  // first paint; this takes over from it, so a host who follows their system
  // theme sees the portal change with it rather than at the next reload.
  onMount(() => onCleanup(initTheme()));

  return (
    <AuthProvider config={{ apiBase: CIRE_API_URL }}>
      <RequireAuth>
        <Dashboard />
      </RequireAuth>
      {/* `topLayer` because this app's dialogs are `showModal()` dialogs
          (`@shared/ui`'s `Modal`), which paint in the top layer — above every
          stacking context, so no `z-index` on the toast container could reach
          over one. See `ToasterProps.topLayer`. */}
      <Toaster position="bottom-right" topLayer />
    </AuthProvider>
  );
}

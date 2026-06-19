import { useAuth } from "@osn/client/solid";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { isHeroEmpty, isStoryEmpty } from "../lib/invite-emptiness";

/** localStorage key for "this organiser dismissed the getting-started checklist
 *  for this wedding". Per-wedding so dismissing one wedding's guide leaves the
 *  others intact. */
function dismissKey(weddingId: string): string {
  return `cire:getting-started-dismissed:${weddingId}`;
}

function readDismissed(weddingId: string): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(dismissKey(weddingId)) === "1";
  } catch {
    // Private-mode / disabled storage — treat as not dismissed (fail visible).
    return false;
  }
}

function writeDismissed(weddingId: string, dismissed: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (dismissed) localStorage.setItem(dismissKey(weddingId), "1");
    else localStorage.removeItem(dismissKey(weddingId));
  } catch {
    // No-op if storage is unavailable; the in-memory signal still drives the UI
    // for this session.
  }
}

/**
 * The dashboard's "what do I do next" guide — a four-step checklist that reflects
 * the wedding's REAL state (events imported, guests imported, invite customised,
 * codes shared), so a first-time organiser is led through the flow in order and
 * an established one sees a quiet "all set" summary instead.
 *
 * Each step's `done` is derived from data the dashboard already serves; the panel
 * fetches its own snapshot once so it stays decoupled from the tab components.
 * Clicking a step jumps to the matching tab via the parent's `onJump` (which
 * updates the URL hash through the shared dashboard-route scheme) — no new
 * navigation model.
 *
 * The checklist can be dismissed (an X, top-right); the choice is persisted per
 * wedding in localStorage and a small "Show getting started" affordance brings
 * it back. The data-derived done-state logic is unchanged by dismissal.
 */

interface EventRow {
  id: string;
}

interface GuestRow {
  familyId: string;
  codeSharedAt: number | null;
}

interface InviteCustomisation {
  hero: { title: string | null; subtitle: string | null; imageUrl: string | null };
  story: { heading: string | null; body: string | null; imageUrl: string | null };
}

interface Snapshot {
  eventCount: number;
  familyCount: number;
  sharedFamilyCount: number;
  inviteCustomised: boolean;
}

interface Step {
  key: string;
  /** The tab hash this step links to. */
  tab: "events" | "guests" | "invite";
  label: string;
  /** What the step achieves, in plain terms — shown when not yet done. */
  todo: string;
  /** A reassuring one-liner once the step is complete. */
  done: string;
  complete: boolean;
}

export default function GettingStarted(props: {
  weddingId: string;
  onJump: (tab: string) => void;
}) {
  const { authFetch } = useAuth();

  // Dismissal is per-wedding and persisted in localStorage, so an organiser who
  // doesn't want the checklist can hide it and have it stay hidden across
  // reloads — with a small "Show getting started" affordance to bring it back.
  // Seeded from storage so a hard refresh respects a prior dismissal.
  const [dismissed, setDismissed] = createSignal(readDismissed(props.weddingId));

  function dismiss() {
    setDismissed(true);
    writeDismissed(props.weddingId, true);
  }
  function restore() {
    setDismissed(false);
    writeDismissed(props.weddingId, false);
  }

  const [snapshot] = createResource<Snapshot>(async () => {
    try {
      const base = `/api/organiser/weddings/${props.weddingId}`;
      const [eventsRes, guestsRes, inviteRes] = await Promise.all([
        authFetch(apiUrl(`${base}/events`)),
        authFetch(apiUrl(`${base}/guests`)),
        authFetch(apiUrl(`${base}/invite`)),
      ]);
      if (eventsRes.status === 401 || guestsRes.status === 401 || inviteRes.status === 401) {
        redirectToLogin();
        return { eventCount: 0, familyCount: 0, sharedFamilyCount: 0, inviteCustomised: false };
      }
      const events = eventsRes.ok ? ((await eventsRes.json()) as EventRow[]) : [];
      const guests = guestsRes.ok ? ((await guestsRes.json()) as GuestRow[]) : [];
      const invite = inviteRes.ok ? ((await inviteRes.json()) as InviteCustomisation) : null;

      // Guest rows repeat per family member — dedupe to families, and a family
      // counts as "sent" if any of its rows carries a codeSharedAt.
      const sharedByFamily = new Map<string, boolean>();
      for (const g of guests) {
        sharedByFamily.set(g.familyId, sharedByFamily.get(g.familyId) || g.codeSharedAt !== null);
      }

      // The invite counts as "customised" once either the hero or the Our Story
      // section would actually render for a guest (mirrors the builder's badges).
      const inviteCustomised = invite
        ? !isHeroEmpty(invite.hero) || !isStoryEmpty(invite.story)
        : false;

      return {
        eventCount: events.length,
        familyCount: sharedByFamily.size,
        sharedFamilyCount: Array.from(sharedByFamily.values()).filter(Boolean).length,
        inviteCustomised,
      };
    } catch (err) {
      if (isAuthExpired(err)) redirectToLogin();
      // Fail soft: a failed snapshot just hides the guide rather than blocking
      // the dashboard. The tabs below are still fully usable.
      return null as unknown as Snapshot;
    }
  });

  const steps = createMemo<Step[]>(() => {
    const s = snapshot();
    if (!s) return [];
    return [
      {
        key: "events",
        tab: "events",
        label: "Add your events",
        todo: "Import the events sheet so guests can see the ceremony, reception, and more.",
        done: `${s.eventCount} ${s.eventCount === 1 ? "event" : "events"} added.`,
        complete: s.eventCount > 0,
      },
      {
        key: "guests",
        tab: "guests",
        label: "Add your guests",
        todo: "Import the guests sheet to group households and assign who's invited to what.",
        done: `${s.familyCount} ${s.familyCount === 1 ? "household" : "households"} on the list.`,
        complete: s.familyCount > 0,
      },
      {
        key: "invite",
        tab: "invite",
        label: "Customise the invite",
        todo: "Add a hero photo, your story, and your colours — or keep the elegant default.",
        done: "Your personal touches are live.",
        complete: s.inviteCustomised,
      },
      {
        key: "share",
        tab: "guests",
        label: "Share the codes",
        todo: "Copy each household's invite message and send it however you like.",
        done: `${s.sharedFamilyCount} of ${s.familyCount} ${s.familyCount === 1 ? "household" : "households"} sent.`,
        complete: s.familyCount > 0 && s.sharedFamilyCount === s.familyCount,
      },
    ];
  });

  const completed = createMemo(() => steps().filter((s) => s.complete).length);
  const total = createMemo(() => steps().length);
  const allDone = createMemo(() => total() > 0 && completed() === total());
  // The first step that still needs doing — the one "next action" we nudge toward.
  const nextStep = createMemo(() => steps().find((s) => !s.complete));

  return (
    <Show when={snapshot()}>
      {/* Dismissed ⇒ collapse to a quiet "Show getting started" affordance the
          organiser can use to bring the checklist back. */}
      <Show when={dismissed()}>
        <div class="flex justify-end">
          <button
            type="button"
            onClick={restore}
            class="font-body text-text-muted hover:text-gold text-[0.74rem] tracking-[0.12em] uppercase underline-offset-4 transition hover:underline"
          >
            Show getting started
          </button>
        </div>
      </Show>

      <Show when={!dismissed()}>
        <section
          aria-label="Getting started"
          class="border-gold/25 from-surface/50 to-surface/20 relative flex flex-col gap-5 rounded-sm border bg-gradient-to-br p-6"
        >
          {/* Dismiss (X) — top-right, so an organiser who doesn't want the guide
            can hide it; the choice persists per wedding in localStorage. */}
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss getting started"
            title="Dismiss getting started"
            class="text-text-muted hover:text-gold hover:border-gold/50 border-border absolute top-3 right-3 flex h-7 w-7 items-center justify-center rounded-sm border border-transparent text-[0.9rem] leading-none transition-colors"
          >
            <span aria-hidden>✕</span>
          </button>

          <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pr-8">
            <div class="flex flex-col gap-1">
              <p class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">
                {allDone() ? "You're all set" : "Getting started"}
              </p>
              <h2 class="font-display text-text text-[1.4rem] font-light italic">
                {allDone() ? "Everything's ready for your guests" : "Four steps to your invite"}
              </h2>
              <Show when={!allDone() && nextStep()}>
                {(step) => (
                  <p class="font-body text-text-muted text-[0.82rem] leading-relaxed">
                    Next: <span class="text-text">{step().todo}</span>
                  </p>
                )}
              </Show>
            </div>
            <span
              class="font-body text-gold-dim shrink-0 text-[0.78rem] tracking-[0.12em] uppercase tabular-nums"
              aria-hidden
            >
              {completed()} / {total()} done
            </span>
          </div>

          {/* A thin progress rail — a single calm indicator of how far along the
            couple are. Pure CSS width transition, no library. */}
          <div
            class="bg-bg/60 h-1 w-full overflow-hidden rounded-full"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total()}
            aria-valuenow={completed()}
            aria-label="Setup progress"
          >
            <div
              class="bg-gold h-full rounded-full transition-[width] duration-500 ease-out"
              style={{ width: `${total() > 0 ? (completed() / total()) * 100 : 0}%` }}
            />
          </div>

          <ol class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <For each={steps()}>
              {(step, i) => (
                <li>
                  <button
                    type="button"
                    onClick={() => props.onJump(step.tab)}
                    data-complete={step.complete ? "true" : "false"}
                    class="group border-border bg-bg/30 hover:border-gold/60 flex w-full items-start gap-3 rounded-sm border p-3 text-left transition-colors"
                  >
                    <StepMarker n={i() + 1} complete={step.complete} />
                    <span class="flex flex-col gap-0.5">
                      <span
                        class="font-body text-[0.9rem]"
                        classList={{
                          "text-text": !step.complete,
                          "text-text-muted": step.complete,
                        }}
                      >
                        {step.label}
                      </span>
                      <span class="font-body text-text-muted text-[0.76rem] leading-snug">
                        {step.complete ? step.done : step.todo}
                      </span>
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ol>
        </section>
      </Show>
    </Show>
  );
}

/**
 * The numbered/checked marker leading each step. A gold check when done, a
 * hollow numbered ring while pending — so progress is legible at a glance.
 */
function StepMarker(props: { n: number; complete: boolean }) {
  return (
    <span
      aria-hidden
      class="font-body mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[0.78rem] transition-colors"
      classList={{
        "border-gold bg-gold text-bg": props.complete,
        "border-gold/40 text-gold-dim group-hover:border-gold/70": !props.complete,
      }}
    >
      {props.complete ? "✓" : props.n}
    </span>
  );
}

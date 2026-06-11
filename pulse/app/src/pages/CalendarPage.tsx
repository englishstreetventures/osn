import { useAuth } from "@osn/client/solid";
import { createMemo, createResource, createSignal, Show } from "solid-js";

import { CalendarTimeline } from "../calendar/CalendarTimeline";
import { fetchMyCalendar } from "../lib/calendar";

import "../calendar/calendar.css";

export function CalendarPage() {
  const { session } = useAuth();
  const accessToken = () => session()?.accessToken ?? null;

  // Bumped after a maybe-confirmation so the agenda refetches.
  const [refreshKey, setRefreshKey] = createSignal(0);
  const source = createMemo(() => {
    const token = accessToken();
    return token ? { token, key: refreshKey() } : null;
  });
  const [calendar, { refetch }] = createResource(source, ({ token }) => fetchMyCalendar(token));

  function handleChanged() {
    setRefreshKey((k) => k + 1);
    refetch();
  }

  return (
    <div class="mx-auto max-w-2xl px-6 pt-8 pb-24">
      <div
        class="text-muted-foreground mb-2 text-xs tracking-wider uppercase"
        style={{ "font-family": "var(--font-mono)" }}
      >
        Your calendar
      </div>
      <h1
        class="m-0 mb-6 font-normal"
        style={{
          "font-family": "var(--font-serif)",
          "font-size": "clamp(28px, 4vw, 42px)",
          "letter-spacing": "-0.025em",
        }}
      >
        What's coming up
      </h1>

      <Show
        when={accessToken()}
        fallback={
          <p class="text-muted-foreground py-16 text-center">
            Sign in to see the events you're going to.
          </p>
        }
      >
        <Show when={calendar.loading}>
          <p class="text-muted-foreground py-16 text-center">Loading your calendar…</p>
        </Show>

        <Show when={calendar.error}>
          <p class="text-destructive py-16 text-center">Couldn't load your calendar.</p>
        </Show>

        <Show when={!calendar.loading && !calendar.error}>
          <Show
            when={(calendar()?.length ?? 0) > 0}
            fallback={
              <div class="text-muted-foreground py-16 text-center">
                <div class="mb-1.5 text-[26px]" style={{ "font-family": "var(--font-serif)" }}>
                  Nothing on your calendar yet.
                </div>
                <div>RSVP to an event and it'll show up here.</div>
              </div>
            }
          >
            <CalendarTimeline
              entries={calendar()!}
              accessToken={accessToken()}
              onChanged={handleChanged}
            />
          </Show>
        </Show>
      </Show>
    </div>
  );
}

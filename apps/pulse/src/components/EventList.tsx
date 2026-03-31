import { createResource, createSignal, createMemo, For, Show } from "solid-js";
import { useAuth } from "@osn/client/solid";
import { api } from "../lib/api";
import type { EventItem } from "../lib/types";
import { REDIRECT_URI } from "../lib/auth";
import { EventCard } from "./EventCard";
import { CreateEventForm } from "./CreateEventForm";

async function fetchEvents(accessToken: string | null): Promise<EventItem[]> {
  const headers: Record<string, string> = {};
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const { data, error } = await api.events.get({ headers });
  if (error) throw error;
  return data!.events;
}

export function EventList() {
  const { session, login, logout } = useAuth();
  const accessToken = () => session()?.accessToken ?? null;
  const tokenSource = createMemo(() => ({ token: accessToken() }));
  const [events, { refetch }] = createResource(tokenSource, ({ token }) => fetchEvents(token));
  const [showForm, setShowForm] = createSignal(false);

  function handleDelete(id: string) {
    const headers: Record<string, string> = {};
    const token = accessToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    api
      .events({ id })
      .delete(undefined, { headers })
      .then(() => refetch())
      .catch((err) => console.error("Failed to delete event:", err));
  }

  function handleFormSuccess() {
    setShowForm(false);
    refetch();
  }

  return (
    <main class="max-w-xl mx-auto px-4 py-6">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-3xl font-bold text-foreground">Pulse</h1>
        <div class="flex gap-2">
          <Show when={!session()}>
            <button
              onClick={() => login(REDIRECT_URI())}
              class="rounded-md px-3 py-1.5 text-sm font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80"
            >
              Sign in with OSN
            </button>
          </Show>
          <Show when={session()}>
            <button
              onClick={() => setShowForm((v) => !v)}
              class="rounded-md px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {showForm() ? "Cancel" : "New Event"}
            </button>
            <button
              onClick={logout}
              class="rounded-md px-3 py-1.5 text-sm font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80"
            >
              Sign out
            </button>
          </Show>
        </div>
      </div>
      <Show when={showForm()}>
        <CreateEventForm
          accessToken={accessToken()}
          onSuccess={handleFormSuccess}
          onCancel={() => setShowForm(false)}
        />
      </Show>
      <Show when={events.loading}>
        <p class="text-center text-muted-foreground py-16">Loading events…</p>
      </Show>
      <Show when={events.error}>
        <p class="text-center text-destructive py-16">Failed to load events.</p>
      </Show>
      <Show when={!events.error && events()}>
        <Show when={events()!.length === 0}>
          <p class="text-center text-muted-foreground py-16">No upcoming events.</p>
        </Show>
        <div class="flex flex-col gap-4">
          <For each={events()}>
            {(event) => <EventCard event={event} onDelete={handleDelete} />}
          </For>
        </div>
      </Show>
    </main>
  );
}

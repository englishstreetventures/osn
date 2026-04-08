import { createResource, createSignal, createMemo, For, Show } from "solid-js";
import { useAuth } from "@osn/client/solid";
import { toast } from "solid-toast";
import { api } from "../lib/api";
import type { EventItem } from "../lib/types";
import { getUserIdFromToken, getDisplayNameFromToken } from "../lib/utils";
import { EventCard } from "./EventCard";
import { CreateEventForm } from "./CreateEventForm";
import { Register } from "@osn/ui/auth/Register";
import { SignIn } from "@osn/ui/auth/SignIn";
import { registrationClient, loginClient } from "../lib/authClients";

async function fetchEvents(accessToken: string | null): Promise<EventItem[]> {
  const headers: Record<string, string> = {};
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const { data, error } = await api.events.get({ headers });
  if (error) throw error;
  return data!.events;
}

export function EventList() {
  const { session, logout } = useAuth();
  const accessToken = () => session()?.accessToken ?? null;
  const authClaims = createMemo(() => {
    const token = accessToken();
    return { userId: getUserIdFromToken(token), displayName: getDisplayNameFromToken(token) };
  });
  const currentUserId = () => authClaims().userId;
  const tokenSource = createMemo(() => ({ token: accessToken() }));
  const [events, { refetch }] = createResource(tokenSource, ({ token }) => fetchEvents(token));
  const [showForm, setShowForm] = createSignal(false);
  const [showRegister, setShowRegister] = createSignal(false);
  const [showSignIn, setShowSignIn] = createSignal(false);
  const [deletingIds, setDeletingIds] = createSignal(new Set<string>());

  function handleDelete(id: string) {
    if (deletingIds().has(id)) return;
    const headers: Record<string, string> = {};
    const token = accessToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    setDeletingIds((prev) => new Set([...prev, id]));
    api
      .events({ id })
      .delete(undefined, { headers })
      .then(() => {
        toast.success("Event deleted");
        refetch();
      })
      .catch((err) => {
        if (import.meta.env.DEV) console.error("Failed to delete event:", err);
        toast.error("Failed to delete event");
      })
      .finally(() => {
        setDeletingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      });
  }

  function handleFormSuccess() {
    toast.success("Event created");
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
              onClick={() => setShowRegister(true)}
              class="rounded-md px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Create account
            </button>
            <button
              onClick={() => setShowSignIn(true)}
              class="rounded-md px-3 py-1.5 text-sm font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80"
            >
              Sign in
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
      <Show when={showRegister() && !session()}>
        <Register client={registrationClient} onCancel={() => setShowRegister(false)} />
      </Show>
      <Show when={showSignIn() && !session()}>
        <SignIn
          client={loginClient}
          onCancel={() => setShowSignIn(false)}
          onSuccess={() => setShowSignIn(false)}
        />
      </Show>
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
            {(event) => (
              <EventCard
                event={event}
                onDelete={handleDelete}
                deleting={deletingIds().has(event.id)}
                currentUserId={currentUserId()}
              />
            )}
          </For>
        </div>
      </Show>
    </main>
  );
}

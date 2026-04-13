import { useAuth } from "@osn/client/solid";
import { Register } from "@osn/ui/auth/Register";
import { SignIn } from "@osn/ui/auth/SignIn";
import { A } from "@solidjs/router";
import { createResource, createSignal, createMemo, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { api } from "../lib/api";
import { registrationClient, loginClient } from "../lib/authClients";
import type { EventItem } from "../lib/types";
import { getProfileIdFromToken, getDisplayNameFromToken } from "../lib/utils";
import { CreateEventForm } from "./CreateEventForm";
import { EventCard } from "./EventCard";

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
    return { profileId: getProfileIdFromToken(token), displayName: getDisplayNameFromToken(token) };
  });
  const currentProfileId = () => authClaims().profileId;
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
        return undefined;
      })
      .catch((err) => {
        // eslint-disable-next-line no-console -- DEV-only client-side debug logging
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
    <main class="mx-auto max-w-xl px-4 py-6">
      <div class="mb-6 flex items-center justify-between">
        <h1 class="text-foreground text-3xl font-bold">Pulse</h1>
        <div class="flex gap-2">
          <Show when={!session()}>
            <button
              onClick={() => setShowRegister(true)}
              class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-sm font-medium"
            >
              Create account
            </button>
            <button
              onClick={() => setShowSignIn(true)}
              class="bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded-md px-3 py-1.5 text-sm font-medium"
            >
              Sign in
            </button>
          </Show>
          <Show when={session()}>
            <button
              onClick={() => setShowForm((v) => !v)}
              class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-sm font-medium"
            >
              {showForm() ? "Cancel" : "New Event"}
            </button>
            <A
              href="/settings"
              class="bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded-md px-3 py-1.5 text-sm font-medium"
            >
              Settings
            </A>
            <button
              onClick={logout}
              class="bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded-md px-3 py-1.5 text-sm font-medium"
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
        <p class="text-muted-foreground py-16 text-center">Loading events…</p>
      </Show>
      <Show when={events.error}>
        <p class="text-destructive py-16 text-center">Failed to load events.</p>
      </Show>
      <Show when={!events.error && events()}>
        <Show when={events()!.length === 0}>
          <p class="text-muted-foreground py-16 text-center">No upcoming events.</p>
        </Show>
        <div class="flex flex-col gap-4">
          <For each={events()}>
            {(event) => (
              <EventCard
                event={event}
                onDelete={handleDelete}
                deleting={deletingIds().has(event.id)}
                currentProfileId={currentProfileId()}
              />
            )}
          </For>
        </div>
      </Show>
    </main>
  );
}

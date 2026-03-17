import { createResource, createSignal, createMemo, For, Show, onMount } from "solid-js";
import { api } from "./lib/api";
import { formatTime, toDatetimeLocal, isEndBeforeOrAtStart } from "./lib/utils";
import { LocationInput } from "./lib/LocationInput";
import { AuthProvider, useAuth } from "@osn/client/solid";
import "./App.css";

const OSN_ISSUER_URL = import.meta.env.VITE_OSN_ISSUER_URL ?? "http://localhost:4000";
const OSN_CLIENT_ID = import.meta.env.VITE_OSN_CLIENT_ID ?? "pulse";
const REDIRECT_URI = import.meta.env.VITE_REDIRECT_URI ?? `${window.location.origin}/callback`;

type EventsResponse = Awaited<ReturnType<typeof api.events.get>>;
type EventItem = NonNullable<NonNullable<EventsResponse["data"]>["events"]>[number];

async function fetchEvents(accessToken: string | null): Promise<EventItem[]> {
  const headers: Record<string, string> = {};
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const { data, error } = await api.events.get({ headers });
  if (error) throw error;
  return data!.events;
}

function CreateEventForm(props: {
  accessToken: string | null;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = createSignal("");
  const [startTime, setStartTime] = createSignal(toDatetimeLocal(new Date()));
  const [endTime, setEndTime] = createSignal("");
  const [location, setLocation] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const endTimeError = createMemo(() =>
    isEndBeforeOrAtStart(startTime(), endTime()) ? "End time must be after start time" : "",
  );

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (endTimeError()) return;
    setSubmitting(true);
    try {
      const headers: Record<string, string> = {};
      if (props.accessToken) headers["Authorization"] = `Bearer ${props.accessToken}`;
      const { error } = await api.events.post(
        {
          title: title(),
          startTime: new Date(startTime()) as unknown as string,
          endTime: endTime() ? (new Date(endTime()) as unknown as string) : undefined,
          location: location() || undefined,
          description: description() || undefined,
        },
        { headers },
      );
      if (error) throw error;
      props.onSuccess();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      class="rounded-xl border border-border bg-card p-4 flex flex-col gap-3 mb-4"
    >
      <div class="flex flex-col gap-1">
        <label class="text-sm font-medium text-foreground" for="title">
          Title
        </label>
        <input
          id="title"
          type="text"
          required
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          class="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div class="flex gap-3">
        <div class="flex flex-col gap-1 flex-1">
          <label class="text-sm font-medium text-foreground" for="startTime">
            Start time
          </label>
          <input
            id="startTime"
            type="datetime-local"
            required
            value={startTime()}
            onInput={(e) => setStartTime(e.currentTarget.value)}
            class="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div class="flex flex-col gap-1 flex-1">
          <label class="text-sm font-medium text-foreground" for="endTime">
            End time
          </label>
          <input
            id="endTime"
            type="datetime-local"
            min={startTime()}
            value={endTime()}
            onInput={(e) => setEndTime(e.currentTarget.value)}
            class={`rounded-md border px-3 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring bg-background ${endTimeError() ? "border-destructive" : "border-input"}`}
          />
          <Show when={endTimeError()}>
            {(err) => <p class="text-xs text-destructive">{err()}</p>}
          </Show>
        </div>
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-sm font-medium text-foreground" for="location">
          Location
        </label>
        <LocationInput value={location()} onValue={setLocation} />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-sm font-medium text-foreground" for="description">
          Description
        </label>
        <textarea
          id="description"
          rows={3}
          value={description()}
          onInput={(e) => setDescription(e.currentTarget.value)}
          class="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring resize-none"
        />
      </div>
      <div class="flex gap-2 justify-end">
        <button
          type="button"
          onClick={props.onCancel}
          class="rounded-md px-3 py-1.5 text-sm font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting()}
          class="rounded-md px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting() ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}

function EventCard(props: { event: EventItem; onDelete: (id: string) => void }) {
  const e = props.event;
  return (
    <div class="rounded-xl border border-border bg-card overflow-hidden">
      <Show when={e.imageUrl}>
        <img class="w-full h-44 object-cover" src={e.imageUrl!} alt={e.title} />
      </Show>
      <div class="p-4">
        <div class="flex items-center gap-2 mb-2">
          <Show when={e.category}>
            <span class="text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {e.category}
            </span>
          </Show>
          <span
            class={`text-xs ${e.status === "ongoing" ? "text-green-600 font-semibold" : e.status === "cancelled" ? "text-destructive" : "text-muted-foreground"}`}
          >
            {e.status}
          </span>
        </div>
        <h2 class="text-base font-semibold text-foreground mb-1">{e.title}</h2>
        <Show when={e.description}>
          <p class="text-sm text-muted-foreground line-clamp-2 mb-3">{e.description}</p>
        </Show>
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <Show when={e.venue}>
            <span>{e.venue}</span>
          </Show>
          <Show when={e.location}>
            <span>{e.location}</span>
          </Show>
          <span>{formatTime(e.startTime)}</span>
        </div>
        <div class="mt-3 flex justify-end">
          <button
            onClick={() => {
              if (confirm(`Delete "${e.title}"?`)) props.onDelete(e.id);
            }}
            class="text-xs text-destructive hover:text-destructive/80"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function EventList() {
  const { session, login, logout } = useAuth();
  const accessToken = () => session()?.accessToken ?? null;
  const [events, { refetch }] = createResource(
    () => ({ token: accessToken() }),
    ({ token }) => fetchEvents(token),
  );
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
              onClick={() => login(REDIRECT_URI)}
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
      <Show when={events()}>
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

function CallbackHandler() {
  const { handleCallback } = useAuth();

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");

    if (code && state) {
      handleCallback({ code, state, redirectUri: REDIRECT_URI }).then(() => {
        window.history.replaceState({}, "", window.location.pathname);
      });
    }
  });

  return null;
}

export default function App() {
  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL, clientId: OSN_CLIENT_ID }}>
      <CallbackHandler />
      <EventList />
    </AuthProvider>
  );
}

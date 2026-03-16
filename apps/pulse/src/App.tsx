import {
  createResource,
  createSignal,
  createMemo,
  createEffect,
  onCleanup,
  For,
  Show,
} from "solid-js";
import { api } from "./lib/api";
import { formatTime, toDatetimeLocal, composeLabel, type PhotonFeature } from "./lib/utils";
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

function LocationInput(props: { value: string; onValue: (v: string) => void }) {
  const [query, setQuery] = createSignal(props.value);
  const [suggestions, setSuggestions] = createSignal<PhotonFeature[]>([]);
  const [open, setOpen] = createSignal(false);
  let selecting = false;

  createEffect(() => {
    const q = query();
    if (q.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&lang=en`,
          { signal: controller.signal },
        );
        const json = (await res.json()) as { features: PhotonFeature[] };
        setSuggestions(json.features ?? []);
        setOpen(json.features.length > 0);
      } catch (err) {
        if (!(err instanceof Error && err.name === "AbortError")) {
          // ignore non-abort fetch errors silently
        }
      }
    }, 300);
    onCleanup(() => {
      clearTimeout(timer);
      controller.abort();
    });
  });

  function select(feature: PhotonFeature) {
    const label = composeLabel(feature.properties);
    setQuery(label);
    props.onValue(label);
    setSuggestions([]);
    setOpen(false);
  }

  function handleInput(e: InputEvent & { currentTarget: HTMLInputElement }) {
    const v = e.currentTarget.value;
    setQuery(v);
    props.onValue(v);
  }

  function handleBlur() {
    if (selecting) return;
    setOpen(false);
  }

  return (
    <div class="relative">
      <input
        id="location"
        type="text"
        value={query()}
        onInput={handleInput}
        onBlur={handleBlur}
        onFocus={() => suggestions().length > 0 && setOpen(true)}
        class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
      />
      <Show when={open() && suggestions().length > 0}>
        <ul class="absolute z-10 mt-1 w-full rounded-md border border-border bg-card shadow-lg">
          <For each={suggestions()}>
            {(feature) => (
              <li
                class="px-3 py-2 text-sm text-foreground cursor-pointer hover:bg-muted"
                onMouseDown={() => {
                  selecting = true;
                  select(feature);
                }}
                onMouseUp={() => {
                  selecting = false;
                }}
              >
                {composeLabel(feature.properties)}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
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
    endTime() && endTime() <= startTime() ? "End time must be after start time" : "",
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
  const [events, { refetch }] = createResource(accessToken, fetchEvents);
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

export default function App() {
  return (
    <AuthProvider config={{ issuerUrl: OSN_ISSUER_URL, clientId: OSN_CLIENT_ID }}>
      <EventList />
    </AuthProvider>
  );
}

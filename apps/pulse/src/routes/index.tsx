import { createResource, For, Show } from "solid-js";

type Event = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  venue: string | null;
  category: string | null;
  startTime: string;
  endTime: string | null;
  status: "upcoming" | "ongoing" | "finished" | "cancelled";
  imageUrl: string | null;
};

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

async function fetchEvents(): Promise<Event[]> {
  const res = await fetch(`${API_URL}/events`);
  const data = await res.json();
  return data.events;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function EventCard(props: { event: Event }) {
  const e = props.event;
  return (
    <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
      <Show when={e.imageUrl}>
        <img class="w-full h-44 object-cover" src={e.imageUrl!} alt={e.title} />
      </Show>
      <div class="p-4">
        <div class="flex items-center gap-2 mb-2">
          <Show when={e.category}>
            <span class="text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
              {e.category}
            </span>
          </Show>
          <span
            class={`text-xs ${e.status === "ongoing" ? "text-green-600 font-semibold" : e.status === "cancelled" ? "text-red-500" : "text-gray-400"}`}
          >
            {e.status}
          </span>
        </div>
        <h2 class="text-base font-semibold text-gray-900 dark:text-white mb-1">{e.title}</h2>
        <Show when={e.description}>
          <p class="text-sm text-gray-500 dark:text-gray-400 line-clamp-2 mb-3">{e.description}</p>
        </Show>
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400 dark:text-gray-500">
          <Show when={e.venue}>
            <span>{e.venue}</span>
          </Show>
          <Show when={e.location}>
            <span>{e.location}</span>
          </Show>
          <span>{formatTime(e.startTime)}</span>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [events] = createResource(fetchEvents);

  return (
    <main class="max-w-xl mx-auto px-4 py-6">
      <h1 class="text-3xl font-bold mb-6 text-gray-900 dark:text-white">Pulse</h1>
      <Show when={events.loading}>
        <p class="text-center text-gray-400 py-16">Loading events…</p>
      </Show>
      <Show when={events.error}>
        <p class="text-center text-red-500 py-16">Failed to load events.</p>
      </Show>
      <Show when={events()}>
        <Show when={events()!.length === 0}>
          <p class="text-center text-gray-400 py-16">No upcoming events.</p>
        </Show>
        <div class="flex flex-col gap-4">
          <For each={events()}>{(event) => <EventCard event={event} />}</For>
        </div>
      </Show>
    </main>
  );
}

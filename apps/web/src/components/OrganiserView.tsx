import { createSignal, onMount, Show, For } from "solid-js"

interface GuestWithEvents {
  name: string
  code: string
  claimed: boolean
  events: string[]
}

const ALL_EVENTS = ["mehndi", "wedding", "reception"] as const
const EVENT_LABELS: Record<string, string> = {
  mehndi: "Mehndi",
  wedding: "Wedding",
  reception: "Reception",
}

interface OrganiserViewProps {
  apiUrl: string
}

export default function OrganiserView(props: OrganiserViewProps) {
  const [guests, setGuests] = createSignal<GuestWithEvents[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  onMount(async () => {
    try {
      const res = await fetch(`${props.apiUrl}/api/organiser/guests`)
      if (!res.ok) throw new Error("Failed to load")
      const data = (await res.json()) as GuestWithEvents[]
      setGuests(data)
    } catch {
      setError("Could not load guest list. Is the API running?")
    } finally {
      setLoading(false)
    }
  })

  return (
    <div class="flex flex-col gap-8">
      <header class="flex flex-col gap-2">
        <p class="font-body text-[0.72rem] uppercase tracking-[0.2em] text-gold">
          Organiser Dashboard
        </p>
        <h1 class="font-display text-[clamp(2rem,5vw,3.5rem)] font-light italic leading-[1.1] text-text">
          Guest List
        </h1>
      </header>

      <Show when={loading()}>
        <div class="flex flex-col gap-3">
          <For each={[1, 2, 3, 4]}>
            {() => <div class="h-[52px] animate-pulse rounded-sm bg-surface" />}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <p class="rounded-sm border border-error/20 bg-error/5 p-4 text-[0.88rem] text-error">
          {error()}
        </p>
      </Show>

      <Show when={!loading() && !error()}>
        <div class="overflow-x-auto">
          <table class="w-full border-collapse font-body text-[0.88rem]">
            <thead>
              <tr>
                <th class="whitespace-nowrap border-b border-border px-4 py-3 text-left text-[0.72rem] font-normal uppercase tracking-[0.1em] text-gold">
                  Guest
                </th>
                <th class="whitespace-nowrap border-b border-border px-4 py-3 text-left text-[0.72rem] font-normal uppercase tracking-[0.1em] text-gold">
                  Code
                </th>
                <For each={ALL_EVENTS}>
                  {(eventId) => (
                    <th class="whitespace-nowrap border-b border-border px-4 py-3 text-left text-[0.72rem] font-normal uppercase tracking-[0.1em] text-gold">
                      {EVENT_LABELS[eventId]}
                    </th>
                  )}
                </For>
                <th class="whitespace-nowrap border-b border-border px-4 py-3 text-left text-[0.72rem] font-normal uppercase tracking-[0.1em] text-gold">
                  Claimed
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={guests()}>
                {(guest) => (
                  <tr class="hover:[&>td]:bg-surface">
                    <td class="border-b border-border p-4 align-middle font-normal text-text">
                      {guest.name}
                    </td>
                    <td class="border-b border-border p-4 align-middle font-mono text-[0.82rem] tracking-[0.06em] text-text-muted">
                      {guest.code}
                    </td>
                    <For each={ALL_EVENTS}>
                      {(eventId) => (
                        <td class="border-b border-border p-4 align-middle text-center">
                          {guest.events.includes(eventId) ? (
                            <span class="inline-block rounded-sm px-2 py-0.5 text-[0.8rem] text-success">
                              ✓
                            </span>
                          ) : (
                            <span class="inline-block rounded-sm px-2 py-0.5 text-[0.8rem] text-text-muted">
                              —
                            </span>
                          )}
                        </td>
                      )}
                    </For>
                    <td class="border-b border-border p-4 align-middle text-center">
                      {guest.claimed ? (
                        <span class="inline-block rounded-sm bg-success/15 px-2 py-0.5 text-[0.72rem] uppercase tracking-[0.06em] text-success">
                          Claimed
                        </span>
                      ) : (
                        <span class="inline-block rounded-sm px-2 py-0.5 text-[0.8rem] text-text-muted">
                          —
                        </span>
                      )}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  )
}

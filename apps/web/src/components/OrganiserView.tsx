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
    <div class="organiser">
      <header class="organiser-header">
        <p class="organiser-eyebrow">Organiser Dashboard</p>
        <h1 class="organiser-title">Guest List</h1>
      </header>

      <Show when={loading()}>
        <div class="organiser-skeleton">
          <For each={[1, 2, 3, 4]}>{() => <div class="skeleton-row" />}</For>
        </div>
      </Show>

      <Show when={error()}>
        <p class="organiser-error">{error()}</p>
      </Show>

      <Show when={!loading() && !error()}>
        <div class="table-wrapper">
          <table class="guest-table">
            <thead>
              <tr>
                <th>Guest</th>
                <th>Code</th>
                <For each={ALL_EVENTS}>
                  {(eventId) => <th>{EVENT_LABELS[eventId]}</th>}
                </For>
                <th>Claimed</th>
              </tr>
            </thead>
            <tbody>
              <For each={guests()}>
                {(guest) => (
                  <tr>
                    <td class="guest-name">{guest.name}</td>
                    <td class="guest-code">{guest.code}</td>
                    <For each={ALL_EVENTS}>
                      {(eventId) => (
                        <td class="event-cell">
                          {guest.events.includes(eventId) ? (
                            <span class="badge badge--yes">✓</span>
                          ) : (
                            <span class="badge badge--no">—</span>
                          )}
                        </td>
                      )}
                    </For>
                    <td class="event-cell">
                      {guest.claimed ? (
                        <span class="badge badge--claimed">Claimed</span>
                      ) : (
                        <span class="badge badge--no">—</span>
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

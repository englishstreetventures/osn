import { createSignal, Show, For } from "solid-js"
import { Motion } from "@motionone/solid"
import { WaxSeal } from "./WaxSeal"
import {
  claimBoxEntrance,
  inviteEntrance,
  transitionBase,
  transitionStagger,
} from "./ClaimFlow.motion"
import "./ClaimFlow.css"

interface EventSummary {
  id: string
  name: string
  date: string
  location: string
  description: string
}

interface ClaimResult {
  guestName: string
  events: EventSummary[]
}

interface ClaimFlowProps {
  apiUrl: string
}

function formatDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`)
  return date.toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

export default function ClaimFlow(props: ClaimFlowProps) {
  const [code, setCode] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [result, setResult] = createSignal<ClaimResult | null>(null)

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const res = await fetch(`${props.apiUrl}/api/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code() }),
      })

      if (res.status === 401) {
        setError(
          "That code doesn't look right. Check your invitation and try again.",
        )
        setLoading(false)
        return
      }

      if (!res.ok) {
        setError("Something went wrong. Please try again.")
        setLoading(false)
        return
      }

      const data = (await res.json()) as ClaimResult

      if ("startViewTransition" in document) {
        document.startViewTransition(() => setResult(data))
      } else {
        setResult(data)
      }
    } catch {
      setError("Could not connect. Please check your connection.")
      setLoading(false)
    }
  }

  return (
    <Show
      when={result()}
      fallback={
        <div class="claim-wrapper">
          <WaxSeal class="claim-seal" size={200} />
          <div
            class="claim-card"
            style={{ "view-transition-name": "claim-box" }}
          >
            <Motion.div animate={claimBoxEntrance} transition={transitionBase}>
              <p class="eyebrow">An Invitation</p>
              <h1 class="display-heading">You're Invited</h1>
              <p class="subtext">
                Enter the code from your invitation to open it.
              </p>
              <form onSubmit={handleSubmit}>
                <input
                  type="text"
                  placeholder="e.g. DEV-JOY-RK97"
                  value={code()}
                  onInput={(e) => setCode(e.currentTarget.value)}
                  autocapitalize="characters"
                  autocorrect="off"
                  spellcheck={false}
                  disabled={loading()}
                />
                <Show when={error()}>
                  <p class="error" role="alert">
                    {error()}
                  </p>
                </Show>
                <button type="submit" disabled={loading() || !code().trim()}>
                  {loading() ? "Checking…" : "Open Invitation"}
                </button>
              </form>
            </Motion.div>
          </div>
        </div>
      }
    >
      {(data) => (
        <div class="invite-layout">
          <aside
            class="claim-card claim-card--corner"
            style={{ "view-transition-name": "claim-box" }}
          >
            <p class="eyebrow">Welcome</p>
            <h2 class="display-heading">{data().guestName}</h2>
          </aside>

          <div class="invite-body">
            <Motion.p
              class="invite-intro"
              animate={inviteEntrance}
              transition={transitionBase}
            >
              We are delighted to invite you to celebrate with us.
            </Motion.p>
            <div class="event-list">
              <For each={data().events}>
                {(event, i) => (
                  <Motion.article
                    class="event-card"
                    animate={inviteEntrance}
                    transition={transitionStagger(i())}
                  >
                    <h3 class="event-name">{event.name}</h3>
                    <p class="event-date">{formatDate(event.date)}</p>
                    <p class="event-location">{event.location}</p>
                    <p class="event-desc">{event.description}</p>
                  </Motion.article>
                )}
              </For>
            </div>
          </div>
        </div>
      )}
    </Show>
  )
}

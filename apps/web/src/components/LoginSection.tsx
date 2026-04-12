import { createSignal, Show } from "solid-js"
import type { ClaimResult } from "./types"
import { isValidClaimResponse } from "./utils"

interface LoginSectionProps {
  apiUrl: string
  result: ClaimResult | null
  onClaimed: (result: ClaimResult) => void
}

export function LoginSection(props: LoginSectionProps) {
  const [code, setCode] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

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

      const data: unknown = await res.json()
      if (!isValidClaimResponse(data)) {
        setError("Something went wrong. Please try again.")
        setLoading(false)
        return
      }
      props.onClaimed(data)
    } catch {
      setError("Could not connect. Please check your connection.")
      setLoading(false)
    }
  }

  return (
    <section class="section login-section">
      <div class="section-inner">
        <Show
          when={!props.result}
          fallback={
            <div class="login-welcome">
              <p class="section-eyebrow">Welcome</p>
              <h2 class="section-heading">{props.result!.guestName}</h2>
              <p class="login-subtitle">
                We are delighted to invite you to celebrate with us.
              </p>
            </div>
          }
        >
          <p class="section-eyebrow">Your Invitation</p>
          <h2 class="section-heading">Enter Your Code</h2>
          <p class="login-subtitle">
            Enter the code from your invitation to see your events.
          </p>
          <form class="login-form" onSubmit={handleSubmit}>
            <input
              type="text"
              placeholder="e.g. DEV-JOY-RK97"
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
              autocapitalize="characters"
              autocorrect="off"
              spellcheck={false}
              disabled={loading()}
              maxLength={20}
              pattern="[A-Za-z0-9\\-]+"
            />
            <Show when={error()}>
              <p class="login-error" role="alert">
                {error()}
              </p>
            </Show>
            <button type="submit" disabled={loading() || !code().trim()}>
              {loading() ? "Checking\u2026" : "Open Invitation"}
            </button>
          </form>
        </Show>
      </div>
    </section>
  )
}

import { useAuth } from "@osn/client/solid";
import { A } from "@solidjs/router";
import { createSignal, Show } from "solid-js";
import { toast } from "solid-toast";

import { updateMySettings } from "../lib/rsvps";

type Visibility = "connections" | "no_one";

const OPTIONS: { value: Visibility; label: string; description: string }[] = [
  {
    value: "connections",
    label: "My connections",
    description: "People you're connected to on OSN can see events you're attending.",
  },
  {
    value: "no_one",
    label: "No one",
    description: "Your attendance is hidden from everyone on Pulse.",
  },
];

export function SettingsPage() {
  const { session } = useAuth();
  const accessToken = () => session()?.accessToken ?? null;

  const [selected, setSelected] = createSignal<Visibility>("connections");
  const [saving, setSaving] = createSignal(false);

  async function save() {
    const token = accessToken();
    if (!token) {
      toast.error("Sign in to change settings");
      return;
    }
    setSaving(true);
    try {
      const res = await updateMySettings({ attendanceVisibility: selected() }, token);
      if (!res.ok) {
        toast.error(res.error ?? "Failed to save settings");
        return;
      }
      toast.success("Settings saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main class="mx-auto max-w-xl px-4 py-6">
      <div class="mb-4">
        <A href="/" class="text-primary text-sm hover:underline">
          ← Back to events
        </A>
      </div>
      <h1 class="text-foreground mb-2 text-2xl font-bold">Pulse settings</h1>
      <p class="text-muted-foreground mb-6 text-sm">
        Settings specific to Pulse. OSN identity settings (name, handle, email) live in your OSN
        profile.
      </p>

      <Show
        when={session()}
        fallback={<p class="text-muted-foreground text-sm">Sign in to change your settings.</p>}
      >
        <section class="border-border bg-card flex flex-col gap-3 rounded-xl border p-4">
          <h2 class="text-foreground text-base font-semibold">
            Who can see events you're attending?
          </h2>
          <p class="text-muted-foreground text-xs">
            Note: if an event has a public guest list, attending it opts you in regardless of this
            setting. Choose your event visibility carefully when RSVPing.
          </p>
          <div class="mt-2 flex flex-col gap-2">
            {OPTIONS.map((opt) => (
              <label class="flex cursor-pointer items-start gap-2" aria-label={opt.label}>
                <input
                  type="radio"
                  name="attendanceVisibility"
                  value={opt.value}
                  checked={selected() === opt.value}
                  onChange={() => setSelected(opt.value)}
                  class="mt-1"
                />
                <span>
                  <span class="text-foreground text-sm font-medium">{opt.label}</span>
                  <span class="text-muted-foreground block text-xs">{opt.description}</span>
                </span>
              </label>
            ))}
          </div>
          <div class="mt-2 flex justify-end">
            <button
              type="button"
              disabled={saving()}
              onClick={save}
              class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {saving() ? "Saving…" : "Save"}
            </button>
          </div>
        </section>
      </Show>
    </main>
  );
}

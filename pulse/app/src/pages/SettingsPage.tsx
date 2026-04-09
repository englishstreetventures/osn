import { A } from "@solidjs/router";
import { createSignal, Show } from "solid-js";
import { toast } from "solid-toast";
import { useAuth } from "@osn/client/solid";
import { updateMySettings } from "../lib/rsvps";

type Visibility = "connections" | "close_friends" | "no_one";

const OPTIONS: { value: Visibility; label: string; description: string }[] = [
  {
    value: "connections",
    label: "My connections",
    description: "People you're connected to on OSN can see events you're attending.",
  },
  {
    value: "close_friends",
    label: "Close friends only",
    description: "Only people on your OSN close-friends list can see events you're attending.",
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
    <main class="max-w-xl mx-auto px-4 py-6">
      <div class="mb-4">
        <A href="/" class="text-sm text-primary hover:underline">
          ← Back to events
        </A>
      </div>
      <h1 class="text-2xl font-bold text-foreground mb-2">Pulse settings</h1>
      <p class="text-sm text-muted-foreground mb-6">
        Settings specific to Pulse. OSN identity settings (name, handle, email) live in your OSN
        profile.
      </p>

      <Show
        when={session()}
        fallback={<p class="text-sm text-muted-foreground">Sign in to change your settings.</p>}
      >
        <section class="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
          <h2 class="text-base font-semibold text-foreground">
            Who can see events you're attending?
          </h2>
          <p class="text-xs text-muted-foreground">
            Note: if an event has a public guest list, attending it opts you in regardless of this
            setting. Choose your event visibility carefully when RSVPing.
          </p>
          <div class="flex flex-col gap-2 mt-2">
            {OPTIONS.map((opt) => (
              <label class="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="attendanceVisibility"
                  value={opt.value}
                  checked={selected() === opt.value}
                  onChange={() => setSelected(opt.value)}
                  class="mt-1"
                />
                <span>
                  <span class="text-sm font-medium text-foreground">{opt.label}</span>
                  <span class="block text-xs text-muted-foreground">{opt.description}</span>
                </span>
              </label>
            ))}
          </div>
          <div class="flex justify-end mt-2">
            <button
              type="button"
              disabled={saving()}
              onClick={save}
              class="rounded-md px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving() ? "Saving…" : "Save"}
            </button>
          </div>
        </section>
      </Show>
    </main>
  );
}

import { Button } from "@osn/ui/ui/button";
import { Card } from "@osn/ui/ui/card";
import { Label } from "@osn/ui/ui/label";
import { RadioGroup, RadioGroupItem } from "@osn/ui/ui/radio-group";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { createSignal, Show } from "solid-js";

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

  const [selected, setSelected] = createSignal<Visibility>("connections");
  const [saving, setSaving] = createSignal(false);

  async function save() {
    if (!session()) {
      toast.error("Sign in to change settings");
      return;
    }
    setSaving(true);
    try {
      const res = await updateMySettings({ attendanceVisibility: selected() });
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
    <main class="mx-auto max-w-3xl px-6 py-6">
      <h1 class="text-foreground mb-2 text-2xl font-bold">Pulse settings</h1>
      <p class="text-muted-foreground mb-6 text-sm">
        Settings specific to Pulse. Your name, handle and email belong to your musubi account — edit
        them there and every app that uses it, Pulse included, follows.
      </p>

      <Show
        when={session()}
        fallback={<p class="text-muted-foreground text-sm">Sign in to change your settings.</p>}
      >
        <Card class="flex flex-col gap-3 p-4">
          <Label class="text-base font-semibold">Who can see events you're attending?</Label>
          <p class="text-muted-foreground text-xs">
            Note: if an event has a public guest list, attending it opts you in regardless of this
            setting. Choose your event visibility carefully when RSVPing.
          </p>
          <RadioGroup
            class="mt-2 flex flex-col gap-2"
            value={selected()}
            onChange={(v) => setSelected(v as Visibility)}
            name="attendanceVisibility"
          >
            {OPTIONS.map((opt) => (
              <div class="flex items-start gap-2">
                <RadioGroupItem value={opt.value} label={opt.label} />
                <span class="text-muted-foreground block text-xs">{opt.description}</span>
              </div>
            ))}
          </RadioGroup>
          <div class="mt-2 flex justify-end">
            <Button size="sm" disabled={saving()} onClick={save}>
              {saving() ? "Saving…" : "Save"}
            </Button>
          </div>
        </Card>
      </Show>
    </main>
  );
}

export default SettingsPage;

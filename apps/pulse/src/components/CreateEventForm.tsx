import { createSignal, createMemo, Show } from "solid-js";
import { api } from "../lib/api";
import { LocationInput } from "../lib/LocationInput";
import { toDatetimeLocal, isEndBeforeOrAtStart } from "../lib/utils";

export function CreateEventForm(props: {
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
      if (error) return;
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

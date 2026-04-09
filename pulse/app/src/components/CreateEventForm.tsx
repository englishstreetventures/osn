import { createSignal, createMemo, Show } from "solid-js";
import { toast } from "solid-toast";
import { api } from "../lib/api";
import { LocationInput } from "../lib/LocationInput";
import { toDatetimeLocal, isEndBeforeOrAtStart } from "../lib/utils";
import { InfoPopover } from "./InfoPopover";

type Visibility = "public" | "private";
type GuestListVisibility = "public" | "connections" | "private";
type JoinPolicy = "open" | "guest_list";
type CommsChannel = "sms" | "email";

export function CreateEventForm(props: {
  accessToken: string | null;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = createSignal("");
  const [startTime, setStartTime] = createSignal(toDatetimeLocal(new Date()));
  const [endTime, setEndTime] = createSignal("");
  const [location, setLocation] = createSignal("");
  const [latitude, setLatitude] = createSignal<number | undefined>(undefined);
  const [longitude, setLongitude] = createSignal<number | undefined>(undefined);
  const [description, setDescription] = createSignal("");
  const [visibility, setVisibility] = createSignal<Visibility>("public");
  const [guestListVisibility, setGuestListVisibility] = createSignal<GuestListVisibility>("public");
  const [joinPolicy, setJoinPolicy] = createSignal<JoinPolicy>("open");
  const [allowInterested, setAllowInterested] = createSignal(true);
  const [commsChannels, setCommsChannels] = createSignal<Set<CommsChannel>>(new Set(["email"]));
  const [submitting, setSubmitting] = createSignal(false);

  const endTimeError = createMemo(() =>
    isEndBeforeOrAtStart(startTime(), endTime()) ? "End time must be after start time" : "",
  );
  const commsError = createMemo(() =>
    commsChannels().size === 0 ? "Pick at least one channel" : "",
  );

  function toggleChannel(channel: CommsChannel) {
    setCommsChannels((prev) => {
      const next = new Set(prev);
      if (next.has(channel)) next.delete(channel);
      else next.add(channel);
      return next;
    });
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (endTimeError() || commsError()) return;
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
          latitude: latitude(),
          longitude: longitude(),
          description: description() || undefined,
          visibility: visibility(),
          guestListVisibility: guestListVisibility(),
          joinPolicy: joinPolicy(),
          allowInterested: allowInterested(),
          commsChannels: Array.from(commsChannels()),
        },
        { headers },
      );
      if (error) {
        if (import.meta.env.DEV) console.error("Failed to create event:", error);
        toast.error("Failed to create event");
        return;
      }
      props.onSuccess();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      class="rounded-xl border border-border bg-card p-4 flex flex-col gap-4 mb-4"
    >
      {/* Title */}
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

      {/* Time */}
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

      {/* Location */}
      <div class="flex flex-col gap-1">
        <label class="text-sm font-medium text-foreground" for="location">
          Location
        </label>
        <LocationInput
          value={location()}
          onValue={(v) => {
            setLocation(v);
            setLatitude(undefined);
            setLongitude(undefined);
          }}
          onCoords={(lat, lng) => {
            setLatitude(lat);
            setLongitude(lng);
          }}
        />
      </div>

      {/* Description */}
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

      {/* Event visibility */}
      <div class="flex flex-col gap-1">
        <div class="flex items-center">
          <label class="text-sm font-medium text-foreground">Event visibility</label>
          <InfoPopover
            label="About event visibility"
            body="Public events can appear in Discover and the Pulse feed. Private events are only reachable by direct link or invite — they won't show up in anyone else's feed."
          />
        </div>
        <div class="flex gap-2 text-sm">
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="visibility"
              checked={visibility() === "public"}
              onChange={() => setVisibility("public")}
            />
            Public
          </label>
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="visibility"
              checked={visibility() === "private"}
              onChange={() => setVisibility("private")}
            />
            Private (link only)
          </label>
        </div>
      </div>

      {/* Guest list visibility */}
      <div class="flex flex-col gap-1">
        <div class="flex items-center">
          <label class="text-sm font-medium text-foreground">Guest list visibility</label>
          <InfoPopover
            label="About guest list visibility"
            body="Public = anyone who can see the event sees who's going. Connections = only your connections can see the list. Private = only you can see — others see counts only."
          />
        </div>
        <div class="flex gap-2 text-sm">
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="guestListVisibility"
              checked={guestListVisibility() === "public"}
              onChange={() => setGuestListVisibility("public")}
            />
            Public
          </label>
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="guestListVisibility"
              checked={guestListVisibility() === "connections"}
              onChange={() => setGuestListVisibility("connections")}
            />
            Connections only
          </label>
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="guestListVisibility"
              checked={guestListVisibility() === "private"}
              onChange={() => setGuestListVisibility("private")}
            />
            Hidden
          </label>
        </div>
      </div>

      {/* Join policy */}
      <div class="flex flex-col gap-1">
        <div class="flex items-center">
          <label class="text-sm font-medium text-foreground">Who can RSVP?</label>
          <InfoPopover
            label="About join policy"
            body="Open = anyone with the link can RSVP going or maybe. Guest list = you invite specific people first, and only invited users can RSVP going."
          />
        </div>
        <div class="flex gap-2 text-sm">
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="joinPolicy"
              checked={joinPolicy() === "open"}
              onChange={() => setJoinPolicy("open")}
            />
            Anyone with the link
          </label>
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="joinPolicy"
              checked={joinPolicy() === "guest_list"}
              onChange={() => setJoinPolicy("guest_list")}
            />
            Guest list only
          </label>
        </div>
      </div>

      {/* Allow interested */}
      <div class="flex flex-col gap-1">
        <div class="flex items-center">
          <label class="text-sm font-medium text-foreground">Allow "Maybe" replies?</label>
          <InfoPopover
            label="About Maybe replies"
            body="When enabled, guests can RSVP Maybe in addition to Going / Can't make it. Turn off for strict Yes/No events."
          />
        </div>
        <div class="flex gap-2 text-sm">
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="allowInterested"
              checked={allowInterested() === true}
              onChange={() => setAllowInterested(true)}
            />
            Yes
          </label>
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="allowInterested"
              checked={allowInterested() === false}
              onChange={() => setAllowInterested(false)}
            />
            No
          </label>
        </div>
      </div>

      {/* Comms channels */}
      <div class="flex flex-col gap-1">
        <div class="flex items-center">
          <label class="text-sm font-medium text-foreground">How to reach guests</label>
          <InfoPopover
            label="About announcement channels"
            body="The channels you'll use to send reminders and announcements (blasts) to guests. Pick one or both — actual sending lands later; for now you can preview how blasts will appear on the event page."
          />
        </div>
        <div class="flex gap-3 text-sm">
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={commsChannels().has("email")}
              onChange={() => toggleChannel("email")}
            />
            Email
          </label>
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={commsChannels().has("sms")}
              onChange={() => toggleChannel("sms")}
            />
            SMS
          </label>
        </div>
        <Show when={commsError()}>{(err) => <p class="text-xs text-destructive">{err()}</p>}</Show>
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

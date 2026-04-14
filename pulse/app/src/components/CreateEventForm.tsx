import { Button } from "@osn/ui/ui/button";
import { Card } from "@osn/ui/ui/card";
import { Checkbox } from "@osn/ui/ui/checkbox";
import { Input } from "@osn/ui/ui/input";
import { Label } from "@osn/ui/ui/label";
import { RadioGroup, RadioGroupItem } from "@osn/ui/ui/radio-group";
import { Textarea } from "@osn/ui/ui/textarea";
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
        // eslint-disable-next-line no-console -- DEV-only client-side debug logging
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
    <Card class="mb-4 p-4">
      <form onSubmit={handleSubmit} class="flex flex-col gap-4">
        {/* Title */}
        <div class="flex flex-col gap-1">
          <Label for="title">Title</Label>
          <Input
            id="title"
            type="text"
            required
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </div>

        {/* Time */}
        <div class="flex gap-3">
          <div class="flex flex-1 flex-col gap-1">
            <Label for="startTime">Start time</Label>
            <Input
              id="startTime"
              type="datetime-local"
              required
              value={startTime()}
              onInput={(e) => setStartTime(e.currentTarget.value)}
            />
          </div>
          <div class="flex flex-1 flex-col gap-1">
            <Label for="endTime">End time</Label>
            <Input
              id="endTime"
              type="datetime-local"
              min={startTime()}
              value={endTime()}
              onInput={(e) => setEndTime(e.currentTarget.value)}
              class={endTimeError() ? "border-destructive" : ""}
            />
            <Show when={endTimeError()}>
              {(err) => <p class="text-destructive text-xs">{err()}</p>}
            </Show>
          </div>
        </div>

        {/* Location */}
        <div class="flex flex-col gap-1">
          <Label for="location">Location</Label>
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
          <Label for="description">Description</Label>
          <Textarea
            id="description"
            rows={3}
            value={description()}
            onInput={(e) => setDescription(e.currentTarget.value)}
            class="resize-none"
          />
        </div>

        {/* Event visibility */}
        <div class="flex flex-col gap-1">
          <div class="flex items-center">
            <Label>Event visibility</Label>
            <InfoPopover
              label="About event visibility"
              body="Public events can appear in Discover and the Pulse feed. Private events are only reachable by direct link or invite — they won't show up in anyone else's feed."
            />
          </div>
          <RadioGroup
            value={visibility()}
            onChange={(v) => setVisibility(v as Visibility)}
            name="visibility"
          >
            <RadioGroupItem value="public" label="Public" />
            <RadioGroupItem value="private" label="Private (link only)" />
          </RadioGroup>
        </div>

        {/* Guest list visibility */}
        <div class="flex flex-col gap-1">
          <div class="flex items-center">
            <Label>Guest list visibility</Label>
            <InfoPopover
              label="About guest list visibility"
              body="Public = anyone who can see the event sees who's going. Connections = only your connections can see the list. Private = only you can see — others see counts only."
            />
          </div>
          <RadioGroup
            value={guestListVisibility()}
            onChange={(v) => setGuestListVisibility(v as GuestListVisibility)}
            name="guestListVisibility"
          >
            <RadioGroupItem value="public" label="Public" />
            <RadioGroupItem value="connections" label="Connections only" />
            <RadioGroupItem value="private" label="Hidden" />
          </RadioGroup>
        </div>

        {/* Join policy */}
        <div class="flex flex-col gap-1">
          <div class="flex items-center">
            <Label>Who can RSVP?</Label>
            <InfoPopover
              label="About join policy"
              body="Open = anyone with the link can RSVP going or maybe. Guest list = you invite specific people first, and only invited users can RSVP going."
            />
          </div>
          <RadioGroup
            value={joinPolicy()}
            onChange={(v) => setJoinPolicy(v as JoinPolicy)}
            name="joinPolicy"
          >
            <RadioGroupItem value="open" label="Anyone with the link" />
            <RadioGroupItem value="guest_list" label="Guest list only" />
          </RadioGroup>
        </div>

        {/* Allow interested */}
        <div class="flex flex-col gap-1">
          <div class="flex items-center">
            <Label>Allow "Maybe" replies?</Label>
            <InfoPopover
              label="About Maybe replies"
              body="When enabled, guests can RSVP Maybe in addition to Going / Can't make it. Turn off for strict Yes/No events."
            />
          </div>
          <RadioGroup
            value={allowInterested() ? "yes" : "no"}
            onChange={(v) => setAllowInterested(v === "yes")}
            name="allowInterested"
          >
            <RadioGroupItem value="yes" label="Yes" />
            <RadioGroupItem value="no" label="No" />
          </RadioGroup>
        </div>

        {/* Comms channels */}
        <div class="flex flex-col gap-1">
          <div class="flex items-center">
            <Label>How to reach guests</Label>
            <InfoPopover
              label="About announcement channels"
              body="The channels you'll use to send reminders and announcements (blasts) to guests. Pick one or both — actual sending lands later; for now you can preview how blasts will appear on the event page."
            />
          </div>
          <div class="flex gap-3 text-sm">
            <Checkbox
              checked={commsChannels().has("email")}
              onChange={() => toggleChannel("email")}
              label="Email"
            />
            <Checkbox
              checked={commsChannels().has("sms")}
              onChange={() => toggleChannel("sms")}
              label="SMS"
            />
          </div>
          <Show when={commsError()}>
            {(err) => <p class="text-destructive text-xs">{err()}</p>}
          </Show>
        </div>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={submitting()}>
            {submitting() ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

import { Button } from "@shared/ui/ui/button";

import { API_MOUNT } from "../lib/transport";

/**
 * Downloads the event's ICS file via a hidden anchor with `download` so
 * the browser saves the file. The link is relative to this origin's pulse-api
 * mount, which is where the browser reaches pulse-api.
 */
export function AddToCalendarButton(props: { eventId: string }) {
  const icsUrl = () => `${API_MOUNT}/events/${encodeURIComponent(props.eventId)}/ics`;

  function addToCalendar() {
    const url = icsUrl();
    const a = document.createElement("a");
    a.href = url;
    a.download = `${props.eventId}.ics`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <Button variant="secondary" size="sm" onClick={addToCalendar}>
      Add to calendar
    </Button>
  );
}

import { Button } from "@osn/ui/ui/button";

/**
 * Downloads the event's ICS file via a hidden anchor with `download` so
 * the browser saves the file.
 */
export function AddToCalendarButton(props: { eventId: string; apiBaseUrl: string }) {
  const icsUrl = () => `${props.apiBaseUrl}/events/${props.eventId}/ics`;

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

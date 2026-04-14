import { Button } from "@osn/ui/ui/button";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Downloads the event's ICS file. On Tauri (iOS) we hand the URL to
 * `openUrl` so iOS routes it to the Calendar app. On web we use a
 * hidden anchor with `download` so the browser saves the file.
 */
export function AddToCalendarButton(props: { eventId: string; apiBaseUrl: string }) {
  const icsUrl = () => `${props.apiBaseUrl}/events/${props.eventId}/ics`;

  async function addToCalendar() {
    const url = icsUrl();
    try {
      // On Tauri native, the opener plugin hands the URL off to the OS,
      // which on iOS presents the calendar import sheet.
      await openUrl(url);
      return;
    } catch {
      // Fall through to web behaviour below.
    }
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

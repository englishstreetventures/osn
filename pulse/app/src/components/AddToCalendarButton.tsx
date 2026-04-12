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
    <button
      type="button"
      onClick={addToCalendar}
      class="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium"
    >
      Add to calendar
    </button>
  );
}

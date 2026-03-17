export function formatTime(iso: string | Date): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function toDatetimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  // Round up to next minute so the default start time is always slightly in the future
  const rounded = new Date(Math.ceil(date.getTime() / 60000) * 60000);
  return `${rounded.getFullYear()}-${pad(rounded.getMonth() + 1)}-${pad(rounded.getDate())}T${pad(rounded.getHours())}:${pad(rounded.getMinutes())}`;
}

export interface PhotonFeature {
  properties: {
    name?: string;
    street?: string;
    city?: string;
    state?: string;
    country?: string;
  };
}

export function composeLabel(p: PhotonFeature["properties"]): string {
  return [p.name, p.street, p.city, p.state, p.country].filter(Boolean).join(", ");
}

/** Returns true when end is set and is not strictly after start (form validation). */
export function isEndBeforeOrAtStart(start: string, end: string): boolean {
  return !!end && end <= start;
}

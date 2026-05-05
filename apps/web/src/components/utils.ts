import type { ClaimResult } from "./types";

export function formatDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function isValidClaimResponse(data: unknown): data is ClaimResult {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.publicId !== "string") return false;
  if (typeof obj.familyName !== "string") return false;
  if (!Array.isArray(obj.members)) return false;
  if (!Array.isArray(obj.events)) return false;
  const membersValid = obj.members.every(
    (m: unknown) =>
      typeof m === "object" &&
      m !== null &&
      typeof (m as Record<string, unknown>).firstName === "string" &&
      typeof (m as Record<string, unknown>).lastName === "string" &&
      Array.isArray((m as Record<string, unknown>).eventIds),
  );
  if (!membersValid) return false;
  return obj.events.every(
    (e: unknown) =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as Record<string, unknown>).id === "string" &&
      typeof (e as Record<string, unknown>).name === "string" &&
      typeof (e as Record<string, unknown>).date === "string" &&
      typeof (e as Record<string, unknown>).location === "string",
  );
}

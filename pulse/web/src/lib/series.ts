/**
 * REST wrappers for the series endpoints. Raw fetch for the same reason as
 * `rsvps.ts` — Eden types chain left-to-right and destabilise as routes
 * are added in separate PRs.
 */

import { PULSE_API_URL, publicFetch } from "./auth";

const BASE_URL = PULSE_API_URL;

export interface SeriesSummary {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  venue: string | null;
  category: string | null;
  rrule: string;
  dtstart: string;
  until: string | null;
  timezone: string;
  status: "active" | "ended" | "cancelled";
  createdByProfileId: string;
  createdByName: string | null;
}

export interface SeriesInstance {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  venue: string | null;
  latitude: number | null;
  longitude: number | null;
  category: string | null;
  startTime: string;
  endTime: string | null;
  status: "upcoming" | "ongoing" | "finished" | "cancelled";
  imageUrl: string | null;
  seriesId: string | null;
  instanceOverride: boolean;
  createdByProfileId: string;
  createdByName: string | null;
}

export async function fetchSeries(id: string): Promise<SeriesSummary | null> {
  const res = await publicFetch(`${BASE_URL}/series/${id}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { series?: SeriesSummary };
  return body.series ?? null;
}

export async function fetchSeriesInstances(
  id: string,
  scope: "past" | "upcoming" | "all",
): Promise<SeriesInstance[]> {
  const res = await publicFetch(`${BASE_URL}/series/${id}/instances?scope=${scope}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { instances?: SeriesInstance[] };
  return body.instances ?? [];
}

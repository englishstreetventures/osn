import { api } from "./api";

type EventsResponse = Awaited<ReturnType<typeof api.events.get>>;
export type EventItem = NonNullable<NonNullable<EventsResponse["data"]>["events"]>[number];

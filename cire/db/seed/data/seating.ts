// A seating chart on the sample wedding's Reception. Consumed only by
// cire/db/seed/generate.ts.
//
// Two tables, three guests seated and one left for the "Not seated" list, so
// a dev tier opens Seating on a chart with something to drag, a table with
// room and a guest still to place. Every seated guest is invited to the
// Reception in guests.ts: a seat's foreign key to `guest_events` refuses
// anyone else.

export type SeedSeatingTable = {
  readonly id: string;
  readonly eventId: string;
  readonly name: string;
  readonly capacity: number;
  readonly sortOrder: number;
};

export type SeedSeat = {
  readonly tableId: string;
  readonly eventId: string;
  readonly guestId: string;
};

const RECEPTION = "9f7a2c14-1b3d-4e5f-8a01-000000000004";
const table = (n: number): string => `stb_c1d2e3f4-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const seatingTables = [
  { id: table(1), eventId: RECEPTION, name: "Table 1", capacity: 8, sortOrder: 0 },
  { id: table(2), eventId: RECEPTION, name: "Table 2", capacity: 10, sortOrder: 1 },
] as const satisfies readonly SeedSeatingTable[];

export const seats = [
  // Ada Testfamily and Bo Sampleton.
  { tableId: table(1), eventId: RECEPTION, guestId: "b0000000-0000-4000-8000-000000000001" },
  { tableId: table(1), eventId: RECEPTION, guestId: "b0000000-0000-4000-8000-000000000002" },
  // Eli Placeholder. Cleo Sampleton is left unseated.
  { tableId: table(2), eventId: RECEPTION, guestId: "b0000000-0000-4000-8000-000000000006" },
] as const satisfies readonly SeedSeat[];

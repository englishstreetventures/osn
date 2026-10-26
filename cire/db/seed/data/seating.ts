// A seating chart on the sample wedding's Reception. Consumed only by
// cire/db/seed/generate.ts.
//
// Two plans. "Plan 1" is selected: two tables, three guests seated and one
// left for the "Not seated" list, so a dev tier opens Seating on a chart with
// something to drag, a table with room and a guest still to place. "Long
// table" is an alternative with one table and the same three guests, so the
// plan picker has a second plan to open. Every seated guest is invited to the
// Reception in guests.ts: a seat's foreign key to `guest_events` refuses
// anyone else. Every row names its plan.

export type SeedSeatingPlan = {
  readonly id: string;
  readonly eventId: string;
  readonly name: string;
  readonly selected: boolean;
};

export type SeedSeatingTable = {
  readonly id: string;
  readonly planId: string;
  readonly eventId: string;
  readonly name: string;
  readonly capacity: number;
  readonly sortOrder: number;
};

export type SeedSeat = {
  readonly tableId: string;
  readonly planId: string;
  readonly eventId: string;
  readonly guestId: string;
};

const RECEPTION = "9f7a2c14-1b3d-4e5f-8a01-000000000004";
const plan = (n: number): string => `spl_c1d2e3f4-0000-4000-8000-${String(n).padStart(12, "0")}`;
const table = (n: number): string => `stb_c1d2e3f4-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ADA = "b0000000-0000-4000-8000-000000000001";
const BO = "b0000000-0000-4000-8000-000000000002";
const ELI = "b0000000-0000-4000-8000-000000000006";

export const seatingPlans = [
  { id: plan(1), eventId: RECEPTION, name: "Plan 1", selected: true },
  { id: plan(2), eventId: RECEPTION, name: "Long table", selected: false },
] as const satisfies readonly SeedSeatingPlan[];

export const seatingTables = [
  { id: table(1), planId: plan(1), eventId: RECEPTION, name: "Table 1", capacity: 8, sortOrder: 0 },
  {
    id: table(2),
    planId: plan(1),
    eventId: RECEPTION,
    name: "Table 2",
    capacity: 10,
    sortOrder: 1,
  },
  {
    id: table(3),
    planId: plan(2),
    eventId: RECEPTION,
    name: "Long table",
    capacity: 20,
    sortOrder: 0,
  },
] as const satisfies readonly SeedSeatingTable[];

export const seats = [
  // Plan 1: Ada Testfamily and Bo Sampleton at Table 1, Eli Placeholder at
  // Table 2. Cleo Sampleton is left unseated.
  { tableId: table(1), planId: plan(1), eventId: RECEPTION, guestId: ADA },
  { tableId: table(1), planId: plan(1), eventId: RECEPTION, guestId: BO },
  { tableId: table(2), planId: plan(1), eventId: RECEPTION, guestId: ELI },
  // Long table: the same three together.
  { tableId: table(3), planId: plan(2), eventId: RECEPTION, guestId: ADA },
  { tableId: table(3), planId: plan(2), eventId: RECEPTION, guestId: BO },
  { tableId: table(3), planId: plan(2), eventId: RECEPTION, guestId: ELI },
] as const satisfies readonly SeedSeat[];

// Types for cire-api's gift-payout model.mjs, which `bend model.bend -o
// model.mjs` writes. A Bend value crosses as `{ $: "<constructor>", ...fields }`,
// a Nat as a number, a Bool as a boolean, and a List as `Con`/`Nil` cells. Only
// the defs the agreement test calls are declared.

export type List<T> = { $: "Nil" } | { $: "Con"; head: T; tail: List<T> };
export type Maybe<T> = { $: "None" } | { $: "Some"; value: T };

// payout.bend
export type Role = { $: "Owner" } | { $: "Editor" };
export type Seat = { $: "Seat"; profile: number; role: Role };
export type Reason =
  | { $: "HandedOver" }
  | { $: "Disconnected" }
  | { $: "Replaced" }
  | { $: "HolderAbsent" };
export type Rec = { $: "Rec"; account: number; reason: Reason; released: boolean };
export type P = {
  $: "P";
  live: boolean;
  seats: List<Seat>;
  account: Maybe<number>;
  holder: Maybe<number>;
  charges: boolean;
  gifts: boolean;
  gen: number;
  retired: List<Rec>;
};
export type Ev =
  | { $: "Connect"; by: number; account: number; gen: number; charges: boolean }
  | { $: "Join"; by: number; account: number; charges: boolean }
  | { $: "Retire"; by: number; hand: Maybe<number>; read: Maybe<number>; gen: number }
  | { $: "Detach"; account: number }
  | { $: "Update"; account: number; charges: boolean }
  | { $: "Gifts"; on: boolean }
  | { $: "Add"; profile: number; role: Role }
  | { $: "Remove"; profile: number }
  | { $: "SetRole"; profile: number; role: Role }
  | { $: "Discard"; by: number }
  | { $: "Revive"; profile: number }
  | { $: "Erase"; profiles: List<number> };
export type Block = { $: "Open" } | { $: "HolderGone" } | { $: "NotReady" } | { $: "GiftsOff" };

declare const model: {
  readonly "payout:created": (profile: number) => P;
  readonly "payout:step": (s: P, e: Ev) => P;
  readonly "payout:block": (s: P) => Block;
  readonly "payout:absent": (s: P) => boolean;
};
export default model;

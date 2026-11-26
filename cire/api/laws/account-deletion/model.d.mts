// Types for cire-api's model.mjs, which `bend model.bend -o model.mjs`
// writes. A Bend value crosses as `{ $: "<constructor>", ...fields }`, a Nat
// as a number, a Bool as a boolean, and a List as `Con`/`Nil` cells. Only the
// defs the agreement test calls are declared; the preview's action is osn-api's
// `AppAct` (osn/api/laws/account-deletion/choices.bend), declared here again
// so this package reads no types from another.

export type List<T> = { $: "Nil" } | { $: "Con"; head: T; tail: List<T> };
export type Maybe<T> = { $: "None" } | { $: "Some"; value: T };
export type AppAct = { $: "AppAct"; id: number; offers: List<number>; fallback: Maybe<number> };

// weddings.bend
export type Role = { $: "Owner" } | { $: "Editor" } | { $: "Viewer" } | { $: "Helper" };
export type Seat = { $: "Seat"; profile: number; account: number; role: Role };
export type W = { $: "W"; live: boolean; seats: List<Seat> };
export type WEv =
  | { $: "Add"; profile: number; account: number; role: Role }
  | { $: "Remove"; profile: number }
  | { $: "SetRole"; profile: number; role: Role }
  | { $: "EraseAcct"; account: number }
  | { $: "Discard" }
  | { $: "Revive"; profile: number };

declare const model: {
  readonly "weddings:created": (profile: number, account: number) => W;
  readonly "weddings:step": (w: W, e: WEv) => W;
  readonly "weddings:preview": (account: number, wedding: number, w: W) => List<AppAct>;
};
export default model;

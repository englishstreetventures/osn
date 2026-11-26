// Types for osn-api's model.mjs, which `bend model.bend -o model.mjs` writes. A Bend
// value crosses as `{ $: "<constructor>", ...fields }`, a Nat as a number, a
// Bool as a boolean, and a List as `Con`/`Nil` cells. Only the defs the
// agreement tests call are declared.

export type List<T> = { $: "Nil" } | { $: "Con"; head: T; tail: List<T> };
export type Maybe<T> = { $: "None" } | { $: "Some"; value: T };

// choices.bend
export type Heir = { $: "Nobody" } | { $: "Member" } | { $: "Admin" };
export type OrgAct = { $: "OrgAct"; id: number; heir: Heir };
export type AppAct = { $: "AppAct"; id: number; offers: List<number>; fallback: Maybe<number> };
export type OrgChoice = { $: "Transfer" } | { $: "Successor" } | { $: "Delete" };
export type Pick =
  | { $: "OrgPick"; id: number; choice: OrgChoice; member: boolean }
  | { $: "AppPick"; id: number; choice: number }
  | { $: "OtherPick" };
export type Req = {
  $: "Req";
  orgs: List<OrgAct>;
  apps: List<AppAct>;
  picks: List<Pick>;
  everything: boolean;
  unchecked: boolean;
};
export type Verdict =
  | { $: "Ok" }
  | { $: "Invalid" }
  | { $: "Stale" }
  | { $: "Open" }
  | { $: "Unchecked" }
  | { $: "Both" };

// account.bend
export type Mark = { $: "Pending" } | { $: "Confirmed" } | { $: "Skipped" };
export type Reply = { $: "Answers" } | { $: "Fails" } | { $: "Absent" };
export type Acct =
  | { $: "Live"; next: number }
  | {
      $: "Scheduled";
      job: number;
      due: number;
      claimed: boolean;
      pulse: Mark;
      zap: Mark;
      cire: Mark;
      everything: boolean;
      next: number;
    }
  | { $: "Erased"; job: number; due: number; at: number; pulse: Mark; zap: Mark; cire: Mark };
export type AcctEv =
  | { $: "Ask"; now: number; req: Req }
  | { $: "Keep"; now: number; read: number }
  | { $: "FanOut"; now: number; pulse: Reply; zap: Reply; cire: Reply }
  | { $: "Sweep"; now: number };

// holds.bend
export type Hold = { $: "Free" } | { $: "Held"; acct: number } | { $: "Until"; release: number };
export type H = { $: "H"; owner: Maybe<number>; hold: Hold; clock: number };
export type HoldEv = { $: "Delete" | "Restore" | "Erase" | "Claim"; acct: number; now: number };

// succession.bend
export type Rank = { $: "Admin" } | { $: "Plain" };
export type Mem = { $: "Mem"; profile: number; account: number; rank: Rank };
export type Answer =
  | { $: "Transfer" }
  | { $: "Named"; profile: number }
  | { $: "Remove" }
  | { $: "Unanswered" };

declare const model: {
  readonly "choices:delete_choice": () => number;
  readonly "choices:verdict": (r: Req) => Verdict;
  readonly "account:window": () => number;
  readonly "account:init": () => Acct;
  readonly "account:step": (s: Acct, e: AcctEv) => Acct;
  readonly "holds:thirty_days": () => number;
  readonly "holds:start": (owner: number) => H;
  readonly "holds:step": (s: H, e: HoldEv) => H;
  readonly "holds:live": (h: Hold, t: number) => boolean;
  readonly "succession:heir": (gone: number, members: List<Mem>, answer: Answer) => Maybe<number>;
};
export default model;

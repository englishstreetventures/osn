# One cire wedding: its seats, what a host may change, and what an account's
# erasure does to it.
#
# A seat change that would leave no owner is refused (cire/api/src/routes/
# organiser-hosts.ts:475-476, :679; the code counts owner seats in
# services/hosts.ts:763-773 and :987-998). An erasure takes the account's
# seats and soft-deletes the wedding in the same batch when no owner of
# another account is left (services/account-erasure.ts:293-357). An owner may
# delete the wedding (wedding-lifecycle.ts:175) and restore it
# (:264-271, which needs the caller's owner seat; its time window is not
# modelled). Nothing changes a deleted wedding's seats but an erasure.
#
# The preview lists a live wedding whose owner seats are all the account's as
# an action with one choice, delete, and no default (account-erasure.ts:
# 214-262).

import Base
import ../../../../osn/api/laws/account-deletion/choices.bend as Choices

type Role is Data:
  Owner{}
  Editor{}
  Viewer{}
  Helper{}

type Seat is Data:
  Seat{profile: Nat, account: Nat, role: Role}

type W is Data:
  W{live: Bool, seats: +List<Seat>}

type WEv is Data:
  Add{profile: Nat, account: Nat, role: Role}
  Remove{profile: Nat}
  SetRole{profile: Nat, role: Role}
  EraseAcct{account: Nat}
  Discard{}
  Revive{profile: Nat}

def is_owner(r: Role) -> Bool:
  match r:
    case Owner{}:
      True{}
    case Editor{}:
      False{}
    case Viewer{}:
      False{}
    case Helper{}:
      False{}

def has_owner(ss: +List<Seat>) -> Bool:
  match ss:
    case Nil{}:
      False{}
    case Seat{p, a, r} <> rest:
      is_owner(r) || has_owner(rest)

def seated(+q: Nat, ss: +List<Seat>) -> Bool:
  match ss:
    case Nil{}:
      False{}
    case Seat{p, a, r} <> rest:
      Nat.is_eq(p, q) || seated(q, rest)

# Profile `q` holds an owner seat.
def owns(+q: Nat, ss: +List<Seat>) -> Bool:
  match ss:
    case Nil{}:
      False{}
    case Seat{p, a, r} <> rest:
      (Nat.is_eq(p, q) && is_owner(r)) || owns(q, rest)

# Account `acct` holds an owner seat.
def acct_owns(+acct: Nat, ss: +List<Seat>) -> Bool:
  match ss:
    case Nil{}:
      False{}
    case Seat{p, a, r} <> rest:
      (Nat.is_eq(a, acct) && is_owner(r)) || acct_owns(acct, rest)

def keep_seat(+q: Nat, s: Seat, +rest: +List<Seat>) -> +List<Seat>:
  Seat{+p, +a, +r} = s
  Bool.pick(+List<Seat>, Nat.is_eq(p, q), rest, Seat{p, a, r} <> rest)

def without(+q: Nat, ss: +List<Seat>) -> +List<Seat>:
  match ss:
    case Nil{}:
      Nil{}
    case s <> rest:
      keep_seat(q, s, without(q, rest))

def set_seat(+q: Nat, +r2: Role, s: Seat) -> Seat:
  Seat{+p, +a, r} = s
  Bool.pick(Seat, Nat.is_eq(p, q), Seat{p, a, r2}, Seat{p, a, r})

def set_role(+q: Nat, +r2: Role, ss: +List<Seat>) -> +List<Seat>:
  match ss:
    case Nil{}:
      Nil{}
    case s <> rest:
      set_seat(q, r2, s) <> set_role(q, r2, rest)

def keep_other(+acct: Nat, s: Seat, +rest: +List<Seat>) -> +List<Seat>:
  Seat{+p, +a, +r} = s
  Bool.pick(+List<Seat>, Nat.is_eq(a, acct), rest, Seat{p, a, r} <> rest)

# The seats an account's erasure leaves.
def erase_seats(+acct: Nat, ss: +List<Seat>) -> +List<Seat>:
  match ss:
    case Nil{}:
      Nil{}
    case s <> rest:
      keep_other(acct, s, erase_seats(acct, rest))

# A host change goes through only while some owner remains after it.
def guarded(+ss: +List<Seat>, +changed: +List<Seat>) -> +List<Seat>:
  Bool.pick(+List<Seat>, has_owner(changed), changed, ss)

def step_live(e: WEv, +ss: +List<Seat>) -> W:
  match e:
    case Add{+q, a, r}:
      W{True{}, Bool.pick(+List<Seat>, seated(q, ss), ss, Seat{q, a, r} <> ss)}
    case Remove{+q}:
      W{True{}, guarded(ss, without(q, ss))}
    case SetRole{+q, +r}:
      W{True{}, guarded(ss, set_role(q, r, ss))}
    case EraseAcct{+a}:
      +rest = erase_seats(a, ss)
      W{has_owner(rest), rest}
    case Discard{}:
      W{False{}, ss}
    case Revive{q}:
      W{True{}, ss}

def step_dead(e: WEv, +ss: +List<Seat>) -> W:
  match e:
    case Add{q, a, r}:
      W{False{}, ss}
    case Remove{q}:
      W{False{}, ss}
    case SetRole{q, r}:
      W{False{}, ss}
    case EraseAcct{+a}:
      W{False{}, erase_seats(a, ss)}
    case Discard{}:
      W{False{}, ss}
    case Revive{+q}:
      W{owns(q, ss), ss}

def step(w: W, e: WEv) -> W:
  match w:
    case W{live, ss}:
      match live:
        case True{}:
          step_live(e, ss)
        case False{}:
          step_dead(e, ss)

# A new wedding: its creator's owner seat.
def created(+q: Nat, +a: Nat) -> W:
  W{True{}, [Seat{q, a, Owner{}}]}

def run(es: List<WEv>, w: W) -> W:
  match es:
    case Nil{}:
      w
    case e <> rest:
      run(rest, step(w, e))

# Live, and every owner seat is the account's: it owns one, and none is left
# once its seats go.
def sole(+acct: Nat, w: W) -> Bool:
  match w:
    case W{live, +ss}:
      (live && acct_owns(acct, ss)) && Bool.not(has_owner(erase_seats(acct, ss)))

def wedding_action(+wid: Nat) -> Choices.AppAct:
  Choices.AppAct{wid, [Choices.delete_choice()], None{}}

def preview(+acct: Nat, +wid: Nat, +w: W) -> +List<Choices.AppAct>:
  Bool.pick(+List<Choices.AppAct>, sole(acct, w), [wedding_action(wid)], [])

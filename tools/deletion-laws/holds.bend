# One handle and the hold a deleted account leaves on it.
#
# The soft delete redacts the profile's handle and holds it
# (osn/api/src/services/account-erasure.ts:381-418); a cancel releases the
# holds and puts the handle back while it is free (:614-676); the hard delete
# drops the hold's account and releases it 30 days on (:1871-1874). Every
# place that creates or offers a handle refuses one with a live hold
# (osn/api/src/lib/handle-hold.ts:60-101): live while the deletion is pending,
# or until its release. `owner` is the account whose profile or organisation
# has the handle now, if any (the two share one namespace).
#
# The model keeps one clock that never goes back: each event happens at the
# later of its own time and the last time seen.

import Base

type Hold is Data:
  Free{}
  Held{acct: Nat}
  Until{release: Nat}

type H is Data:
  H{owner: Maybe<&2, Nat>, hold: Hold, clock: Nat}

type HEv is Data:
  Delete{acct: Nat, now: Nat}
  Restore{acct: Nat, now: Nat}
  Erase{acct: Nat, now: Nat}
  Claim{acct: Nat, now: Nat}

# Thirty days (account-erasure.ts:85).
def thirty_days() -> Nat:
  2592000n

# heldHandleRow: a hold refuses while pending, and before its release.
def live(h: Hold, +t: Nat) -> Bool:
  match h:
    case Free{}:
      False{}
    case Held{a}:
      True{}
    case Until{r}:
      Nat.is_lt(t, r)

def owned_by(o: Maybe<&2, Nat>, +a: Nat) -> Bool:
  match o:
    case None{}:
      False{}
    case Some{x}:
      Nat.is_eq(x, a)

def held_for(h: Hold, +a: Nat) -> Bool:
  match h:
    case Free{}:
      False{}
    case Held{x}:
      Nat.is_eq(x, a)
    case Until{r}:
      False{}

def unowned(o: Maybe<&2, Nat>) -> Bool:
  match o:
    case None{}:
      True{}
    case Some{x}:
      False{}

def start(+a: Nat) -> H:
  H{Some{a}, Free{}, 0n}

def step(s: H, e: HEv) -> H:
  H{+o, +h, +c} = s
  match e:
    case Delete{+a, now}:
      +t = Nat.max(c, now)
      Bool.pick(H, owned_by(o, a), H{None{}, Held{a}, t}, H{o, h, t})
    case Restore{+a, now}:
      +t = Nat.max(c, now)
      Bool.pick(H, held_for(h, a), H{Bool.pick(Maybe<&2, Nat>, unowned(o), Some{a}, o), Free{}, t}, H{o, h, t})
    case Erase{+a, now}:
      +t = Nat.max(c, now)
      Bool.pick(H, held_for(h, a), H{o, Until{Nat.add(t, thirty_days())}, t}, H{o, h, t})
    case Claim{+a, now}:
      +t = Nat.max(c, now)
      Bool.pick(H, unowned(o) && Bool.not(live(h, t)), H{Some{a}, h, t}, H{o, h, t})

def run(es: List<HEv>, s: H) -> H:
  match es:
    case Nil{}:
      s
    case e <> rest:
      run(rest, step(s, e))

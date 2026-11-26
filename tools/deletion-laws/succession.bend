# Who an organisation passes to when its owner's account is hard-deleted.
#
# The members are in succession order's tie-break, oldest first
# (`organisation_members.created_at`, then id). The heir is the successor the
# person named while that profile is still a member from another account,
# else the first admin from another account, else the first member from
# another account, else no one, and the organisation is deleted
# (osn/api/src/services/account-erasure.ts:780-785, :1791-1833;
# organisation-succession.ts:28-34). A `Remove` answer deletes it.

import Base

type Rank is Data:
  Admin{}
  Plain{}

type Mem is Data:
  Mem{profile: Nat, account: Nat, rank: Rank}

type Answer is Data:
  Transfer{}
  Named{profile: Nat}
  Remove{}
  Unanswered{}

def is_admin(r: Rank) -> Bool:
  match r:
    case Admin{}:
      True{}
    case Plain{}:
      False{}

# The first member from another account than `gone`; with `admins`, the first
# such admin.
def first(+admins: Bool, +gone: Nat, ms: +List<Mem>) -> Maybe<&2, Nat>:
  match ms:
    case Nil{}:
      None{}
    case Mem{+p, +a, +r} <> rest:
      Bool.pick(Maybe<&2, Nat>,
        Bool.not(Nat.is_eq(a, gone)) && (Bool.not(admins) || is_admin(r)),
        Some{p}, first(admins, gone, rest))

# `q` is a member from another account than `gone`.
def eligible(+q: Nat, +gone: Nat, ms: +List<Mem>) -> Bool:
  match ms:
    case Nil{}:
      False{}
    case Mem{+p, +a, r} <> rest:
      (Nat.is_eq(p, q) && Bool.not(Nat.is_eq(a, gone))) || eligible(q, gone, rest)

def or_else(x: Maybe<&2, Nat>, y: Maybe<&2, Nat>) -> Maybe<&2, Nat>:
  match x:
    case None{}:
      y
    case Some{v}:
      Some{v}

# The two walks are independent and of the same length: one parallel call.
def best(+gone: Nat, +ms: +List<Mem>) -> Maybe<&2, Nat>:
  admin member = first(True{}, gone, ms) first(False{}, gone, ms)
  or_else(admin, member)

def heir(+gone: Nat, +ms: +List<Mem>, ans: Answer) -> Maybe<&2, Nat>:
  match ans:
    case Transfer{}:
      best(gone, ms)
    case Named{+q}:
      Bool.pick(Maybe<&2, Nat>, eligible(q, gone, ms), Some{q}, best(gone, ms))
    case Remove{}:
      None{}
    case Unanswered{}:
      best(gone, ms)

# What the laws in LAWS.bend mean. Change this file only with LAWS.bend: a
# law must not lean on a helper the model or the proofs may rewrite.

import Base
import ./payout.bend as M

def imp(a: Bool, b: Bool) -> Bool:
  Bool.not(a) || b

# Fields
# ------

def live_of(s: M.P) -> Bool:
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      live

def seats_of(s: M.P) -> +List<M.Seat>:
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      ss

def account_of(s: M.P) -> Maybe<&2, Nat>:
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      account

def holder_of(s: M.P) -> Maybe<&2, Nat>:
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      holder

def charges_of(s: M.P) -> Bool:
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      charges

def gifts_of(s: M.P) -> Bool:
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      gifts

def gen_of(s: M.P) -> Nat:
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      gen

def retired_of(s: M.P) -> +List<M.Rec>:
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      recs

def count(s: M.P) -> Nat:
  List.length(&2, M.Rec, retired_of(s))

# Equalities
# ----------

def same_nat(m: Maybe<&2, Nat>, n: Maybe<&2, Nat>) -> Bool:
  match m:
    case None{}:
      match n:
        case None{}:
          True{}
        case Some{b}:
          False{}
    case Some{a}:
      match n:
        case None{}:
          False{}
        case Some{b}:
          Nat.is_eq(a, b)

def same_bool(a: Bool, b: Bool) -> Bool:
  match a:
    case True{}:
      b
    case False{}:
      Bool.not(b)

def reason_code(r: M.Reason) -> Nat:
  match r:
    case M.HandedOver{}:
      0n
    case M.Disconnected{}:
      1n
    case M.Replaced{}:
      2n
    case M.HolderAbsent{}:
      3n

def same_reason(a: M.Reason, b: M.Reason) -> Bool:
  Nat.is_eq(reason_code(a), reason_code(b))

# The payout fields of two states agree: the account, its holder, Stripe's
# flag, the switch, the generation and how many accounts were retired.
def payout_same(+s: M.P, +t: M.P) -> Bool:
  ((same_nat(account_of(s), account_of(t)) && same_nat(holder_of(s), holder_of(t)))
    && (same_bool(charges_of(s), charges_of(t)) && same_bool(gifts_of(s), gifts_of(t))))
    && (Nat.is_eq(gen_of(s), gen_of(t)) && Nat.is_eq(count(s), count(t)))

# Events
# ------

def is_retire(e: M.Ev) -> Bool:
  match e:
    case M.Connect{by, a, g, c}:
      False{}
    case M.Join{by, a, c}:
      False{}
    case M.Retire{by, hand, read, g}:
      True{}
    case M.Detach{a}:
      False{}
    case M.Update{a, c}:
      False{}
    case M.Gifts{on}:
      False{}
    case M.Add{q, r}:
      False{}
    case M.Remove{q}:
      False{}
    case M.SetRole{q, r}:
      False{}
    case M.Discard{by}:
      False{}
    case M.Revive{q}:
      False{}
    case M.Erase{ps}:
      False{}

# A detach of the account `m` names: Stripe's deauthorization, or cire handing
# an OAuth account back.
def detaches(+m: Maybe<&2, Nat>, e: M.Ev) -> Bool:
  match e:
    case M.Connect{by, a, g, c}:
      False{}
    case M.Join{by, a, c}:
      False{}
    case M.Retire{by, hand, read, g}:
      False{}
    case M.Detach{a}:
      M.is_at(m, a)
    case M.Update{a, c}:
      False{}
    case M.Gifts{on}:
      False{}
    case M.Add{q, r}:
      False{}
    case M.Remove{q}:
      False{}
    case M.SetRole{q, r}:
      False{}
    case M.Discard{by}:
      False{}
    case M.Revive{q}:
      False{}
    case M.Erase{ps}:
      False{}

# Any event but an account's erasure.
def not_erase(e: M.Ev) -> Bool:
  match e:
    case M.Connect{by, a, g, c}:
      True{}
    case M.Join{by, a, c}:
      True{}
    case M.Retire{by, hand, read, g}:
      True{}
    case M.Detach{a}:
      True{}
    case M.Update{a, c}:
      True{}
    case M.Gifts{on}:
      True{}
    case M.Add{q, r}:
      True{}
    case M.Remove{q}:
      True{}
    case M.SetRole{q, r}:
      True{}
    case M.Discard{by}:
      True{}
    case M.Revive{q}:
      True{}
    case M.Erase{ps}:
      False{}

# The account
# -----------

# The step took the account the wedding named and left it naming none.
def cleared(+s: M.P, +t: M.P) -> Bool:
  M.named(account_of(s)) && Bool.not(M.named(account_of(t)))

def gen_follows(+s: M.P, +t: M.P) -> Bool:
  Nat.is_eq(gen_of(t), Bool.pick(Nat, cleared(s, t), 1n+gen_of(s), gen_of(s)))

# A named account is the same account after the step, or none is named.
def not_repointed(+s: M.P, +t: M.P) -> Bool:
  imp(M.named(account_of(s)), same_nat(account_of(s), account_of(t)) || Bool.not(M.named(account_of(t))))

# Why a retire by `by` handing to `hand` retires the account `s` names: the
# holder named an owner or no one; another owner retired a seated holder's
# account; or no current owner holds it.
def standing(+s: M.P, +by: Nat, hand: Maybe<&2, Nat>) -> M.Reason:
  Bool.pick(M.Reason, M.is_at(holder_of(s), by),
    Bool.pick(M.Reason, M.named(hand), M.HandedOver{}, M.Disconnected{}),
    Bool.pick(M.Reason, M.absent(s), M.HolderAbsent{}, M.Replaced{}))

def newest_is(+s: M.P, +by: Nat, +hand: Maybe<&2, Nat>, recs: +List<M.Rec>) -> Bool:
  match recs:
    case Nil{}:
      False{}
    case M.Rec{x, r, rel} <> rest:
      ((M.is_at(account_of(s), x) && same_reason(r, standing(s, by, hand))) && Bool.not(rel))
        && Nat.is_eq(List.length(&2, M.Rec, rest), count(s))

# The newest record names the account `s` named, with the reason the
# caller's standing gives, unreleased, and is the only one added.
def newest_fits(+s: M.P, e: M.Ev, +recs: +List<M.Rec>) -> Bool:
  match e:
    case M.Connect{by, a, g, c}:
      False{}
    case M.Join{by, a, c}:
      False{}
    case M.Retire{by, hand, read, g}:
      newest_is(s, by, hand, recs)
    case M.Detach{a}:
      False{}
    case M.Update{a, c}:
      False{}
    case M.Gifts{on}:
      False{}
    case M.Add{q, r}:
      False{}
    case M.Remove{q}:
      False{}
    case M.SetRole{q, r}:
      False{}
    case M.Discard{by}:
      False{}
    case M.Revive{q}:
      False{}
    case M.Erase{ps}:
      False{}

# A retire that cleared the account added one record for it; any other step
# added none.
def records_follow(+s: M.P, +e: M.Ev, +t: M.P) -> Bool:
  Bool.pick(Bool, is_retire(e) && cleared(s, t), newest_fits(s, e, retired_of(t)), Nat.is_eq(count(t), count(s)))

# The caller read the account the wedding names, at its generation.
def read_fresh(+s: M.P, +read: Maybe<&2, Nat>, +g: Nat) -> Bool:
  (M.named(read) && same_nat(account_of(s), read)) && Nat.is_eq(g, gen_of(s))

# `by` holds an owner seat on the live wedding.
def owns_live(+s: M.P, +by: Nat) -> Bool:
  live_of(s) && M.owns(by, seats_of(s))

# `by` holds the account and `h` is another current owner.
def hand_fits(+s: M.P, +by: Nat, +h: Nat) -> Bool:
  (M.is_at(holder_of(s), by) && Bool.not(Nat.is_eq(h, by))) && M.owns(h, seats_of(s))

# The holder's seat
# -----------------

# `q` holds the account the wedding names.
def holds(+s: M.P, +q: Nat) -> Bool:
  M.named(account_of(s)) && M.is_at(holder_of(s), q)

def holds_seated(+s: M.P, +q: Nat) -> Bool:
  holds(s, q) && M.owns(q, seats_of(s))

def kept_or_gone(+t: M.P, +q: Nat) -> Bool:
  M.owns(q, seats_of(t)) || Bool.not(holds(t, q))

# The switch
# ----------

def turned_on(+s: M.P, +t: M.P) -> Bool:
  Bool.not(gifts_of(s)) && gifts_of(t)

def ready(+s: M.P) -> Bool:
  Bool.not(M.absent(s)) && charges_of(s)

# Erasure
# -------

def in_profiles(h: Maybe<&2, Nat>, +ps: +List<Nat>) -> Bool:
  match h:
    case None{}:
      False{}
    case Some{p}:
      M.member(p, ps)

# The wedding names an account whose holder is one of the erased profiles.
def holder_in(+s: M.P, +ps: +List<Nat>) -> Bool:
  M.named(account_of(s)) && in_profiles(holder_of(s), ps)

# Money
# -----

def is_open(b: M.Block) -> Bool:
  match b:
    case M.Open{}:
      True{}
    case M.HolderGone{}:
      False{}
    case M.NotReady{}:
      False{}
    case M.GiftsOff{}:
      False{}

# Guests may give money only into a named account whose holder holds an owner
# seat, which Stripe lets take charges, with the switch on.
def backed(+s: M.P) -> Bool:
  (M.named(account_of(s)) && M.seated_holder(holder_of(s), seats_of(s))) && (charges_of(s) && gifts_of(s))

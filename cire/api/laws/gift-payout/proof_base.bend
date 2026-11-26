# The two outcomes of each event that may or may not write, one lemma per
# event, so each proof names the two states once. Each splits on the event's
# condition and hands its branch the evidence for it.

import Base
import ../../../../tools/bend/kit.bend as K
import ./payout.bend as M

# A connect carrying generation `g` on a wedding naming no account.
def connect_cases(-Q: M.P -> Type, +by: Nat, +a: Nat, +g: Nat, +c: Bool, +live: Bool, +ss: +List<M.Seat>,
  +holder: Maybe<&2, Nat>, +charges: Bool, +gifts: Bool, +gen: Nat, +recs: +List<M.Rec>,
  t: {True{} == ((live && M.owns(by, ss)) && Nat.is_eq(g, gen)) : Bool}
    -> Q(M.P{live, ss, Some{a}, Some{by}, c, gifts, gen, recs}),
  f: {False{} == ((live && M.owns(by, ss)) && Nat.is_eq(g, gen)) : Bool}
    -> Q(M.P{live, ss, None{}, holder, charges, gifts, gen, recs}))
  -> Q(M.step(M.P{live, ss, None{}, holder, charges, gifts, gen, recs}, M.Connect{by, a, g, c})):
  K.pick_split(M.P, Q, (live && M.owns(by, ss)) && Nat.is_eq(g, gen),
    M.P{live, ss, Some{a}, Some{by}, c, gifts, gen, recs},
    M.P{live, ss, None{}, holder, charges, gifts, gen, recs}, t, f)

# A connect with no generation on a wedding naming no account.
def join_cases(-Q: M.P -> Type, +by: Nat, +a: Nat, +c: Bool, +live: Bool, +ss: +List<M.Seat>,
  +holder: Maybe<&2, Nat>, +charges: Bool, +gifts: Bool, +gen: Nat, +recs: +List<M.Rec>,
  t: {True{} == (live && M.owns(by, ss)) : Bool}
    -> Q(M.P{live, ss, Some{a}, Some{by}, c, gifts, gen, recs}),
  f: {False{} == (live && M.owns(by, ss)) : Bool}
    -> Q(M.P{live, ss, None{}, holder, charges, gifts, gen, recs}))
  -> Q(M.step(M.P{live, ss, None{}, holder, charges, gifts, gen, recs}, M.Join{by, a, c})):
  K.pick_split(M.P, Q, live && M.owns(by, ss),
    M.P{live, ss, Some{a}, Some{by}, c, gifts, gen, recs},
    M.P{live, ss, None{}, holder, charges, gifts, gen, recs}, t, f)

def retire_cond(+by: Nat, +hand: Maybe<&2, Nat>, +read: Maybe<&2, Nat>, +g: Nat, +live: Bool, +ss: +List<M.Seat>, +b: Nat,
  +holder: Maybe<&2, Nat>, +gen: Nat) -> Bool:
  ((M.read_is(read, b) && Nat.is_eq(g, gen)) && (live && M.owns(by, ss))) && M.hand_ok(by, hand, holder, ss)

# A retire on a wedding naming account `b`.
def retire_cases(-Q: M.P -> Type, +by: Nat, +hand: Maybe<&2, Nat>, +read: Maybe<&2, Nat>, +g: Nat, +live: Bool, +ss: +List<M.Seat>, +b: Nat,
  +holder: Maybe<&2, Nat>, +charges: Bool, +gifts: Bool, +gen: Nat, +recs: +List<M.Rec>,
  t: {True{} == retire_cond(by, hand, read, g, live, ss, b, holder, gen) : Bool}
    -> Q(M.P{live, ss, None{}, None{}, False{}, gifts, 1n+gen, M.Rec{b, M.reason(by, hand, Some{b}, holder, ss), False{}} <> recs}),
  f: {False{} == retire_cond(by, hand, read, g, live, ss, b, holder, gen) : Bool}
    -> Q(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}))
  -> Q(M.step(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, M.Retire{by, hand, read, g})):
  K.pick_split(M.P, Q, retire_cond(by, hand, read, g, live, ss, b, holder, gen),
    M.P{live, ss, None{}, None{}, False{}, gifts, 1n+gen, M.Rec{b, M.reason(by, hand, Some{b}, holder, ss), False{}} <> recs},
    M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, t, f)

# A detach of `a` on a wedding naming account `b`.
def detach_cases(-Q: M.P -> Type, +a: Nat, +live: Bool, +ss: +List<M.Seat>, +b: Nat,
  +holder: Maybe<&2, Nat>, +charges: Bool, +gifts: Bool, +gen: Nat, +recs: +List<M.Rec>,
  t: {True{} == Nat.is_eq(b, a) : Bool} -> Q(M.P{live, ss, None{}, None{}, False{}, gifts, 1n+gen, M.release(a, recs)}),
  f: {False{} == Nat.is_eq(b, a) : Bool} -> Q(M.P{live, ss, Some{b}, holder, charges, gifts, gen, M.release(a, recs)}))
  -> Q(M.step(M.P{live, ss, Some{b}, holder, charges, gifts, gen, recs}, M.Detach{a})):
  K.pick_split(M.P, Q, Nat.is_eq(b, a),
    M.P{live, ss, None{}, None{}, False{}, gifts, 1n+gen, M.release(a, recs)},
    M.P{live, ss, Some{b}, holder, charges, gifts, gen, M.release(a, recs)}, t, f)

# The parts of a retire's condition.
def retire_fresh(+by: Nat, +hand: Maybe<&2, Nat>, +read: Maybe<&2, Nat>, +g: Nat, +live: Bool, +ss: +List<M.Seat>, +b: Nat,
  +holder: Maybe<&2, Nat>, +gen: Nat, q: {True{} == retire_cond(by, hand, read, g, live, ss, b, holder, gen) : Bool})
  -> K.T(M.read_is(read, b) && Nat.is_eq(g, gen)):
  K.and_l(M.read_is(read, b) && Nat.is_eq(g, gen), live && M.owns(by, ss),
    K.and_l((M.read_is(read, b) && Nat.is_eq(g, gen)) && (live && M.owns(by, ss)), M.hand_ok(by, hand, holder, ss),
      K.from_eq(retire_cond(by, hand, read, g, live, ss, b, holder, gen), q)))

def retire_owner(+by: Nat, +hand: Maybe<&2, Nat>, +read: Maybe<&2, Nat>, +g: Nat, +live: Bool, +ss: +List<M.Seat>, +b: Nat,
  +holder: Maybe<&2, Nat>, +gen: Nat, q: {True{} == retire_cond(by, hand, read, g, live, ss, b, holder, gen) : Bool})
  -> K.T(live && M.owns(by, ss)):
  K.and_r(M.read_is(read, b) && Nat.is_eq(g, gen), live && M.owns(by, ss),
    K.and_l((M.read_is(read, b) && Nat.is_eq(g, gen)) && (live && M.owns(by, ss)), M.hand_ok(by, hand, holder, ss),
      K.from_eq(retire_cond(by, hand, read, g, live, ss, b, holder, gen), q)))

def retire_hand(+by: Nat, +hand: Maybe<&2, Nat>, +read: Maybe<&2, Nat>, +g: Nat, +live: Bool, +ss: +List<M.Seat>, +b: Nat,
  +holder: Maybe<&2, Nat>, +gen: Nat, q: {True{} == retire_cond(by, hand, read, g, live, ss, b, holder, gen) : Bool})
  -> K.T(M.hand_ok(by, hand, holder, ss)):
  K.and_r((M.read_is(read, b) && Nat.is_eq(g, gen)) && (live && M.owns(by, ss)), M.hand_ok(by, hand, holder, ss),
    K.from_eq(retire_cond(by, hand, read, g, live, ss, b, holder, gen), q))

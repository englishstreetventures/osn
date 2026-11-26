# Proofs about one handle's hold.
#
# `Spec.unclaimed_while_held` holds in every reachable state: a hold that is
# live at the clock leaves the handle without an owner. A hold not live at
# one time is not live at any later one, so a step that only moves the clock
# keeps it.

import Base
import ../../../../tools/bend/kit.bend as K
import ./holds.bend as B
import ./SPEC.bend as Spec

# Not live at `c`, so not live at any later `t`.
def later(+h: B.Hold, +c: Nat, +t: Nat, le: K.T(Nat.is_le(c, t)), w: K.T(Bool.not(B.live(h, c))))
  -> K.T(Bool.not(B.live(h, t))):
  match h:
    case B.Free{}:
      Unit{}
    case B.Held{a}:
      w
    case B.Until{r}:
      K.bool_case(Nat.is_lt(t, r), x => K.T(Bool.not(x)),
        e => Empty.absurd(K.T(Bool.not(True{})),
          K.not_elim(Nat.is_lt(c, r), w,
            K.le_lt_lt(c, t, r, le, %e : K.T(_)
                                    Unit{}))),
        e => Unit{})

def keep_inv(+o: Maybe<&2, Nat>, +h: B.Hold, +c: Nat, +t: Nat, le: K.T(Nat.is_le(c, t)),
  w: K.T(Spec.unclaimed_while_held(B.H{o, h, c}))) -> K.T(Spec.unclaimed_while_held(B.H{o, h, t})):
  match o:
    case None{}:
      Unit{}
    case Some{x}:
      later(h, c, t, le, w)

# The hard delete on a held handle: it had no owner, and still has none.
def erase_inv(+h: B.Hold, +o: Maybe<&2, Nat>, +c: Nat, +a: Nat, +t: Nat,
  e: {True{} == B.held_for(h, a) : Bool}, w: K.T(Spec.unclaimed_while_held(B.H{o, h, c})))
  -> K.T(Spec.unclaimed_while_held(B.H{o, B.Until{Nat.add(t, B.thirty_days())}, t})):
  match h:
    case B.Free{}:
      Empty.absurd(K.T(Spec.unclaimed_while_held(B.H{o, B.Until{Nat.add(t, B.thirty_days())}, t})),
        %e : K.T(_)
        Unit{})
    case B.Held{x}:
      match o:
        case None{}:
          Unit{}
        case Some{y}:
          Empty.absurd(K.T(Spec.unclaimed_while_held(B.H{Some{y}, B.Until{Nat.add(t, B.thirty_days())}, t})), w)
    case B.Until{r}:
      Empty.absurd(K.T(Spec.unclaimed_while_held(B.H{o, B.Until{Nat.add(t, B.thirty_days())}, t})),
        %e : K.T(_)
        Unit{})

def step_inv(+s: B.H, +e: B.HEv, +w: K.T(Spec.unclaimed_while_held(s)))
  -> K.T(Spec.unclaimed_while_held(B.step(s, e))):
  match s:
    case B.H{o, h, c}:
      match e:
        case B.Delete{a, now}:
          K.pick_split(B.H, x => K.T(Spec.unclaimed_while_held(x)), B.owned_by(o, a),
            B.H{None{}, B.Held{a}, Nat.max(c, now)}, B.H{o, h, Nat.max(c, now)},
            q => Unit{},
            q => keep_inv(o, h, c, Nat.max(c, now), K.le_max_l(c, now), w))
        case B.Restore{a, now}:
          K.pick_split(B.H, x => K.T(Spec.unclaimed_while_held(x)), B.held_for(h, a),
            B.H{Bool.pick(Maybe<&2, Nat>, B.unowned(o), Some{a}, o), B.Free{}, Nat.max(c, now)},
            B.H{o, h, Nat.max(c, now)},
            q => K.or_r(B.unowned(Bool.pick(Maybe<&2, Nat>, B.unowned(o), Some{a}, o)), True{}, Unit{}),
            q => keep_inv(o, h, c, Nat.max(c, now), K.le_max_l(c, now), w))
        case B.Erase{a, now}:
          K.pick_split(B.H, x => K.T(Spec.unclaimed_while_held(x)), B.held_for(h, a),
            B.H{o, B.Until{Nat.add(Nat.max(c, now), B.thirty_days())}, Nat.max(c, now)},
            B.H{o, h, Nat.max(c, now)},
            q => erase_inv(h, o, c, a, Nat.max(c, now), q, w),
            q => keep_inv(o, h, c, Nat.max(c, now), K.le_max_l(c, now), w))
        case B.Claim{a, now}:
          K.pick_split(B.H, x => K.T(Spec.unclaimed_while_held(x)),
            B.unowned(o) && Bool.not(B.live(h, Nat.max(c, now))),
            B.H{Some{a}, h, Nat.max(c, now)}, B.H{o, h, Nat.max(c, now)},
            q => K.and_r(B.unowned(o), Bool.not(B.live(h, Nat.max(c, now))),
                   K.from_eq(B.unowned(o) && Bool.not(B.live(h, Nat.max(c, now))), q)),
            q => keep_inv(o, h, c, Nat.max(c, now), K.le_max_l(c, now), w))

def reach(es: List<B.HEv>, +s: B.H, +w: K.T(Spec.unclaimed_while_held(s)), -P: B.H -> Type,
  k: @x: B.H -> K.T(Spec.unclaimed_while_held(x)) -> P(x)) -> P(B.run(es, s)):
  match es:
    case Nil{}:
      k(s, w)
    case Con{+e, rest}:
      reach(rest, B.step(s, e), step_inv(s, e, w), P, k)

def held_eq(+s: B.H, +w: K.T(Spec.unclaimed_while_held(s))) -> {Spec.unclaimed_while_held(s) == True{} : Bool}:
  K.to_eq(Spec.unclaimed_while_held(s), w)

# B2
# --

# After the hard delete at `t`, the release is `T + 30 days` with
# `T = max(clock, t)`; a claim before it finds a live hold and no owner.
def claim_after_erase(+x: Nat, +a: Nat, +c: Nat, +t: Nat, +b: Nat, +u: Nat)
  -> {Spec.imp(Nat.is_eq(x, a) && Nat.is_lt(Nat.max(Spec.clock_of(Bool.pick(B.H, Nat.is_eq(x, a), B.H{None{}, B.Until{Nat.add(Nat.max(c, t), B.thirty_days())}, Nat.max(c, t)}, B.H{None{}, B.Held{x}, Nat.max(c, t)})), u), Nat.add(Spec.clock_of(Bool.pick(B.H, Nat.is_eq(x, a), B.H{None{}, B.Until{Nat.add(Nat.max(c, t), B.thirty_days())}, Nat.max(c, t)}, B.H{None{}, B.Held{x}, Nat.max(c, t)})), B.thirty_days())),
       B.unowned(Spec.owner_of(B.step(Bool.pick(B.H, Nat.is_eq(x, a), B.H{None{}, B.Until{Nat.add(Nat.max(c, t), B.thirty_days())}, Nat.max(c, t)}, B.H{None{}, B.Held{x}, Nat.max(c, t)}), B.Claim{b, u})))) == True{} : Bool}:
  K.bool_case(Nat.is_eq(x, a),
    y => {Spec.imp(y && Nat.is_lt(Nat.max(Spec.clock_of(Bool.pick(B.H, y, B.H{None{}, B.Until{Nat.add(Nat.max(c, t), B.thirty_days())}, Nat.max(c, t)}, B.H{None{}, B.Held{x}, Nat.max(c, t)})), u), Nat.add(Spec.clock_of(Bool.pick(B.H, y, B.H{None{}, B.Until{Nat.add(Nat.max(c, t), B.thirty_days())}, Nat.max(c, t)}, B.H{None{}, B.Held{x}, Nat.max(c, t)})), B.thirty_days())),
       B.unowned(Spec.owner_of(B.step(Bool.pick(B.H, y, B.H{None{}, B.Until{Nat.add(Nat.max(c, t), B.thirty_days())}, Nat.max(c, t)}, B.H{None{}, B.Held{x}, Nat.max(c, t)}), B.Claim{b, u})))) == True{} : Bool},
    q => K.bool_case(Nat.is_lt(Nat.max(Nat.max(c, t), u), Nat.add(Nat.max(c, t), B.thirty_days())),
      z => {Spec.imp(z, B.unowned(Spec.owner_of(Bool.pick(B.H, Bool.not(z), B.H{Some{b}, B.Until{Nat.add(Nat.max(c, t), B.thirty_days())}, Nat.max(Nat.max(c, t), u)}, B.H{None{}, B.Until{Nat.add(Nat.max(c, t), B.thirty_days())}, Nat.max(Nat.max(c, t), u)})))) == True{} : Bool},
      r => {==},
      r => {==}),
    q => {==})

def hold_thirty_days(+s: B.H, +a: Nat, +t: Nat, +b: Nat, +u: Nat, +w: K.T(Spec.unclaimed_while_held(s)))
  -> {Spec.imp(B.held_for(Spec.hold_of(s), a) && Nat.is_lt(Nat.max(Spec.clock_of(B.step(s, B.Erase{a, t})), u), Nat.add(Spec.clock_of(B.step(s, B.Erase{a, t})), B.thirty_days())),
       B.unowned(Spec.owner_of(B.step(B.step(s, B.Erase{a, t}), B.Claim{b, u})))) == True{} : Bool}:
  match s:
    case B.H{o, h, c}:
      match o:
        case None{}:
          match h:
            case B.Free{}:
              {==}
            case B.Held{x}:
              claim_after_erase(x, a, c, t, b, u)
            case B.Until{r}:
              {==}
        case Some{y}:
          match h:
            case B.Free{}:
              {==}
            case B.Held{x}:
              Empty.absurd({Spec.imp(Nat.is_eq(x, a) && Nat.is_lt(Nat.max(Spec.clock_of(B.step(B.H{Some{y}, B.Held{x}, c}, B.Erase{a, t})), u), Nat.add(Spec.clock_of(B.step(B.H{Some{y}, B.Held{x}, c}, B.Erase{a, t})), B.thirty_days())),
                B.unowned(Spec.owner_of(B.step(B.step(B.H{Some{y}, B.Held{x}, c}, B.Erase{a, t}), B.Claim{b, u})))) == True{} : Bool}, w)
            case B.Until{r}:
              {==}

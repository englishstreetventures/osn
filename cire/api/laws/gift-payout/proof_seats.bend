# Lemmas about a wedding's seats: who still holds an owner seat after a seat
# is added, removed or given a role.

import Base
import ../../../../tools/bend/kit.bend as K
import ./payout.bend as M

def eq_sym(+a: Nat, +b: Nat, w: K.T(Nat.is_eq(a, b))) -> K.T(Nat.is_eq(b, a)):
  match a:
    case 0n:
      match b:
        case 0n:
          Unit{}
        case 1n+bp:
          w
    case 1n+ap:
      match b:
        case 0n:
          w
        case 1n+bp:
          eq_sym(ap, bp, w)

# p == q and p == h give q == h.
def eq_trans(+p: Nat, +q: Nat, +h: Nat, a: K.T(Nat.is_eq(p, q)), b: K.T(Nat.is_eq(p, h))) -> K.T(Nat.is_eq(q, h)):
  match p:
    case 0n:
      match q:
        case 0n:
          b
        case 1n+qp:
          Empty.absurd(K.T(Nat.is_eq(1n+qp, h)), a)
    case 1n+pp:
      match q:
        case 0n:
          Empty.absurd(K.T(Nat.is_eq(0n, h)), a)
        case 1n+qp:
          match h:
            case 0n:
              Empty.absurd(K.T(Nat.is_eq(1n+qp, 0n)), b)
            case 1n+hp:
              eq_trans(pp, qp, hp, a, b)

# x == p and p == q give x == q.
def eq_chain(+x: Nat, +p: Nat, +q: Nat, a: K.T(Nat.is_eq(x, p)), b: K.T(Nat.is_eq(p, q))) -> K.T(Nat.is_eq(x, q)):
  eq_trans(p, x, q, eq_sym(x, p, a), b)

# An owner seat of `p` is an owner seat of any `q` equal to it.
def owns_eq(+p: Nat, +q: Nat, +ss: +List<M.Seat>, +e: K.T(Nat.is_eq(p, q)), w: K.T(M.owns(p, ss))) -> K.T(M.owns(q, ss)):
  match ss:
    case Nil{}:
      w
    case M.Seat{x, r} <> rest:
      K.bool_case(Nat.is_eq(x, p),
        y => K.T((y && M.is_owner(r)) || M.owns(p, rest)) -> K.T(M.owns(q, M.Seat{x, r} <> rest)),
        exp => v => K.bool_case(M.is_owner(r),
          z => K.T(z || M.owns(p, rest)) -> K.T((Nat.is_eq(x, q) && z) || M.owns(q, rest)),
          eo => u => K.or_l(Nat.is_eq(x, q) && True{}, M.owns(q, rest),
            K.and_intro(Nat.is_eq(x, q), True{}, eq_chain(x, p, q, K.from_eq(Nat.is_eq(x, p), exp), e), Unit{})),
          eo => u => K.or_r(Nat.is_eq(x, q) && False{}, M.owns(q, rest), owns_eq(p, q, rest, e, u)))(v),
        exp => v => K.or_r(Nat.is_eq(x, q) && M.is_owner(r), M.owns(q, rest), owns_eq(p, q, rest, e, v)))(w)

# Removing another profile's seats keeps `h`'s owner seat.
def owns_without(+h: Nat, +q: Nat, +ss: +List<M.Seat>, +n: K.T(Bool.not(Nat.is_eq(h, q))), w: K.T(M.owns(h, ss)))
  -> K.T(M.owns(h, M.without(q, ss))):
  match ss:
    case Nil{}:
      w
    case M.Seat{p, r} <> rest:
      K.bool_case(Nat.is_eq(p, q),
        y => K.T(M.owns(h, M.Seat{p, r} <> rest))
          -> K.T(M.owns(h, Bool.pick(+List<M.Seat>, y, M.without(q, rest), M.Seat{p, r} <> M.without(q, rest)))),
        epq => v => K.bool_case(Nat.is_eq(p, h),
          y => K.T((y && M.is_owner(r)) || M.owns(h, rest)) -> K.T(M.owns(h, M.without(q, rest))),
          eph => u => Empty.absurd(K.T(M.owns(h, M.without(q, rest))),
            K.not_elim(Nat.is_eq(h, q), n,
              eq_trans(p, h, q, K.from_eq(Nat.is_eq(p, h), eph), K.from_eq(Nat.is_eq(p, q), epq)))),
          eph => u => owns_without(h, q, rest, n, u))(v),
        epq => v => K.or_map(Nat.is_eq(p, h) && M.is_owner(r), M.owns(h, rest), M.owns(h, M.without(q, rest)), v,
          o => owns_without(h, q, rest, n, o)))(w)

# Making `q` an owner keeps every owner seat.
def owns_promote(+h: Nat, +q: Nat, +ss: +List<M.Seat>, w: K.T(M.owns(h, ss)))
  -> K.T(M.owns(h, M.set_role(q, M.Owner{}, ss))):
  match ss:
    case Nil{}:
      w
    case M.Seat{p, r} <> rest:
      K.bool_case(Nat.is_eq(p, q),
        y => K.T(M.owns(h, M.Seat{p, r} <> rest))
          -> K.T(M.owns(h, Bool.pick(M.Seat, y, M.Seat{p, M.Owner{}}, M.Seat{p, r}) <> M.set_role(q, M.Owner{}, rest))),
        epq => v => K.bool_case(Nat.is_eq(p, h),
          y => K.T((y && M.is_owner(r)) || M.owns(h, rest))
            -> K.T((y && True{}) || M.owns(h, M.set_role(q, M.Owner{}, rest))),
          eph => u => Unit{},
          eph => u => owns_promote(h, q, rest, u))(v),
        epq => v => K.or_map(Nat.is_eq(p, h) && M.is_owner(r), M.owns(h, rest), M.owns(h, M.set_role(q, M.Owner{}, rest)), v,
          o => owns_promote(h, q, rest, o)))(w)

# Giving another profile a role keeps `h`'s owner seat.
def owns_set_other(+h: Nat, +q: Nat, +r2: M.Role, +ss: +List<M.Seat>, +n: K.T(Bool.not(Nat.is_eq(h, q))), w: K.T(M.owns(h, ss)))
  -> K.T(M.owns(h, M.set_role(q, r2, ss))):
  match ss:
    case Nil{}:
      w
    case M.Seat{p, r} <> rest:
      K.bool_case(Nat.is_eq(p, q),
        y => K.T(M.owns(h, M.Seat{p, r} <> rest))
          -> K.T(M.owns(h, Bool.pick(M.Seat, y, M.Seat{p, r2}, M.Seat{p, r}) <> M.set_role(q, r2, rest))),
        epq => v => K.bool_case(Nat.is_eq(p, h),
          y => K.T((y && M.is_owner(r)) || M.owns(h, rest))
            -> K.T((y && M.is_owner(r2)) || M.owns(h, M.set_role(q, r2, rest))),
          eph => u => Empty.absurd(K.T((True{} && M.is_owner(r2)) || M.owns(h, M.set_role(q, r2, rest))),
            K.not_elim(Nat.is_eq(h, q), n,
              eq_trans(p, h, q, K.from_eq(Nat.is_eq(p, h), eph), K.from_eq(Nat.is_eq(p, q), epq)))),
          eph => u => owns_set_other(h, q, r2, rest, n, u))(v),
        epq => v => K.or_map(Nat.is_eq(p, h) && M.is_owner(r), M.owns(h, rest), M.owns(h, M.set_role(q, r2, rest)), v,
          o => owns_set_other(h, q, r2, rest, n, o)))(w)

# `False == b` gives `not b`.
def from_false(+b: Bool, e: {False{} == b : Bool}) -> K.T(Bool.not(b)):
  match b:
    case True{}:
      %e : K.T(Bool.not(_))
      Unit{}
    case False{}:
      Unit{}

# `a` implies `b` gives `not not a` implies `not not b`.
def imp_nn(+a: Bool, +b: Bool, f: K.T(a) -> K.T(b)) -> K.T(Bool.not(Bool.not(Bool.not(a))) || Bool.not(Bool.not(b))):
  match a:
    case True{}:
      K.nn_intro(b, f(Unit{}))
    case False{}:
      Unit{}

# The holder's owner seat survives a new seat.
def sh_add(+holder: Maybe<&2, Nat>, +q: Nat, +r: M.Role, +ss: +List<M.Seat>, w: K.T(M.seated_holder(holder, ss)))
  -> K.T(M.seated_holder(holder, M.Seat{q, r} <> ss)):
  match holder:
    case None{}:
      w
    case Some{p}:
      K.or_r(Nat.is_eq(q, p) && M.is_owner(r), M.owns(p, ss), w)

# The holder's owner seat survives a removal the holder rule let through.
def sh_remove(+holder: Maybe<&2, Nat>, +q: Nat, +ss: +List<M.Seat>,
  g: K.T(Bool.not(M.owns(q, ss) && M.is_at(holder, q))), +w: K.T(M.seated_holder(holder, ss)))
  -> K.T(M.seated_holder(holder, M.without(q, ss))):
  match holder:
    case None{}:
      w
    case Some{+p}:
      K.bool_case(Nat.is_eq(p, q),
        y => K.T(Bool.not(M.owns(q, ss) && y)) -> K.T(M.owns(p, M.without(q, ss))),
        e => v => Empty.absurd(K.T(M.owns(p, M.without(q, ss))),
          K.not_elim(M.owns(q, ss) && True{}, v,
            K.and_intro(M.owns(q, ss), True{}, owns_eq(p, q, ss, K.from_eq(Nat.is_eq(p, q), e), w), Unit{}))),
        e => v => owns_without(p, q, ss, from_false(Nat.is_eq(p, q), e), w))(g)

# The holder moved to role `r` by a change the holder rule let through: `r`
# is the owner's role.
def sh_self_role(+p: Nat, +q: Nat, +r: M.Role, +ss: +List<M.Seat>, +e: K.T(Nat.is_eq(p, q)),
  g: K.T(Bool.not((M.owns(q, ss) && True{}) && Bool.not(M.is_owner(r)))), +w: K.T(M.owns(p, ss)))
  -> K.T(M.owns(p, M.set_role(q, r, ss))):
  match r:
    case M.Owner{}:
      owns_promote(p, q, ss, w)
    case M.Editor{}:
      Empty.absurd(K.T(M.owns(p, M.set_role(q, M.Editor{}, ss))),
        K.not_elim((M.owns(q, ss) && True{}) && True{}, g,
          K.and_intro(M.owns(q, ss) && True{}, True{},
            K.and_intro(M.owns(q, ss), True{}, owns_eq(p, q, ss, e, w), Unit{}), Unit{})))

# The holder's owner seat survives a role change the holder rule let through.
def sh_set_role(+holder: Maybe<&2, Nat>, +q: Nat, +r: M.Role, +ss: +List<M.Seat>,
  g: K.T(Bool.not((M.owns(q, ss) && M.is_at(holder, q)) && Bool.not(M.is_owner(r)))), +w: K.T(M.seated_holder(holder, ss)))
  -> K.T(M.seated_holder(holder, M.set_role(q, r, ss))):
  match holder:
    case None{}:
      w
    case Some{+p}:
      K.bool_case(Nat.is_eq(p, q),
        y => K.T(Bool.not((M.owns(q, ss) && y) && Bool.not(M.is_owner(r)))) -> K.T(M.owns(p, M.set_role(q, r, ss))),
        e => v => sh_self_role(p, q, r, ss, K.from_eq(Nat.is_eq(p, q), e), v, w),
        e => v => owns_set_other(p, q, r, ss, from_false(Nat.is_eq(p, q), e), w))(g)

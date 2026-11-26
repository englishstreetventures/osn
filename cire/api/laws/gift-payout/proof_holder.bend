# Proofs about the account's holder: only an erasure leaves the account held
# by someone who is not an owner, so the holder's owner seat stays while they
# hold it.

import Base
import ../../../../tools/bend/kit.bend as K
import ./payout.bend as M
import ./SPEC.bend as Spec
import ./proof_base.bend as PB
import ./proof_seats.bend as PS

# Not absent before, not absent after: the step's own case.
def nn_same(+x: Bool) -> K.T(Spec.imp(Bool.not(Bool.not(x)), Bool.not(Bool.not(x)))):
  K.excluded(Bool.not(Bool.not(x)))

def to_none(+x: Bool) -> K.T(Spec.imp(x, True{})):
  K.or_r(Bool.not(x), True{}, Unit{})

def seated_step(+s: M.P, +e: M.Ev) -> K.T(Spec.imp(Spec.not_erase(e) && Bool.not(M.absent(s)), Bool.not(M.absent(M.step(s, e))))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          match e:
            case M.Connect{by, a, g, c}:
              PB.connect_cases(x => K.T(Bool.not(M.absent(x))), by, a, g, c, live, ss, holder, charges, gifts, gen, recs,
                q => K.nn_intro(M.owns(by, ss),
                  K.and_r(live, M.owns(by, ss),
                    K.and_l(live && M.owns(by, ss), Nat.is_eq(g, gen),
                      K.from_eq((live && M.owns(by, ss)) && Nat.is_eq(g, gen), q)))),
                q => Unit{})
            case M.Join{by, a, c}:
              PB.join_cases(x => K.T(Bool.not(M.absent(x))), by, a, c, live, ss, holder, charges, gifts, gen, recs,
                q => K.nn_intro(M.owns(by, ss), K.and_r(live, M.owns(by, ss), K.from_eq(live && M.owns(by, ss), q))),
                q => Unit{})
            case M.Retire{by, hand, read, g}:
              Unit{}
            case M.Detach{a}:
              Unit{}
            case M.Update{a, c}:
              Unit{}
            case M.Gifts{on}:
              match on:
                case True{}:
                  Unit{}
                case False{}:
                  Unit{}
            case M.Add{q, r}:
              Unit{}
            case M.Remove{q}:
              Unit{}
            case M.SetRole{q, r}:
              Unit{}
            case M.Discard{by}:
              Unit{}
            case M.Revive{q}:
              Unit{}
            case M.Erase{ps}:
              Unit{}
        case Some{b}:
          match e:
            case M.Connect{by, a, g, c}:
              nn_same(M.seated_holder(holder, ss))
            case M.Join{by, a, c}:
              nn_same(M.seated_holder(holder, ss))
            case M.Retire{by, hand, read, g}:
              PB.retire_cases(x => K.T(Spec.imp(Bool.not(Bool.not(M.seated_holder(holder, ss))), Bool.not(M.absent(x)))),
                by, hand, read, g, live, ss, b, holder, charges, gifts, gen, recs,
                q => to_none(Bool.not(Bool.not(M.seated_holder(holder, ss)))),
                q => nn_same(M.seated_holder(holder, ss)))
            case M.Detach{a}:
              PB.detach_cases(x => K.T(Spec.imp(Bool.not(Bool.not(M.seated_holder(holder, ss))), Bool.not(M.absent(x)))),
                a, live, ss, b, holder, charges, gifts, gen, recs,
                q => to_none(Bool.not(Bool.not(M.seated_holder(holder, ss)))),
                q => nn_same(M.seated_holder(holder, ss)))
            case M.Update{a, c}:
              nn_same(M.seated_holder(holder, ss))
            case M.Gifts{on}:
              match on:
                case True{}:
                  nn_same(M.seated_holder(holder, ss))
                case False{}:
                  nn_same(M.seated_holder(holder, ss))
            case M.Add{q, r}:
              K.pick_split(+List<M.Seat>,
                y => K.T(Spec.imp(Bool.not(Bool.not(M.seated_holder(holder, ss))), Bool.not(Bool.not(M.seated_holder(holder, y))))),
                live && Bool.not(M.seated(q, ss)), M.Seat{q, r} <> ss, ss,
                k => PS.imp_nn(M.seated_holder(holder, ss), M.seated_holder(holder, M.Seat{q, r} <> ss),
                  w => PS.sh_add(holder, q, r, ss, w)),
                k => nn_same(M.seated_holder(holder, ss)))
            case M.Remove{q}:
              K.pick_split(+List<M.Seat>,
                y => K.T(Spec.imp(Bool.not(Bool.not(M.seated_holder(holder, ss))), Bool.not(Bool.not(M.seated_holder(holder, y))))),
                (live && M.has_owner(M.without(q, ss))) && Bool.not(M.owns(q, ss) && M.is_at(holder, q)),
                M.without(q, ss), ss,
                k => PS.imp_nn(M.seated_holder(holder, ss), M.seated_holder(holder, M.without(q, ss)),
                  w => PS.sh_remove(holder, q, ss,
                    K.and_r(live && M.has_owner(M.without(q, ss)), Bool.not(M.owns(q, ss) && M.is_at(holder, q)),
                      K.from_eq((live && M.has_owner(M.without(q, ss))) && Bool.not(M.owns(q, ss) && M.is_at(holder, q)), k)),
                    w)),
                k => nn_same(M.seated_holder(holder, ss)))
            case M.SetRole{q, r}:
              K.pick_split(+List<M.Seat>,
                y => K.T(Spec.imp(Bool.not(Bool.not(M.seated_holder(holder, ss))), Bool.not(Bool.not(M.seated_holder(holder, y))))),
                (live && M.has_owner(M.set_role(q, r, ss))) && Bool.not((M.owns(q, ss) && M.is_at(holder, q)) && Bool.not(M.is_owner(r))),
                M.set_role(q, r, ss), ss,
                k => PS.imp_nn(M.seated_holder(holder, ss), M.seated_holder(holder, M.set_role(q, r, ss)),
                  w => PS.sh_set_role(holder, q, r, ss,
                    K.and_r(live && M.has_owner(M.set_role(q, r, ss)), Bool.not((M.owns(q, ss) && M.is_at(holder, q)) && Bool.not(M.is_owner(r))),
                      K.from_eq((live && M.has_owner(M.set_role(q, r, ss))) && Bool.not((M.owns(q, ss) && M.is_at(holder, q)) && Bool.not(M.is_owner(r))), k)),
                    w)),
                k => nn_same(M.seated_holder(holder, ss)))
            case M.Discard{by}:
              nn_same(M.seated_holder(holder, ss))
            case M.Revive{q}:
              nn_same(M.seated_holder(holder, ss))
            case M.Erase{ps}:
              Unit{}

# The holder of the account, in an owner seat, is not absent.
def seated_not_absent(+s: M.P, +q: Nat, +w: K.T(Spec.holds_seated(s, q))) -> K.T(Bool.not(M.absent(s))):
  match s:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          Unit{}
        case Some{b}:
          match holder:
            case None{}:
              w
            case Some{p}:
              K.nn_intro(M.owns(p, ss),
                PS.owns_eq(q, p, ss,
                  PS.eq_sym(p, q, K.and_l(Nat.is_eq(p, q), M.owns(q, ss), w)),
                  K.and_r(Nat.is_eq(p, q), M.owns(q, ss), w)))

# With the holder not absent, whoever holds the account has an owner seat.
def kept_from(+t: M.P, +q: Nat, nab: K.T(Bool.not(M.absent(t)))) -> K.T(Spec.kept_or_gone(t, q)):
  match t:
    case M.P{live, ss, account, holder, charges, gifts, gen, recs}:
      match account:
        case None{}:
          K.or_r(M.owns(q, ss), True{}, Unit{})
        case Some{b}:
          match holder:
            case None{}:
              Empty.absurd(K.T(M.owns(q, ss) || True{}), nab)
            case Some{+p}:
              K.bool_case(Nat.is_eq(p, q),
                y => K.T(M.owns(q, ss) || Bool.not(y)),
                e => K.or_l(M.owns(q, ss), False{},
                  PS.owns_eq(p, q, ss, K.from_eq(Nat.is_eq(p, q), e), K.not_not(M.owns(p, ss), nab))),
                e => K.or_r(M.owns(q, ss), True{}, Unit{}))

def seat_kept(+s: M.P, +e: M.Ev, +q: Nat)
  -> K.T(Spec.imp(Spec.not_erase(e) && Spec.holds_seated(s, q), Spec.kept_or_gone(M.step(s, e), q))):
  K.imp_intro(Spec.not_erase(e) && Spec.holds_seated(s, q), Spec.kept_or_gone(M.step(s, e), q),
    +w => kept_from(M.step(s, e), q,
      K.imp_elim(Spec.not_erase(e) && Bool.not(M.absent(s)), Bool.not(M.absent(M.step(s, e))),
        seated_step(s, e),
        K.and_intro(Spec.not_erase(e), Bool.not(M.absent(s)),
          K.and_l(Spec.not_erase(e), Spec.holds_seated(s, q), w),
          seated_not_absent(s, q, K.and_r(Spec.not_erase(e), Spec.holds_seated(s, q), w))))))

# Each payout field equals itself, so a step that writes nothing changes no
# payout field.

import Base
import ../../../../tools/bend/kit.bend as K
import ./payout.bend as M
import ./SPEC.bend as Spec

def same_nat_refl(+m: Maybe<&2, Nat>) -> K.T(Spec.same_nat(m, m)):
  match m:
    case None{}:
      Unit{}
    case Some{a}:
      K.eq_refl(a)

def same_bool_refl(+b: Bool) -> K.T(Spec.same_bool(b, b)):
  match b:
    case True{}:
      Unit{}
    case False{}:
      Unit{}

def same_refl(+live: Bool, +ss: +List<M.Seat>, +account: Maybe<&2, Nat>, +holder: Maybe<&2, Nat>,
  +charges: Bool, +gifts: Bool, +gen: Nat, +recs: +List<M.Rec>)
  -> K.T(Spec.payout_same(M.P{live, ss, account, holder, charges, gifts, gen, recs}, M.P{live, ss, account, holder, charges, gifts, gen, recs})):
  K.and_intro(
    (Spec.same_nat(account, account) && Spec.same_nat(holder, holder)) && (Spec.same_bool(charges, charges) && Spec.same_bool(gifts, gifts)),
    Nat.is_eq(gen, gen) && Nat.is_eq(List.length(&2, M.Rec, recs), List.length(&2, M.Rec, recs)),
    K.and_intro(Spec.same_nat(account, account) && Spec.same_nat(holder, holder), Spec.same_bool(charges, charges) && Spec.same_bool(gifts, gifts),
      K.and_intro(Spec.same_nat(account, account), Spec.same_nat(holder, holder), same_nat_refl(account), same_nat_refl(holder)),
      K.and_intro(Spec.same_bool(charges, charges), Spec.same_bool(gifts, gifts), same_bool_refl(charges), same_bool_refl(gifts))),
    K.and_intro(Nat.is_eq(gen, gen), Nat.is_eq(List.length(&2, M.Rec, recs), List.length(&2, M.Rec, recs)),
      K.eq_refl(gen), K.eq_refl(List.length(&2, M.Rec, recs))))

# A detach releases records and removes none.
def len_release(+a: Nat, +rs: +List<M.Rec>)
  -> K.T(Nat.is_eq(List.length(&2, M.Rec, M.release(a, rs)), List.length(&2, M.Rec, rs))):
  match rs:
    case Nil{}:
      Unit{}
    case r <> rest:
      len_release(a, rest)

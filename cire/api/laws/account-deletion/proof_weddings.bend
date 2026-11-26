# Proofs about one cire wedding. The law that ties its preview to osn-api's
# verdict, sole_owner_blocks_deletion, is proved with osn-api's laws
# (osn/api/laws/account-deletion/proof_sole_owner.bend).
#
# `Spec.owner_if_live` holds in every reachable state: each host change goes
# through only while an owner remains, an erasure deletes a wedding it leaves
# without an owner, and a restore needs an owner seat.

import Base
import ../../../../tools/bend/kit.bend as K
import ./weddings.bend as D
import ./SPEC.bend as Spec

# D1
# --

# A profile with an owner seat means the wedding has an owner.
def owns_has(+q: Nat, +ss: +List<D.Seat>, +w: K.T(D.owns(q, ss))) -> K.T(D.has_owner(ss)):
  match ss:
    case Nil{}:
      w
    case D.Seat{p, a, r} <> rest:
      match r:
        case D.Owner{}:
          Unit{}
        case D.Editor{}:
          owns_has(q, rest, K.drop_false_and(Nat.is_eq(p, q), D.owns(q, rest), w))
        case D.Viewer{}:
          owns_has(q, rest, K.drop_false_and(Nat.is_eq(p, q), D.owns(q, rest), w))
        case D.Helper{}:
          owns_has(q, rest, K.drop_false_and(Nat.is_eq(p, q), D.owns(q, rest), w))

def step_inv(+w: D.W, +e: D.WEv, +h: K.T(Spec.owner_if_live(w))) -> K.T(Spec.owner_if_live(D.step(w, e))):
  match w:
    case D.W{live, ss}:
      match live:
        case True{}:
          match e:
            case D.Add{q, a, r}:
              K.pick_split(+List<D.Seat>, x => K.T(D.has_owner(x)), D.seated(q, ss),
                ss, D.Seat{q, a, r} <> ss,
                t => h,
                f => K.or_r(D.is_owner(r), D.has_owner(ss), h))
            case D.Remove{q}:
              K.pick_split(+List<D.Seat>, x => K.T(D.has_owner(x)), D.has_owner(D.without(q, ss)),
                D.without(q, ss), ss,
                t => K.from_eq(D.has_owner(D.without(q, ss)), t),
                f => h)
            case D.SetRole{q, r}:
              K.pick_split(+List<D.Seat>, x => K.T(D.has_owner(x)), D.has_owner(D.set_role(q, r, ss)),
                D.set_role(q, r, ss), ss,
                t => K.from_eq(D.has_owner(D.set_role(q, r, ss)), t),
                f => h)
            case D.EraseAcct{a}:
              K.excluded(D.has_owner(D.erase_seats(a, ss)))
            case D.Discard{}:
              Unit{}
            case D.Revive{q}:
              h
        case False{}:
          match e:
            case D.Add{q, a, r}:
              Unit{}
            case D.Remove{q}:
              Unit{}
            case D.SetRole{q, r}:
              Unit{}
            case D.EraseAcct{a}:
              Unit{}
            case D.Discard{}:
              Unit{}
            case D.Revive{q}:
              K.imp_intro(D.owns(q, ss), D.has_owner(ss), o => owns_has(q, ss, o))

def run_inv(es: List<D.WEv>, +w: D.W, +h: K.T(Spec.owner_if_live(w)))
  -> {Spec.owner_if_live(D.run(es, w)) == True{} : Bool}:
  match es:
    case Nil{}:
      K.to_eq(Spec.owner_if_live(w), h)
    case Con{+e, rest}:
      run_inv(rest, D.step(w, e), step_inv(w, e, h))

# D2
# --

def erase_owns(+acct: Nat, +q: Nat, +ss: +List<D.Seat>, w: K.T(D.owns(q, D.erase_seats(acct, ss))))
  -> K.T(D.owns(q, ss)):
  match ss:
    case Nil{}:
      w
    case D.Seat{p, a, r} <> rest:
      K.bool_case(Nat.is_eq(a, acct),
        y => K.T(D.owns(q, Bool.pick(+List<D.Seat>, y, D.erase_seats(acct, rest), D.Seat{p, a, r} <> D.erase_seats(acct, rest))))
          -> K.T(D.owns(q, D.Seat{p, a, r} <> rest)),
        e => v => K.or_r(Nat.is_eq(p, q) && D.is_owner(r), D.owns(q, rest), erase_owns(acct, q, rest, v)),
        e => v => K.or_map(Nat.is_eq(p, q) && D.is_owner(r), D.owns(q, D.erase_seats(acct, rest)), D.owns(q, rest), v,
          o => erase_owns(acct, q, rest, o)))(w)

def promotes_eq(+acct: Nat, +q: Nat, +ss: +List<D.Seat>)
  -> {Spec.imp(D.owns(q, D.erase_seats(acct, ss)), D.owns(q, ss)) == True{} : Bool}:
  K.to_eq(Spec.imp(D.owns(q, D.erase_seats(acct, ss)), D.owns(q, ss)),
    K.imp_intro(D.owns(q, D.erase_seats(acct, ss)), D.owns(q, ss), w => erase_owns(acct, q, ss, w)))

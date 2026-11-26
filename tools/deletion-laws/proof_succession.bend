# Proofs about who an organisation passes to.

import Base
import ./kit.bend as K
import ./succession.bend as E
import ./SPEC.bend as Spec

# E1
# --

# A member found further down the list is still a member of the whole list.
def fits_cons(+m: Maybe<&2, Nat>, +gone: Nat, +p: Nat, +a: Nat, +r: E.Rank, +rest: +List<E.Mem>,
  w: K.T(Spec.fits(m, gone, rest))) -> K.T(Spec.fits(m, gone, E.Mem{p, a, r} <> rest)):
  match m:
    case None{}:
      Unit{}
    case Some{q}:
      K.or_r(Nat.is_eq(p, q) && Bool.not(Nat.is_eq(a, gone)), E.eligible(q, gone, rest), w)

def first_fits(+admins: Bool, +gone: Nat, +ms: +List<E.Mem>) -> K.T(Spec.fits(E.first(admins, gone, ms), gone, ms)):
  match ms:
    case Nil{}:
      Unit{}
    case E.Mem{p, a, r} <> rest:
      K.pick_split(Maybe<&2, Nat>, x => K.T(Spec.fits(x, gone, E.Mem{p, a, r} <> rest)),
        Bool.not(Nat.is_eq(a, gone)) && (Bool.not(admins) || E.is_admin(r)),
        Some{p}, E.first(admins, gone, rest),
        q => K.or_l(Nat.is_eq(p, p) && Bool.not(Nat.is_eq(a, gone)), E.eligible(p, gone, rest),
               K.and_intro(Nat.is_eq(p, p), Bool.not(Nat.is_eq(a, gone)), K.eq_refl(p),
                 K.and_l(Bool.not(Nat.is_eq(a, gone)), Bool.not(admins) || E.is_admin(r),
                   K.from_eq(Bool.not(Nat.is_eq(a, gone)) && (Bool.not(admins) || E.is_admin(r)), q)))),
        q => fits_cons(E.first(admins, gone, rest), gone, p, a, r, rest, first_fits(admins, gone, rest)))

def or_else_fits(+x: Maybe<&2, Nat>, +y: Maybe<&2, Nat>, +gone: Nat, +ms: +List<E.Mem>,
  wx: K.T(Spec.fits(x, gone, ms)), wy: K.T(Spec.fits(y, gone, ms))) -> K.T(Spec.fits(E.or_else(x, y), gone, ms)):
  match x:
    case None{}:
      wy
    case Some{v}:
      wx

def best_fits(+gone: Nat, +ms: +List<E.Mem>) -> K.T(Spec.fits(E.best(gone, ms), gone, ms)):
  or_else_fits(E.first(True{}, gone, ms), E.first(False{}, gone, ms), gone, ms,
    first_fits(True{}, gone, ms), first_fits(False{}, gone, ms))

def heir_fits(+gone: Nat, +ms: +List<E.Mem>, +ans: E.Answer) -> K.T(Spec.fits(E.heir(gone, ms, ans), gone, ms)):
  match ans:
    case E.Transfer{}:
      best_fits(gone, ms)
    case E.Named{q}:
      K.pick_split(Maybe<&2, Nat>, x => K.T(Spec.fits(x, gone, ms)),
        E.eligible(q, gone, ms), Some{q}, E.best(gone, ms),
        e => K.from_eq(E.eligible(q, gone, ms), e),
        e => best_fits(gone, ms))
    case E.Remove{}:
      Unit{}
    case E.Unanswered{}:
      best_fits(gone, ms)

def heir_fits_eq(+gone: Nat, +ms: +List<E.Mem>, +ans: E.Answer)
  -> {Spec.fits(E.heir(gone, ms, ans), gone, ms) == True{} : Bool}:
  K.to_eq(Spec.fits(E.heir(gone, ms, ans), gone, ms), heir_fits(gone, ms, ans))

# E2
# --

def named_eq(+gone: Nat, +ms: +List<E.Mem>, +q: Nat)
  -> {Spec.imp(E.eligible(q, gone, ms), Spec.is_heir(E.heir(gone, ms, E.Named{q}), q)) == True{} : Bool}:
  K.bool_case(E.eligible(q, gone, ms),
    y => {Spec.imp(y, Spec.is_heir(Bool.pick(Maybe<&2, Nat>, y, Some{q}, E.best(gone, ms)), q)) == True{} : Bool},
    e => K.to_eq(Nat.is_eq(q, q), K.eq_refl(q)),
    e => {==})

# E4
# --

def member_found(+gone: Nat, +ms: +List<E.Mem>, +w: K.T(Spec.any_other(gone, ms)))
  -> K.T(Bool.not(Spec.is_none(E.first(False{}, gone, ms)))):
  match ms:
    case Nil{}:
      w
    case E.Mem{p, a, r} <> rest:
      K.bool_case(Nat.is_eq(a, gone),
        y => K.T(Bool.not(y) || Spec.any_other(gone, rest))
          -> K.T(Bool.not(Spec.is_none(Bool.pick(Maybe<&2, Nat>, Bool.not(y) && (Bool.not(False{}) || E.is_admin(r)), Some{p}, E.first(False{}, gone, rest))))),
        e => v => member_found(gone, rest, v),
        e => v => Unit{})(w)

def or_else_some(+x: Maybe<&2, Nat>, +y: Maybe<&2, Nat>, w: K.T(Bool.not(Spec.is_none(y))))
  -> K.T(Bool.not(Spec.is_none(E.or_else(x, y)))):
  match x:
    case None{}:
      w
    case Some{v}:
      Unit{}

def best_some(+gone: Nat, +ms: +List<E.Mem>, w: K.T(Spec.any_other(gone, ms)))
  -> K.T(Bool.not(Spec.is_none(E.best(gone, ms)))):
  or_else_some(E.first(True{}, gone, ms), E.first(False{}, gone, ms), member_found(gone, ms, w))

def heir_passes(+gone: Nat, +ms: +List<E.Mem>, +ans: E.Answer,
  w: K.T(Bool.not(Spec.is_remove(ans)) && Spec.any_other(gone, ms))) -> K.T(Bool.not(Spec.is_none(E.heir(gone, ms, ans)))):
  match ans:
    case E.Transfer{}:
      best_some(gone, ms, w)
    case E.Named{q}:
      K.pick_split(Maybe<&2, Nat>, x => K.T(Bool.not(Spec.is_none(x))),
        E.eligible(q, gone, ms), Some{q}, E.best(gone, ms),
        e => Unit{},
        e => best_some(gone, ms, w))
    case E.Remove{}:
      w
    case E.Unanswered{}:
      best_some(gone, ms, w)

def passes_eq(+gone: Nat, +ms: +List<E.Mem>, +ans: E.Answer)
  -> {Spec.imp(Bool.not(Spec.is_remove(ans)) && Spec.any_other(gone, ms), Bool.not(Spec.is_none(E.heir(gone, ms, ans)))) == True{} : Bool}:
  K.to_eq(Spec.imp(Bool.not(Spec.is_remove(ans)) && Spec.any_other(gone, ms), Bool.not(Spec.is_none(E.heir(gone, ms, ans)))),
    K.imp_intro(Bool.not(Spec.is_remove(ans)) && Spec.any_other(gone, ms), Bool.not(Spec.is_none(E.heir(gone, ms, ans))),
      w => heir_passes(gone, ms, ans, w)))

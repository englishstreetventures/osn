# Proofs about the route's verdict: what `Ok` guarantees.

import Base
import ./kit.bend as K
import ./choices.bend as C
import ./SPEC.bend as Spec

# check answers Ok only when no action is left open.
def check_answered(+os: +List<C.OrgAct>, +as: +List<C.AppAct>, +ps: +List<C.Pick>)
  -> K.T(Spec.imp(C.is_ok(C.check(os, as, ps)), Bool.not(C.is_open(os, as, ps)))):
  K.pick_split(C.Verdict, v => K.T(Spec.imp(C.is_ok(v), Bool.not(C.is_open(os, as, ps)))),
    C.any_invalid(os, as, ps), C.Invalid{},
    Bool.pick(C.Verdict, C.any_stale(as, ps), C.Stale{},
      Bool.pick(C.Verdict, C.is_open(os, as, ps), C.Open{}, C.Ok{})),
    q => Unit{},
    q => K.pick_split(C.Verdict, v => K.T(Spec.imp(C.is_ok(v), Bool.not(C.is_open(os, as, ps)))),
      C.any_stale(as, ps), C.Stale{},
      Bool.pick(C.Verdict, C.is_open(os, as, ps), C.Open{}, C.Ok{}),
      q2 => Unit{},
      q2 => K.pick_split(C.Verdict, v => K.T(Spec.imp(C.is_ok(v), Bool.not(C.is_open(os, as, ps)))),
        C.is_open(os, as, ps), C.Open{}, C.Ok{},
        q3 => Unit{},
        q3 => %q3 : K.T(Spec.imp(True{}, Bool.not(_)))
              Unit{})))

def verdict_answered(+r: C.Req) -> K.T(Spec.imp(C.is_ok(C.verdict(r)), Spec.answered(r))):
  match r:
    case C.Req{os, as, ps, everything, unchecked}:
      match everything:
        case True{}:
          K.imp_intro(C.is_ok(C.verdict(C.Req{os, as, ps, True{}, unchecked})), True{}, w => Unit{})
        case False{}:
          match unchecked:
            case True{}:
              Unit{}
            case False{}:
              check_answered(os, as, ps)

# Offered answers
# ---------------

def org_bad_offered(+h: Maybe<&2, C.Heir>, +c: C.OrgChoice, +m: Bool, +w: K.T(Bool.not(C.org_bad(h, c, m))))
  -> K.T(Spec.offered_org(h, c, m)):
  match h:
    case None{}:
      Unit{}
    case Some{x}:
      match c:
        case C.Transfer{}:
          K.and_intro(C.org_offers(x, C.Transfer{}), True{},
            K.not_not(C.org_offers(x, C.Transfer{}),
              K.nor_l(Bool.not(C.org_offers(x, C.Transfer{})), False{}, w)),
            Unit{})
        case C.Successor{}:
          K.and_intro(C.org_offers(x, C.Successor{}), m,
            K.not_not(C.org_offers(x, C.Successor{}),
              K.nor_l(Bool.not(C.org_offers(x, C.Successor{})), Bool.not(m), w)),
            K.not_not(m, K.nor_r(Bool.not(C.org_offers(x, C.Successor{})), Bool.not(m), w)))
        case C.Delete{}:
          K.and_intro(C.org_offers(x, C.Delete{}), True{},
            K.not_not(C.org_offers(x, C.Delete{}),
              K.nor_l(Bool.not(C.org_offers(x, C.Delete{})), False{}, w)),
            Unit{})

def app_bad_offered(+o: Maybe<&2, +List<Nat>>, +c: Nat, w: K.T(Bool.not(C.app_bad(o, c))))
  -> K.T(Spec.offered_app(o, c)):
  match o:
    case None{}:
      Unit{}
    case Some{offers}:
      K.not_not(C.has_nat(c, offers), w)

def bad_offered(+p: C.Pick, +os: +List<C.OrgAct>, +as: +List<C.AppAct>, w: K.T(Bool.not(C.bad(p, os, as))))
  -> K.T(Spec.offered(p, os, as)):
  match p:
    case C.OrgPick{id, c, m}:
      org_bad_offered(C.find_org(id, os), c, m, w)
    case C.AppPick{id, c}:
      app_bad_offered(C.find_app(id, as), c, w)
    case C.OtherPick{}:
      Unit{}

def valid_offered(+os: +List<C.OrgAct>, +as: +List<C.AppAct>, ps: +List<C.Pick>, +w: K.T(Bool.not(C.any_invalid(os, as, ps))))
  -> K.T(Spec.all_offered(os, as, ps)):
  match ps:
    case Nil{}:
      Unit{}
    case +p <> +rest:
      K.and_intro(Spec.offered(p, os, as), Spec.all_offered(os, as, rest),
        bad_offered(p, os, as,
          K.nor_l(C.bad(p, os, as), C.again(p, os, as, rest),
            K.nor_l(C.bad(p, os, as) || C.again(p, os, as, rest), C.any_invalid(os, as, rest), w))),
        valid_offered(os, as, rest,
          K.nor_r(C.bad(p, os, as) || C.again(p, os, as, rest), C.any_invalid(os, as, rest), w)))

def check_offered(+os: +List<C.OrgAct>, +as: +List<C.AppAct>, +ps: +List<C.Pick>)
  -> K.T(Spec.imp(C.is_ok(C.check(os, as, ps)), Spec.all_offered(os, as, ps))):
  K.pick_split(C.Verdict, v => K.T(Spec.imp(C.is_ok(v), Spec.all_offered(os, as, ps))),
    C.any_invalid(os, as, ps), C.Invalid{},
    Bool.pick(C.Verdict, C.any_stale(as, ps), C.Stale{},
      Bool.pick(C.Verdict, C.is_open(os, as, ps), C.Open{}, C.Ok{})),
    q => Unit{},
    q => K.imp_intro(C.is_ok(Bool.pick(C.Verdict, C.any_stale(as, ps), C.Stale{},
        Bool.pick(C.Verdict, C.is_open(os, as, ps), C.Open{}, C.Ok{}))),
      Spec.all_offered(os, as, ps),
      ok => valid_offered(os, as, ps, %q : K.T(Bool.not(_))
                                     Unit{})))

def verdict_offered(+r: C.Req) -> K.T(Spec.imp(C.is_ok(C.verdict(r)), Spec.offered_req(r))):
  match r:
    case C.Req{os, as, ps, everything, unchecked}:
      match everything:
        case True{}:
          K.imp_intro(C.is_ok(C.verdict(C.Req{os, as, ps, True{}, unchecked})), True{}, w => Unit{})
        case False{}:
          match unchecked:
            case True{}:
              Unit{}
            case False{}:
              check_offered(os, as, ps)

def verdict_answered_eq(+r: C.Req) -> {Spec.imp(C.is_ok(C.verdict(r)), Spec.answered(r)) == True{} : Bool}:
  K.to_eq(Spec.imp(C.is_ok(C.verdict(r)), Spec.answered(r)), verdict_answered(r))

def verdict_offered_eq(+r: C.Req) -> {Spec.imp(C.is_ok(C.verdict(r)), Spec.offered_req(r)) == True{} : Bool}:
  K.to_eq(Spec.imp(C.is_ok(C.verdict(r)), Spec.offered_req(r)), verdict_offered(r))

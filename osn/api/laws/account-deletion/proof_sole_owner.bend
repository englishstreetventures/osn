# Proofs of sole_owner_blocks_deletion, the law that spans both services:
# cire's preview of a sole-owned wedding (cire/api/laws/account-deletion/
# weddings.bend) and osn-api's verdict on the request that uses it.

import Base
import ../../../../tools/bend/kit.bend as K
import ./choices.bend as C
import ../../../../cire/api/laws/account-deletion/weddings.bend as D
import ./SPEC.bend as Spec
import ./proof_choices.bend as PC

# D3
# --

# With the wedding's action in the preview, Ok means it was answered.
def wedding_answered(+os: +List<C.OrgAct>, +wid: Nat, +ps: +List<C.Pick>)
  -> K.T(Spec.imp(C.is_ok(C.check(os, [D.wedding_action(wid)], ps)), C.names_app(wid, ps))):
  K.imp_intro(C.is_ok(C.check(os, [D.wedding_action(wid)], ps)), C.names_app(wid, ps),
    ok => K.not_not(C.names_app(wid, ps),
      K.nor_l(Bool.not(C.names_app(wid, ps)), False{},
        K.nor_r(C.open_orgs(os, ps), C.open_apps([D.wedding_action(wid)], ps),
          K.imp_elim(C.is_ok(C.check(os, [D.wedding_action(wid)], ps)), Bool.not(C.is_open(os, [D.wedding_action(wid)], ps)),
            PC.check_answered(os, [D.wedding_action(wid)], ps), ok)))))

def sole_blocks(+acct: Nat, +wid: Nat, +w: D.W, +os: +List<C.OrgAct>, +ps: +List<C.Pick>)
  -> {Spec.imp(D.sole(acct, w) && C.is_ok(C.verdict(C.Req{os, D.preview(acct, wid, w), ps, False{}, False{}})), C.names_app(wid, ps)) == True{} : Bool}:
  K.bool_case(D.sole(acct, w),
    y => {Spec.imp(y && C.is_ok(C.check(os, Bool.pick(+List<C.AppAct>, y, [D.wedding_action(wid)], []), ps)), C.names_app(wid, ps)) == True{} : Bool},
    e => K.to_eq(Spec.imp(C.is_ok(C.check(os, [D.wedding_action(wid)], ps)), C.names_app(wid, ps)),
      wedding_answered(os, wid, ps)),
    e => {==})

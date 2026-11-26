# The proofs: one def for each law in LAWS.bend, most of them a lemma from a
# proof_*.bend module. `bend PROOF.bend` checks every one and prints ALL
# PROOFS CHECK, or SOME PROOFS FAIL while any law is open or false. Laws about
# reachable states start from the model's first state and carry an invariant
# down the list of events (`reach`, `run_inv`); the rest hold of any state.

import Base
import ./account.bend as Account
import ./choices.bend as Choices
import ./holds.bend as Holds
import ./succession.bend as Succession
import ./weddings.bend as Weddings
import ./SPEC.bend as Spec
import ./LAWS.bend as Laws
import ./kit.bend as K
import ./proof_account.bend as PA
import ./proof_choices.bend as PC
import ./proof_holds.bend as PH
import ./proof_succession.bend as PE
import ./proof_weddings.bend as PD

def Laws.never_before_window(es):
  PA.reach(es, Account.init(), Unit{}, x => {Spec.on_time(x) == True{} : Bool},
    x => h => PA.good_on_time(x, h))

def Laws.every_app_finished(es):
  PA.reach(es, Account.init(), Unit{}, x => {Spec.apps_finished(x) == True{} : Bool},
    x => h => PA.good_apps_finished(x, h))

def Laws.no_restore_after_an_app_is_reached(es, e):
  PA.reach(es, Account.init(), Unit{},
    x => {Spec.imp(Spec.reached(x), Bool.not(Spec.is_live(Account.step(x, e)))) == True{} : Bool},
    x => h => PA.no_restore(x, e, h))

def Laws.withdrawn_never_reapplied(es, e, later):
  PA.reach(es, Account.init(), Unit{},
    x => {Spec.revived(Spec.withdrawn(x, Account.step(x, e)), Account.run(later, Account.step(x, e))) == False{} : Bool},
    x => h => PA.withdrawn_lemma(x, e, later, h))

def Laws.restore_only_inside_window(s, e):
  PA.restore_in_window(s, e)

def Laws.stale_cancel_restores_nothing(s, now, read):
  PA.stale_cancel(s, now, read)

def Laws.scheduled_only_when_answered(s, e):
  PA.scheduled_answered(s, e)

def Laws.accepted_means_answered(r):
  PC.verdict_answered_eq(r)

def Laws.accepted_answers_are_offered(r):
  PC.verdict_offered_eq(r)

def Laws.held_handle_has_no_owner(a, es):
  PH.reach(es, Holds.start(a), Unit{}, x => {Spec.unclaimed_while_held(x) == True{} : Bool},
    x => w => PH.held_eq(x, w))

def Laws.hold_outlasts_erasure_by_thirty_days(a, es, t, b, u):
  PH.reach(es, Holds.start(a), Unit{},
    x => {Spec.imp(Holds.held_for(Spec.hold_of(x), a) && Nat.is_lt(Nat.max(Spec.clock_of(Holds.step(x, Holds.Erase{a, t})), u), Nat.add(Spec.clock_of(Holds.step(x, Holds.Erase{a, t})), Holds.thirty_days())),
      Holds.unowned(Spec.owner_of(Holds.step(Holds.step(x, Holds.Erase{a, t}), Holds.Claim{b, u})))) == True{} : Bool},
    x => w => PH.hold_thirty_days(x, a, t, b, u, w))

def Laws.heir_is_another_accounts_member(gone, ms, ans):
  PE.heir_fits_eq(gone, ms, ans)

def Laws.named_heir_honoured(gone, ms, q):
  PE.named_eq(gone, ms, q)

def Laws.delete_answer_deletes(gone, ms):
  {==}

def Laws.passes_when_it_can(gone, ms, ans):
  PE.passes_eq(gone, ms, ans)

def Laws.no_live_wedding_without_owner(q, a, es):
  PD.run_inv(es, Weddings.created(q, a), Unit{})

def Laws.erasure_never_promotes(acct, q, ss):
  PD.promotes_eq(acct, q, ss)

def Laws.sole_owner_blocks_deletion(acct, wid, w, os, ps):
  PD.sole_blocks(acct, wid, w, os, ps)

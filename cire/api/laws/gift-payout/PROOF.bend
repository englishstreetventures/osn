# The proofs: one def for each law in LAWS.bend, each a lemma from a proof_*
# module. `bend PROOF.bend` checks every one and prints ALL PROOFS CHECK, or
# SOME PROOFS FAIL while any law is open or false.

import Base
import ../../../../tools/bend/kit.bend as K
import ./payout.bend as M
import ./SPEC.bend as Spec
import ./LAWS.bend as Laws
import ./proof_account.bend as PA
import ./proof_holder.bend as PH
import ./proof_money.bend as PM

def gen_eq(+s: M.P, +e: M.Ev) -> {Spec.gen_follows(s, M.step(s, e)) == True{} : Bool}:
  K.to_eq(Spec.gen_follows(s, M.step(s, e)), PA.gen_step(s, e))

def Laws.generation_counts_clears(s, e):
  gen_eq(s, e)

def repoint_eq(+s: M.P, +e: M.Ev) -> {Spec.not_repointed(s, M.step(s, e)) == True{} : Bool}:
  K.to_eq(Spec.not_repointed(s, M.step(s, e)), PA.repoint_step(s, e))

def Laws.account_never_repointed(s, e):
  repoint_eq(s, e)

def records_eq(+s: M.P, +e: M.Ev) -> {Spec.records_follow(s, e, M.step(s, e)) == True{} : Bool}:
  K.to_eq(Spec.records_follow(s, e, M.step(s, e)), PA.records_step(s, e))

def Laws.retire_writes_one_record(s, e):
  records_eq(s, e)

def clear_eq(+s: M.P, +e: M.Ev)
  -> {Spec.imp(Spec.cleared(s, M.step(s, e)), Spec.is_retire(e) || Spec.detaches(Spec.account_of(s), e)) == True{} : Bool}:
  K.to_eq(Spec.imp(Spec.cleared(s, M.step(s, e)), Spec.is_retire(e) || Spec.detaches(Spec.account_of(s), e)), PA.clear_step(s, e))

def Laws.clear_is_retire_or_detach(s, e):
  clear_eq(s, e)

def stale_retire_eq(+s: M.P, +by: Nat, +hand: Maybe<&2, Nat>, +read: Maybe<&2, Nat>, +g: Nat)
  -> {Spec.imp(Bool.not(Spec.read_fresh(s, read, g)), Spec.payout_same(s, M.step(s, M.Retire{by, hand, read, g}))) == True{} : Bool}:
  K.to_eq(Spec.imp(Bool.not(Spec.read_fresh(s, read, g)), Spec.payout_same(s, M.step(s, M.Retire{by, hand, read, g}))),
    PA.stale_retire(s, by, hand, read, g))

def Laws.stale_retire_changes_nothing(s, by, hand, read, g):
  stale_retire_eq(s, by, hand, read, g)

def stale_connect_eq(+s: M.P, +by: Nat, +a: Nat, +g: Nat, +c: Bool)
  -> {Spec.imp(Bool.not(Nat.is_eq(g, Spec.gen_of(s))), Spec.payout_same(s, M.step(s, M.Connect{by, a, g, c}))) == True{} : Bool}:
  K.to_eq(Spec.imp(Bool.not(Nat.is_eq(g, Spec.gen_of(s))), Spec.payout_same(s, M.step(s, M.Connect{by, a, g, c}))),
    PA.stale_connect(s, by, a, g, c))

def Laws.stale_connect_changes_nothing(s, by, a, g, c):
  stale_connect_eq(s, by, a, g, c)

def owner_eq(+s: M.P, +by: Nat, +hand: Maybe<&2, Nat>, +read: Maybe<&2, Nat>, +g: Nat)
  -> {Spec.imp(Spec.cleared(s, M.step(s, M.Retire{by, hand, read, g})), Spec.owns_live(s, by)) == True{} : Bool}:
  K.to_eq(Spec.imp(Spec.cleared(s, M.step(s, M.Retire{by, hand, read, g})), Spec.owns_live(s, by)),
    PA.retire_owner(s, by, hand, read, g))

def Laws.retire_needs_an_owner(s, by, hand, read, g):
  owner_eq(s, by, hand, read, g)

def hand_eq(+s: M.P, +by: Nat, +h: Nat, +read: Maybe<&2, Nat>, +g: Nat)
  -> {Spec.imp(Spec.cleared(s, M.step(s, M.Retire{by, Some{h}, read, g})), Spec.hand_fits(s, by, h)) == True{} : Bool}:
  K.to_eq(Spec.imp(Spec.cleared(s, M.step(s, M.Retire{by, Some{h}, read, g})), Spec.hand_fits(s, by, h)),
    PA.retire_hand(s, by, h, read, g))

def Laws.handover_by_holder_to_another_owner(s, by, h, read, g):
  hand_eq(s, by, h, read, g)

def erase_eq(+s: M.P, +ps: +List<Nat>)
  -> {Spec.same_nat(Spec.account_of(s), Spec.account_of(M.step(s, M.Erase{ps}))) == True{} : Bool}:
  K.to_eq(Spec.same_nat(Spec.account_of(s), Spec.account_of(M.step(s, M.Erase{ps}))), PA.erase_keeps(s, ps))

def Laws.erasure_keeps_account(s, ps):
  erase_eq(s, ps)

def seated_eq(+s: M.P, +e: M.Ev)
  -> {Spec.imp(Spec.not_erase(e) && Bool.not(M.absent(s)), Bool.not(M.absent(M.step(s, e)))) == True{} : Bool}:
  K.to_eq(Spec.imp(Spec.not_erase(e) && Bool.not(M.absent(s)), Bool.not(M.absent(M.step(s, e)))), PH.seated_step(s, e))

def Laws.holder_unseated_only_by_erasure(s, e):
  seated_eq(s, e)

def kept_eq(+s: M.P, +e: M.Ev, +q: Nat)
  -> {Spec.imp(Spec.not_erase(e) && Spec.holds_seated(s, q), Spec.kept_or_gone(M.step(s, e), q)) == True{} : Bool}:
  K.to_eq(Spec.imp(Spec.not_erase(e) && Spec.holds_seated(s, q), Spec.kept_or_gone(M.step(s, e), q)), PH.seat_kept(s, e, q))

def Laws.holders_seat_kept(s, e, q):
  kept_eq(s, e, q)

def closed_eq(+s: M.P) -> {Spec.imp(M.absent(s), Bool.not(Spec.is_open(M.block(s)))) == True{} : Bool}:
  K.to_eq(Spec.imp(M.absent(s), Bool.not(Spec.is_open(M.block(s)))), PM.closed(s))

def Laws.money_closed_while_holder_absent(s):
  closed_eq(s)

def Laws.money_open_only_with_seated_holder(q, es):
  PM.reach_open(es, M.created(q), Unit{})

def erased_eq(+s: M.P, +ps: +List<Nat>)
  -> {Spec.imp(Spec.holder_in(s, ps), Bool.not(Spec.is_open(M.block(M.step(s, M.Erase{ps}))))) == True{} : Bool}:
  K.to_eq(Spec.imp(Spec.holder_in(s, ps), Bool.not(Spec.is_open(M.block(M.step(s, M.Erase{ps}))))), PM.erased_closed(s, ps))

def Laws.holder_erasure_closes_gifts(s, ps):
  erased_eq(s, ps)

def turn_on_eq(+s: M.P, +e: M.Ev) -> {Spec.imp(Spec.turned_on(s, M.step(s, e)), Spec.ready(s)) == True{} : Bool}:
  K.to_eq(Spec.imp(Spec.turned_on(s, M.step(s, e)), Spec.ready(s)), PM.turn_on(s, e))

def Laws.gifts_on_only_when_ready(s, e):
  turn_on_eq(s, e)

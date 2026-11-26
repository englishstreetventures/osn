# The laws of account deletion. Each is a claim about the model in the
# modules below, which follow the code in osn-api and cire-api;
# wiki/osn/account-deletion-laws.md names the code that keeps each one and the
# agreement test that ties the model to it. PROOF.bend proves every law.
# A law here changes only by the owner's decision.

import Base
import ./account.bend as Account
import ./choices.bend as Choices
import ./holds.bend as Holds
import ./succession.bend as Succession
import ./weddings.bend as Weddings
import ./SPEC.bend as Spec

# Account
# -------

# LAW: an account is never erased before its seven-day window ends.
law never_before_window:
  for es: List<Account.Ev>
  {Spec.on_time(Account.run(es, Account.init())) == True{} : Bool}

# LAW: an account is erased only once every app has confirmed its erasure or
# been skipped as one the tier does not run; an app that fails is tried again
# and holds the erasure until it answers.
law every_app_finished:
  for es: List<Account.Ev>
  {Spec.apps_finished(Account.run(es, Account.init())) == True{} : Bool}

# LAW: once any app has been sent the erasure, the account can never be
# restored: a restore happens only before any app is reached.
law no_restore_after_an_app_is_reached:
  for es: List<Account.Ev>
  for e: Account.Ev
  s = Account.run(es, Account.init())
  {Spec.imp(Spec.reached(s), Bool.not(Spec.is_live(Account.step(s, e)))) == True{} : Bool}

# LAW: a withdrawn request is never applied again: after a cancel, no later
# state, whatever happens, holds the cancelled job.
law withdrawn_never_reapplied:
  for es: List<Account.Ev>
  for e: Account.Ev
  for later: List<Account.Ev>
  s = Account.run(es, Account.init())
  t = Account.step(s, e)
  {Spec.revived(Spec.withdrawn(s, t), Account.run(later, t)) == False{} : Bool}

# LAW: from any state at all, a restore is a cancel naming the pending job,
# made before any sweep claimed it and before its window ended.
law restore_only_inside_window:
  for s: Account.Acct
  for e: Account.Ev
  {Spec.imp(Spec.restored(s, Account.step(s, e)), Spec.keeps_in_window(s, e)) == True{} : Bool}

# LAW: a cancel that read another job restores nothing.
law stale_cancel_restores_nothing:
  for s: Account.Acct
  for now: Nat
  for read: Nat
  {Spec.imp(Bool.not(Spec.names_job(read, s)), Bool.not(Spec.restored(s, Account.step(s, Account.Keep{now, read})))) == True{} : Bool}

# LAW: a deletion is scheduled only by a request that chose "delete
# everything" or answered every open action.
law scheduled_only_when_answered:
  for s: Account.Acct
  for e: Account.Ev
  {Spec.imp(Spec.scheduled(s, Account.step(s, e)), Spec.asked_answered(e)) == True{} : Bool}

# Choices
# -------

# LAW: the route accepts a request only when it chose "delete everything" or
# every action that needs an answer has one.
law accepted_means_answered:
  for r: Choices.Req
  {Spec.imp(Choices.is_ok(Choices.verdict(r)), Spec.answered(r)) == True{} : Bool}

# LAW: an accepted request's every answer names a choice its action offers,
# and a named successor is a member from another account.
law accepted_answers_are_offered:
  for r: Choices.Req
  {Spec.imp(Choices.is_ok(Choices.verdict(r)), Spec.offered_req(r)) == True{} : Bool}

# Holds
# -----

# LAW: a handle under a live hold has no owner: no account claims it while
# the deletion that held it is pending or before the hold's release.
law held_handle_has_no_owner:
  for a: Nat
  for es: List<Holds.HEv>
  {Spec.unclaimed_while_held(Holds.run(es, Holds.start(a))) == True{} : Bool}

# LAW: after the hard delete, a held profile handle stays unclaimed by anyone
# for thirty days.
law hold_outlasts_erasure_by_thirty_days:
  for +a: Nat
  for es: List<Holds.HEv>
  for t: Nat
  for b: Nat
  for u: Nat
  s = Holds.run(es, Holds.start(a))
  erased = Holds.step(s, Holds.Erase{a, t})
  claimed = Holds.step(erased, Holds.Claim{b, u})
  {Spec.imp(Holds.held_for(Spec.hold_of(s), a) && Nat.is_lt(Nat.max(Spec.clock_of(erased), u), Nat.add(Spec.clock_of(erased), Holds.thirty_days())), Holds.unowned(Spec.owner_of(claimed))) == True{} : Bool}

# Succession
# ----------

# LAW: an organisation passes only to a member from another account.
law heir_is_another_accounts_member:
  for gone: Nat
  for ms: +List<Succession.Mem>
  for ans: Succession.Answer
  {Spec.fits(Succession.heir(gone, ms, ans), gone, ms) == True{} : Bool}

# LAW: the successor the person named takes it while still a member from
# another account.
law named_heir_honoured:
  for gone: Nat
  for ms: +List<Succession.Mem>
  for q: Nat
  {Spec.imp(Succession.eligible(q, gone, ms), Spec.is_heir(Succession.heir(gone, ms, Succession.Named{q}), q)) == True{} : Bool}

# LAW: a delete answer deletes the organisation.
law delete_answer_deletes:
  for gone: Nat
  for ms: +List<Succession.Mem>
  {Spec.is_none(Succession.heir(gone, ms, Succession.Remove{})) == True{} : Bool}

# LAW: with no delete answer, an organisation passes on whenever a member
# from another account remains.
law passes_when_it_can:
  for gone: Nat
  for ms: +List<Succession.Mem>
  for ans: Succession.Answer
  {Spec.imp(Bool.not(Spec.is_remove(ans)) && Spec.any_other(gone, ms), Bool.not(Spec.is_none(Succession.heir(gone, ms, ans)))) == True{} : Bool}

# Weddings
# --------

# LAW: no live wedding is ever left without an owner.
law no_live_wedding_without_owner:
  for q: Nat
  for a: Nat
  for es: List<Weddings.WEv>
  {Spec.owner_if_live(Weddings.run(es, Weddings.created(q, a))) == True{} : Bool}

# LAW: an erasure never makes anyone an owner: a wedding never passes to an
# editor.
law erasure_never_promotes:
  for acct: Nat
  for q: Nat
  for ss: +List<Weddings.Seat>
  {Spec.imp(Weddings.owns(q, Weddings.erase_seats(acct, ss)), Weddings.owns(q, ss)) == True{} : Bool}

# LAW: while the account holds every owner seat of a live wedding, the
# deletion is accepted only with an answer for that wedding, unless the
# person deletes everything.
law sole_owner_blocks_deletion:
  for acct: Nat
  for wid: Nat
  for w: Weddings.W
  for os: +List<Choices.OrgAct>
  for ps: +List<Choices.Pick>
  {Spec.imp(Weddings.sole(acct, w) && Choices.is_ok(Choices.verdict(Choices.Req{os, Weddings.preview(acct, wid, w), ps, False{}, False{}})), Choices.names_app(wid, ps)) == True{} : Bool}

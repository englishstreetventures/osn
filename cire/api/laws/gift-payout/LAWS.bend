# The laws of a cire wedding's gift payouts. Each is a claim about the model
# in payout.bend, which follows cire-api's code; wiki/cire/cire-gift-payout-laws.md
# names the code that keeps each one and the agreement test that ties the
# model to it. PROOF.bend proves every law.
# A law here changes only by the owner's decision.

import Base
import ./payout.bend as M
import ./SPEC.bend as Spec

# The account
# -----------

# LAW: the account generation rises by one exactly when a step clears the
# account, and otherwise stays: it never falls.
law generation_counts_clears:
  for s: M.P
  for e: M.Ev
  {Spec.gen_follows(s, M.step(s, e)) == True{} : Bool}

# LAW: no step moves the wedding from one account to another: a named
# account stays the same, or none is named.
law account_never_repointed:
  for s: M.P
  for e: M.Ev
  {Spec.not_repointed(s, M.step(s, e)) == True{} : Bool}

# LAW: a retire that clears the account writes exactly one retired-account
# record, naming that account, unreleased, with the reason the caller's
# standing gives; no other step writes one.
law retire_writes_one_record:
  for s: M.P
  for e: M.Ev
  {Spec.records_follow(s, e, M.step(s, e)) == True{} : Bool}

# LAW: every clear of the account is a retire, or a detach of that account.
law clear_is_retire_or_detach:
  for s: M.P
  for e: M.Ev
  {Spec.imp(Spec.cleared(s, M.step(s, e)), Spec.is_retire(e) || Spec.detaches(Spec.account_of(s), e)) == True{} : Bool}

# LAW: a retire whose caller read another account, or none, or another
# generation, changes no payout field.
law stale_retire_changes_nothing:
  for s: M.P
  for by: Nat
  for hand: Maybe<&2, Nat>
  for read: Maybe<&2, Nat>
  for g: Nat
  {Spec.imp(Bool.not(Spec.read_fresh(s, read, g)), Spec.payout_same(s, M.step(s, M.Retire{by, hand, read, g}))) == True{} : Bool}

# LAW: a connect that carries a generation other than the wedding's changes no
# payout field.
law stale_connect_changes_nothing:
  for s: M.P
  for by: Nat
  for a: Nat
  for g: Nat
  for c: Bool
  {Spec.imp(Bool.not(Nat.is_eq(g, Spec.gen_of(s))), Spec.payout_same(s, M.step(s, M.Connect{by, a, g, c}))) == True{} : Bool}

# LAW: a retire clears the account only for a caller holding an owner seat on
# the live wedding.
law retire_needs_an_owner:
  for s: M.P
  for by: Nat
  for hand: Maybe<&2, Nat>
  for read: Maybe<&2, Nat>
  for g: Nat
  {Spec.imp(Spec.cleared(s, M.step(s, M.Retire{by, hand, read, g})), Spec.owns_live(s, by)) == True{} : Bool}

# LAW: a retire that names someone to hand money gifts to clears the account
# only when the caller holds it and the one named is another current owner.
law handover_by_holder_to_another_owner:
  for s: M.P
  for by: Nat
  for h: Nat
  for read: Maybe<&2, Nat>
  for g: Nat
  {Spec.imp(Spec.cleared(s, M.step(s, M.Retire{by, Some{h}, read, g})), Spec.hand_fits(s, by, h)) == True{} : Bool}

# LAW: an erasure never changes the account the wedding names.
law erasure_keeps_account:
  for s: M.P
  for ps: +List<Nat>
  {Spec.same_nat(Spec.account_of(s), Spec.account_of(M.step(s, M.Erase{ps}))) == True{} : Bool}

# The holder
# ----------

# LAW: only an erasure leaves the account held by someone who is not an
# owner: no other step makes the holder absent.
law holder_unseated_only_by_erasure:
  for s: M.P
  for e: M.Ev
  {Spec.imp(Spec.not_erase(e) && Bool.not(M.absent(s)), Bool.not(M.absent(M.step(s, e)))) == True{} : Bool}

# LAW: while `q` holds the account and an owner seat, no step but an erasure
# takes the seat: after it, `q` still has an owner seat, or no longer holds
# the account.
law holders_seat_kept:
  for s: M.P
  for e: M.Ev
  for q: Nat
  {Spec.imp(Spec.not_erase(e) && Spec.holds_seated(s, q), Spec.kept_or_gone(M.step(s, e), q)) == True{} : Bool}

# Money
# -----

# LAW: money gifts are closed whenever the account's holder is absent.
law money_closed_while_holder_absent:
  for s: M.P
  {Spec.imp(M.absent(s), Bool.not(Spec.is_open(M.block(s)))) == True{} : Bool}

# LAW: in every state a wedding reaches, money gifts are open only with an
# account named, its holder in an owner seat, Stripe taking charges, and the
# switch on.
law money_open_only_with_seated_holder:
  for q: Nat
  for es: List<M.Ev>
  {Spec.imp(Spec.is_open(M.block(M.run(es, M.created(q)))), Spec.backed(M.run(es, M.created(q)))) == True{} : Bool}

# LAW: an erasure of the holder's profile leaves money gifts closed.
law holder_erasure_closes_gifts:
  for s: M.P
  for ps: +List<Nat>
  {Spec.imp(Spec.holder_in(s, ps), Bool.not(Spec.is_open(M.block(M.step(s, M.Erase{ps}))))) == True{} : Bool}

# LAW: a step turns money gifts on only while the account's holder is not
# absent and Stripe can take a charge.
law gifts_on_only_when_ready:
  for s: M.P
  for e: M.Ev
  {Spec.imp(Spec.turned_on(s, M.step(s, e)), Spec.ready(s)) == True{} : Bool}

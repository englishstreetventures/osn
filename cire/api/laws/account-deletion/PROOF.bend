# The proofs: one def for each law in LAWS.bend, each a lemma from
# proof_weddings.bend. `bend PROOF.bend` checks every one and prints ALL
# PROOFS CHECK, or SOME PROOFS FAIL while any law is open or false.

import Base
import ./weddings.bend as Weddings
import ./SPEC.bend as Spec
import ./LAWS.bend as Laws
import ./proof_weddings.bend as PD

def Laws.no_live_wedding_without_owner(q, a, es):
  PD.run_inv(es, Weddings.created(q, a), Unit{})

def Laws.erasure_never_promotes(acct, q, ss):
  PD.promotes_eq(acct, q, ss)

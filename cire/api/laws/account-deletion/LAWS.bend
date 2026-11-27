# The laws of account deletion in cire-api: one wedding's owners. Each is a
# claim about the model in weddings.bend, which follows cire-api's code;
# wiki/osn/account-deletion-laws.md names the code that keeps each one and the
# agreement test that ties the model to it. PROOF.bend proves every law.
# A law here changes only by the owner's decision. The law that ties a
# wedding's preview to osn-api's verdict is in osn/api/laws/account-deletion.

import Base
import ./weddings.bend as Weddings
import ./SPEC.bend as Spec

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

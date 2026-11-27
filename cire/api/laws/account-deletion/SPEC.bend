# What the laws in LAWS.bend mean. Change this file only with LAWS.bend: a
# law must not lean on a helper the model or the proofs may rewrite.

import Base
import ./weddings.bend as Weddings

def imp(a: Bool, b: Bool) -> Bool:
  Bool.not(a) || b

# Weddings
# --------

# A live wedding has an owner.
def owner_if_live(w: Weddings.W) -> Bool:
  match w:
    case Weddings.W{live, ss}:
      Bool.not(live) || Weddings.has_owner(ss)

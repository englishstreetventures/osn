# What `DELETE /account` answers about a person's open actions.
#
# The route (osn/api/src/routes/account-erasure.ts:443-518) refuses answers
# given with "delete everything", then any app that could not be checked,
# then, unless the person deletes everything, what checkErasureChoices
# (osn/api/src/services/account-erasure.ts:951-1052) finds: an answer that is
# not one its action offers, then an answer to an app action the fresh
# preview does not list, then an action that needs an answer and has none.
# Only `Ok` lets the deletion be scheduled.
#
# Action ids are numbers here; the agreement tests map them to the code's
# strings. An app's choices are numbers too: `delete_choice` is the one cire
# offers.

import Base

# Who an owned organisation could pass to, as the preview reads it
# (account-erasure.ts:743-772).
type Heir is Data:
  Nobody{}
  Member{}
  Admin{}

type OrgAct is Data:
  OrgAct{id: Nat, heir: Heir}

# An app's open action: its choices and its default, if it has one.
type AppAct is Data:
  AppAct{id: Nat, offers: +List<Nat>, fallback: Maybe<&2, Nat>}

type OrgChoice is Data:
  Transfer{}
  Successor{}
  Delete{}

# One answer. `member` says the profile a `Successor` answer names is a member
# of that organisation from another account; it means nothing for the other
# choices. `OtherPick` is an action id of no app the deletion reaches.
type Pick is Data:
  OrgPick{id: Nat, choice: OrgChoice, member: Bool}
  AppPick{id: Nat, choice: Nat}
  OtherPick{}

# The request as the route sees it once the apps have answered the preview.
type Req is Data:
  Req{orgs: +List<OrgAct>, apps: +List<AppAct>, picks: +List<Pick>, everything: Bool, unchecked: Bool}

type Verdict is Data:
  Ok{}
  Invalid{}
  Stale{}
  Open{}
  Unchecked{}
  Both{}

def delete_choice() -> Nat:
  0n

def is_ok(v: Verdict) -> Bool:
  match v:
    case Ok{}:
      True{}
    case Invalid{}:
      False{}
    case Stale{}:
      False{}
    case Open{}:
      False{}
    case Unchecked{}:
      False{}
    case Both{}:
      False{}

def has_nat(+x: Nat, xs: +List<Nat>) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case y <> rest:
      Nat.is_eq(y, x) || has_nat(x, rest)

def is_delete(c: OrgChoice) -> Bool:
  match c:
    case Transfer{}:
      False{}
    case Successor{}:
      False{}
    case Delete{}:
      True{}

def is_successor(c: OrgChoice) -> Bool:
  match c:
    case Transfer{}:
      False{}
    case Successor{}:
      True{}
    case Delete{}:
      False{}

# organisationChoices (account-erasure.ts:763-764): all three while a member
# from another account could take it over, else `delete` alone.
def org_offers(h: Heir, +c: OrgChoice) -> Bool:
  match h:
    case Nobody{}:
      is_delete(c)
    case Member{}:
      True{}
    case Admin{}:
      True{}

# organisationDefaultChoice (account-erasure.ts:771-772): `transfer` when
# another account's admin can take it over.
def org_has_default(h: Heir) -> Bool:
  match h:
    case Nobody{}:
      False{}
    case Member{}:
      False{}
    case Admin{}:
      True{}

def find_org(+id: Nat, os: +List<OrgAct>) -> Maybe<&2, Heir>:
  match os:
    case Nil{}:
      None{}
    case OrgAct{+i, +h} <> rest:
      Bool.pick(Maybe<&2, Heir>, Nat.is_eq(i, id), Some{h}, find_org(id, rest))

def find_app(+id: Nat, as: +List<AppAct>) -> Maybe<&2, +List<Nat>>:
  match as:
    case Nil{}:
      None{}
    case AppAct{+i, +offers, d} <> rest:
      Bool.pick(Maybe<&2, +List<Nat>>, Nat.is_eq(i, id), Some{offers}, find_app(id, rest))

def org_bad(h: Maybe<&2, Heir>, +c: OrgChoice, member: Bool) -> Bool:
  match h:
    case None{}:
      False{}
    case Some{x}:
      Bool.not(org_offers(x, c)) || (is_successor(c) && Bool.not(member))

def app_bad(o: Maybe<&2, +List<Nat>>, +c: Nat) -> Bool:
  match o:
    case None{}:
      False{}
    case Some{offers}:
      Bool.not(has_nat(c, offers))

def found_org(h: Maybe<&2, Heir>) -> Bool:
  match h:
    case None{}:
      False{}
    case Some{x}:
      True{}

def found_app(o: Maybe<&2, +List<Nat>>) -> Bool:
  match o:
    case None{}:
      False{}
    case Some{x}:
      True{}

# Refused on its own: a choice its action does not offer, or a successor who
# is not a member from another account. An answer to an organisation the
# account does not own is ignored, as the code ignores it.
def bad(p: Pick, +os: +List<OrgAct>, +as: +List<AppAct>) -> Bool:
  match p:
    case OrgPick{+id, c, m}:
      org_bad(find_org(id, os), c, m)
    case AppPick{+id, c}:
      app_bad(find_app(id, as), c)
    case OtherPick{}:
      False{}

# An answer to an app action the fresh preview does not list.
def stale(p: Pick, +as: +List<AppAct>) -> Bool:
  match p:
    case OrgPick{id, c, m}:
      False{}
    case AppPick{+id, c}:
      Bool.not(found_app(find_app(id, as)))
    case OtherPick{}:
      False{}

def names_org(+id: Nat, ps: +List<Pick>) -> Bool:
  match ps:
    case Nil{}:
      False{}
    case p <> rest:
      match p:
        case OrgPick{i, c, m}:
          Nat.is_eq(i, id) || names_org(id, rest)
        case AppPick{i, c}:
          names_org(id, rest)
        case OtherPick{}:
          names_org(id, rest)

def names_app(+id: Nat, ps: +List<Pick>) -> Bool:
  match ps:
    case Nil{}:
      False{}
    case p <> rest:
      match p:
        case OrgPick{i, c, m}:
          names_app(id, rest)
        case AppPick{i, c}:
          Nat.is_eq(i, id) || names_app(id, rest)
        case OtherPick{}:
          names_app(id, rest)

# A listed action answered again later: the second answer is refused
# (account-erasure.ts:970).
def again(p: Pick, +os: +List<OrgAct>, +as: +List<AppAct>, +rest: +List<Pick>) -> Bool:
  match p:
    case OrgPick{+id, c, m}:
      found_org(find_org(id, os)) && names_org(id, rest)
    case AppPick{+id, c}:
      found_app(find_app(id, as)) && names_app(id, rest)
    case OtherPick{}:
      False{}

def any_invalid(+os: +List<OrgAct>, +as: +List<AppAct>, ps: +List<Pick>) -> Bool:
  match ps:
    case Nil{}:
      False{}
    case +p <> +rest:
      (bad(p, os, as) || again(p, os, as, rest)) || any_invalid(os, as, rest)

def any_stale(+as: +List<AppAct>, ps: +List<Pick>) -> Bool:
  match ps:
    case Nil{}:
      False{}
    case p <> rest:
      stale(p, as) || any_stale(as, rest)

# An organisation with no default and no answer.
def open_orgs(os: +List<OrgAct>, +ps: +List<Pick>) -> Bool:
  match os:
    case Nil{}:
      False{}
    case OrgAct{+id, h} <> rest:
      (Bool.not(org_has_default(h)) && Bool.not(names_org(id, ps))) || open_orgs(rest, ps)

# An app action with choices and no default; one with no choices is shown for
# information only.
def needs_answer(offers: +List<Nat>, d: Maybe<&2, Nat>) -> Bool:
  match offers:
    case Nil{}:
      False{}
    case x <> xs:
      match d:
        case None{}:
          True{}
        case Some{v}:
          False{}

def open_apps(as: +List<AppAct>, +ps: +List<Pick>) -> Bool:
  match as:
    case Nil{}:
      False{}
    case AppAct{+id, offers, d} <> rest:
      (needs_answer(offers, d) && Bool.not(names_app(id, ps))) || open_apps(rest, ps)

def is_open(+os: +List<OrgAct>, +as: +List<AppAct>, +ps: +List<Pick>) -> Bool:
  open_orgs(os, ps) || open_apps(as, ps)

# checkErasureChoices: invalid before stale before open (account-erasure.ts:969-1050).
# The two walks over the answers are independent and of the same length, so
# they run as one parallel call.
def check(+os: +List<OrgAct>, +as: +List<AppAct>, +ps: +List<Pick>) -> Verdict:
  invalid stale_found = any_invalid(os, as, ps) any_stale(as, ps)
  Bool.pick(Verdict, invalid, Invalid{},
    Bool.pick(Verdict, stale_found, Stale{},
      Bool.pick(Verdict, is_open(os, as, ps), Open{}, Ok{})))

def is_empty(ps: +List<Pick>) -> Bool:
  match ps:
    case Nil{}:
      True{}
    case p <> rest:
      False{}

def everything_of(r: Req) -> Bool:
  match r:
    case Req{os, as, ps, everything, unchecked}:
      everything

# The route's order (routes/account-erasure.ts:446-518).
def verdict(r: Req) -> Verdict:
  match r:
    case Req{+os, +as, +ps, +everything, unchecked}:
      Bool.pick(Verdict, everything && Bool.not(is_empty(ps)), Both{},
        Bool.pick(Verdict, unchecked, Unchecked{},
          Bool.pick(Verdict, everything, Ok{}, check(os, as, ps))))

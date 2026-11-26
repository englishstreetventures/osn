# One cire wedding's payout account: who holds it, what clears it, and when
# guests may give money. Each event is one whole service call; what happens
# between the statements of one call is not modelled.
#
# The state follows `registry_settings` (the account, its holder, Stripe's
# charges flag, the money-gifts switch and the account generation),
# `registry_retired_accounts`, the wedding's seats and whether it is deleted.
# A seat below owner is an editor here: no payout rule reads which lower
# role it is. The settings row is taken to exist (an attach's insert arm runs
# only at generation 0 with no account, cire/api/src/services/registry.ts
# attachStripeAccount), and every account settles in the wedding's currency,
# so the two currency reasons never arise.
#
# The generation rises by one each time the account goes from a value to
# none: the trigger `registry_settings_stripe_account_generation` in
# cire/api/src/db/setup.ts and cire/db/migrations.

import Base

type Role is Data:
  Owner{}
  Editor{}

type Seat is Data:
  Seat{profile: Nat, role: Role}

# `registry_retired_accounts.reason`: the holder named an owner, or no one;
# another owner retired a seated holder's account; or no current owner held it.
type Reason is Data:
  HandedOver{}
  Disconnected{}
  Replaced{}
  HolderAbsent{}

# One `registry_retired_accounts` row; `released` is `released_at` set.
type Rec is Data:
  Rec{account: Nat, reason: Reason, released: Bool}

type P is Data:
  P{live: Bool, seats: +List<Seat>, account: Maybe<&2, Nat>, holder: Maybe<&2, Nat>, charges: Bool, gifts: Bool, gen: Nat, retired: +List<Rec>}

# `Connect` is the create route's attach, carrying the generation its page
# read; `Join` is a connect that carries none (the OAuth attach and the reuse
# of another wedding's account). `Retire` carries the account the route read,
# which may be none, and the generation the caller's page showed. `Detach` is
# `detachStripeAccount`: Stripe's deauthorization, or cire handing an OAuth
# account back. `Update` is `account.updated` or the live refresh. `Gifts` is
# the settings save's money-gifts switch. `SetRole` is the seat's own holder
# changing it. `Erase` is an OSN account's erasure, with the account's
# profiles.
type Ev is Data:
  Connect{by: Nat, account: Nat, gen: Nat, charges: Bool}
  Join{by: Nat, account: Nat, charges: Bool}
  Retire{by: Nat, hand: Maybe<&2, Nat>, read: Maybe<&2, Nat>, gen: Nat}
  Detach{account: Nat}
  Update{account: Nat, charges: Bool}
  Gifts{on: Bool}
  Add{profile: Nat, role: Role}
  Remove{profile: Nat}
  SetRole{profile: Nat, role: Role}
  Discard{by: Nat}
  Revive{profile: Nat}
  Erase{profiles: +List<Nat>}

# Why guests cannot give money (`moneyGiftsBlockedBy`), or `Open`.
type Block is Data:
  Open{}
  HolderGone{}
  NotReady{}
  GiftsOff{}

# Seats
# -----

def is_owner(r: Role) -> Bool:
  match r:
    case Owner{}:
      True{}
    case Editor{}:
      False{}

def has_owner(ss: +List<Seat>) -> Bool:
  match ss:
    case Nil{}:
      False{}
    case Seat{p, r} <> rest:
      is_owner(r) || has_owner(rest)

def seated(+q: Nat, ss: +List<Seat>) -> Bool:
  match ss:
    case Nil{}:
      False{}
    case Seat{p, r} <> rest:
      Nat.is_eq(p, q) || seated(q, rest)

# Profile `q` holds an owner seat.
def owns(+q: Nat, ss: +List<Seat>) -> Bool:
  match ss:
    case Nil{}:
      False{}
    case Seat{p, r} <> rest:
      (Nat.is_eq(p, q) && is_owner(r)) || owns(q, rest)

def keep_seat(+q: Nat, s: Seat, +rest: +List<Seat>) -> +List<Seat>:
  Seat{+p, +r} = s
  Bool.pick(+List<Seat>, Nat.is_eq(p, q), rest, Seat{p, r} <> rest)

def without(+q: Nat, ss: +List<Seat>) -> +List<Seat>:
  match ss:
    case Nil{}:
      Nil{}
    case s <> rest:
      keep_seat(q, s, without(q, rest))

def set_seat(+q: Nat, +r2: Role, s: Seat) -> Seat:
  Seat{+p, r} = s
  Bool.pick(Seat, Nat.is_eq(p, q), Seat{p, r2}, Seat{p, r})

def set_role(+q: Nat, +r2: Role, ss: +List<Seat>) -> +List<Seat>:
  match ss:
    case Nil{}:
      Nil{}
    case s <> rest:
      set_seat(q, r2, s) <> set_role(q, r2, rest)

def member(+q: Nat, ps: +List<Nat>) -> Bool:
  match ps:
    case Nil{}:
      False{}
    case p <> rest:
      Nat.is_eq(p, q) || member(q, rest)

def keep_unerased(+ps: +List<Nat>, s: Seat, +rest: +List<Seat>) -> +List<Seat>:
  Seat{+p, +r} = s
  Bool.pick(+List<Seat>, member(p, ps), rest, Seat{p, r} <> rest)

# The seats an erasure of the profiles `ps` leaves.
def erase_seats(+ps: +List<Nat>, ss: +List<Seat>) -> +List<Seat>:
  match ss:
    case Nil{}:
      Nil{}
    case s <> rest:
      keep_unerased(ps, s, erase_seats(ps, rest))

# The account and its holder
# --------------------------

def named(m: Maybe<&2, Nat>) -> Bool:
  match m:
    case None{}:
      False{}
    case Some{a}:
      True{}

def is_at(m: Maybe<&2, Nat>, +a: Nat) -> Bool:
  match m:
    case None{}:
      False{}
    case Some{b}:
      Nat.is_eq(b, a)

def seated_holder(h: Maybe<&2, Nat>, +ss: +List<Seat>) -> Bool:
  match h:
    case None{}:
      False{}
    case Some{p}:
      owns(p, ss)

# `payoutHolderAbsentSql` (cire/api/src/services/payout-holder.ts): an account
# is named and its holder holds no owner seat, or none is recorded.
def absent_of(+account: Maybe<&2, Nat>, +holder: Maybe<&2, Nat>, +ss: +List<Seat>) -> Bool:
  named(account) && Bool.not(seated_holder(holder, ss))

# `holdsPayoutAccountSql`: `q` holds the account the wedding names.
def holds(+q: Nat, +account: Maybe<&2, Nat>, +holder: Maybe<&2, Nat>) -> Bool:
  named(account) && is_at(holder, q)

# The erasure clears the holder when it is one of the profiles, and keeps the
# account (account-erasure.ts eraseAccountRows).
def unless_erased(+ps: +List<Nat>, h: Maybe<&2, Nat>) -> Maybe<&2, Nat>:
  match h:
    case None{}:
      None{}
    case Some{+p}:
      Bool.pick(Maybe<&2, Nat>, member(p, ps), None{}, Some{p})

# A retire's hand-over target: none, or another owner, named by the holder.
def hand_ok(+by: Nat, hand: Maybe<&2, Nat>, +holder: Maybe<&2, Nat>, +ss: +List<Seat>) -> Bool:
  match hand:
    case None{}:
      True{}
    case Some{+h}:
      (is_at(holder, by) && Bool.not(Nat.is_eq(h, by))) && owns(h, ss)

# The retire's `CASE` on the row's standing at the write.
def reason(+by: Nat, +hand: Maybe<&2, Nat>, +account: Maybe<&2, Nat>, +holder: Maybe<&2, Nat>, +ss: +List<Seat>) -> Reason:
  Bool.pick(Reason, is_at(holder, by),
    Bool.pick(Reason, named(hand), HandedOver{}, Disconnected{}),
    Bool.pick(Reason, absent_of(account, holder, ss), HolderAbsent{}, Replaced{}))

def release_rec(+a: Nat, r: Rec) -> Rec:
  Rec{+x, why, rel} = r
  Rec{x, why, rel || Nat.is_eq(x, a)}

# A detach releases every retired row naming the account.
def release(+a: Nat, rs: +List<Rec>) -> +List<Rec>:
  match rs:
    case Nil{}:
      Nil{}
    case r <> rest:
      release_rec(a, r) <> release(a, rest)

# Events
# ------

# attachStripeAccount with the generation the create route read: only a row
# naming no account takes one (`coalesce`), from an owner of the live wedding
# (`ownsLiveWedding`), while the row still holds that generation (`setWhere`).
def connect(account: Maybe<&2, Nat>, +by: Nat, +a: Nat, +g: Nat, +c: Bool, +live: Bool, +ss: +List<Seat>, +holder: Maybe<&2, Nat>, +charges: Bool, +gifts: Bool, +gen: Nat, +recs: +List<Rec>) -> P:
  match account:
    case None{}:
      Bool.pick(P, (live && owns(by, ss)) && Nat.is_eq(g, gen),
        P{live, ss, Some{a}, Some{by}, c, gifts, gen, recs},
        P{live, ss, None{}, holder, charges, gifts, gen, recs})
    case Some{+b}:
      P{live, ss, Some{b}, holder, charges, gifts, gen, recs}

# The OAuth attach and adoptStripeAccount: the same, with no generation.
def join(account: Maybe<&2, Nat>, +by: Nat, +a: Nat, +c: Bool, +live: Bool, +ss: +List<Seat>, +holder: Maybe<&2, Nat>, +charges: Bool, +gifts: Bool, +gen: Nat, +recs: +List<Rec>) -> P:
  match account:
    case None{}:
      Bool.pick(P, live && owns(by, ss),
        P{live, ss, Some{a}, Some{by}, c, gifts, gen, recs},
        P{live, ss, None{}, holder, charges, gifts, gen, recs})
    case Some{+b}:
      P{live, ss, Some{b}, holder, charges, gifts, gen, recs}

def read_is(m: Maybe<&2, Nat>, +b: Nat) -> Bool:
  match m:
    case None{}:
      False{}
    case Some{a}:
      Nat.is_eq(b, a)

# retireStripeAccount: one batch whose two statements carry every rule. The
# row names the account the route read, at the generation the caller saw; the
# caller owns the live wedding; a hand-over target is another owner, named by
# the holder. Then a record of the account with its reason, and the account,
# its holder and Stripe's flags cleared; the switch is left as it is. A read
# of no account skips the batch.
def retire(account: Maybe<&2, Nat>, +by: Nat, +hand: Maybe<&2, Nat>, +read: Maybe<&2, Nat>, +g: Nat, +live: Bool, +ss: +List<Seat>, +holder: Maybe<&2, Nat>, +charges: Bool, +gifts: Bool, +gen: Nat, +recs: +List<Rec>) -> P:
  match account:
    case None{}:
      P{live, ss, None{}, holder, charges, gifts, gen, recs}
    case Some{+b}:
      Bool.pick(P, ((read_is(read, b) && Nat.is_eq(g, gen)) && (live && owns(by, ss))) && hand_ok(by, hand, holder, ss),
        P{live, ss, None{}, None{}, False{}, gifts, 1n+gen, Rec{b, reason(by, hand, Some{b}, holder, ss), False{}} <> recs},
        P{live, ss, Some{b}, holder, charges, gifts, gen, recs})

# detachStripeAccount with no Stripe time: the row naming the account loses
# it, its holder and its flags; every retired row naming it is released.
def detach(account: Maybe<&2, Nat>, +a: Nat, +live: Bool, +ss: +List<Seat>, +holder: Maybe<&2, Nat>, +charges: Bool, +gifts: Bool, +gen: Nat, +recs: +List<Rec>) -> P:
  match account:
    case None{}:
      P{live, ss, None{}, holder, charges, gifts, gen, release(a, recs)}
    case Some{+b}:
      Bool.pick(P, Nat.is_eq(b, a),
        P{live, ss, None{}, None{}, False{}, gifts, 1n+gen, release(a, recs)},
        P{live, ss, Some{b}, holder, charges, gifts, gen, release(a, recs)})

def go(e: Ev, +live: Bool, +ss: +List<Seat>, +account: Maybe<&2, Nat>, +holder: Maybe<&2, Nat>, +charges: Bool, +gifts: Bool, +gen: Nat, +recs: +List<Rec>) -> P:
  match e:
    case Connect{by, a, g, c}:
      connect(account, by, a, g, c, live, ss, holder, charges, gifts, gen, recs)
    case Join{by, a, c}:
      join(account, by, a, c, live, ss, holder, charges, gifts, gen, recs)
    case Retire{by, hand, read, g}:
      retire(account, by, hand, read, g, live, ss, holder, charges, gifts, gen, recs)
    case Detach{a}:
      detach(account, a, live, ss, holder, charges, gifts, gen, recs)
    # writeStripeAccountState: every row naming the account.
    case Update{+a, +c}:
      P{live, ss, account, holder, Bool.pick(Bool, is_at(account, a), c, charges), gifts, gen, recs}
    # updateSettings behind the organiser routes' gate, which refuses a
    # deleted wedding: turning money gifts on waits for a seated holder and an
    # account that can take charges (moneyOnRefusal); turning them off never
    # waits.
    case Gifts{on}:
      match on:
        case True{}:
          P{live, ss, account, holder, charges, Bool.pick(Bool, live && (Bool.not(absent_of(account, holder, ss)) && charges), True{}, gifts), gen, recs}
        case False{}:
          P{live, ss, account, holder, charges, Bool.pick(Bool, live, False{}, gifts), gen, recs}
    # The hosts writes, behind the same gate. A removal or a move below owner
    # leaves some owner, and never takes the owner seat of the account's
    # holder (hosts.ts remove and setRole).
    case Add{+q, +r}:
      P{live, Bool.pick(+List<Seat>, live && Bool.not(seated(q, ss)), Seat{q, r} <> ss, ss), account, holder, charges, gifts, gen, recs}
    case Remove{+q}:
      P{live, Bool.pick(+List<Seat>, (live && has_owner(without(q, ss))) && Bool.not(owns(q, ss) && holds(q, account, holder)), without(q, ss), ss), account, holder, charges, gifts, gen, recs}
    case SetRole{+q, +r}:
      P{live, Bool.pick(+List<Seat>, (live && has_owner(set_role(q, r, ss))) && Bool.not((owns(q, ss) && holds(q, account, holder)) && Bool.not(is_owner(r))), set_role(q, r, ss), ss), account, holder, charges, gifts, gen, recs}
    # weddingLifecycleService softDelete and restore: an owner's.
    case Discard{+by}:
      P{Bool.pick(Bool, live && owns(by, ss), False{}, live), ss, account, holder, charges, gifts, gen, recs}
    case Revive{+q}:
      P{live || owns(q, ss), ss, account, holder, charges, gifts, gen, recs}
    # accountErasureService.erase: every seat of the profiles goes, the
    # wedding is deleted once no owner is left, and the holder is cleared when
    # it is one of them. The account stays.
    case Erase{+ps}:
      +rest = erase_seats(ps, ss)
      P{live && has_owner(rest), rest, account, unless_erased(ps, holder), charges, gifts, gen, recs}

def step(s: P, e: Ev) -> P:
  match s:
    case P{live, ss, account, holder, charges, gifts, gen, recs}:
      go(e, live, ss, account, holder, charges, gifts, gen, recs)

# A new wedding: its creator's owner seat, no account, generation 0.
def created(+q: Nat) -> P:
  P{True{}, [Seat{q, Owner{}}], None{}, None{}, False{}, False{}, 0n, []}

def run(es: List<Ev>, s: P) -> P:
  match es:
    case Nil{}:
      s
    case e <> rest:
      run(rest, step(s, e))

def absent(s: P) -> Bool:
  match s:
    case P{live, ss, account, holder, charges, gifts, gen, recs}:
      absent_of(account, holder, ss)

# accountMoneyBlock, with the currency fixed: the holder first, then
# Stripe's flag, then the switch.
def block(s: P) -> Block:
  match s:
    case P{live, +ss, +account, +holder, charges, gifts, gen, recs}:
      Bool.pick(Block, absent_of(account, holder, ss), HolderGone{},
        Bool.pick(Block, charges, Bool.pick(Block, gifts, Open{}, GiftsOff{}), NotReady{}))

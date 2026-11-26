# Proof kit: small lemmas every proof module uses.
#
# `T(b)` is the truth of a Bool as a type: Unit when True, Empty when False,
# so a check that computes to True is its own proof, and one that cannot is
# refuted by the Empty it hands over.

import Base

def T(b: Bool) -> Data:
  match b:
    case True{}:
      Unit
    case False{}:
      Empty

def to_eq(+b: Bool, w: T(b)) -> {b == True{} : Bool}:
  match b:
    case True{}:
      {==}
    case False{}:
      Empty.absurd({False{} == True{} : Bool}, w)

def from_eq(+b: Bool, e: {True{} == b : Bool}) -> T(b):
  match b:
    case True{}:
      Unit{}
    case False{}:
      %e : T(_)
      Unit{}

def and_l(+a: Bool, -b: Bool, w: T(a && b)) -> T(a):
  match a:
    case True{}:
      Unit{}
    case False{}:
      w

def and_r(+a: Bool, -b: Bool, w: T(a && b)) -> T(b):
  match a:
    case True{}:
      w
    case False{}:
      Empty.absurd(T(b), w)

def and_intro(+a: Bool, -b: Bool, wa: T(a), wb: T(b)) -> T(a && b):
  match a:
    case True{}:
      wb
    case False{}:
      Empty.absurd(T(False{} && b), wa)

def or_l(+a: Bool, -b: Bool, w: T(a)) -> T(a || b):
  match a:
    case True{}:
      Unit{}
    case False{}:
      Empty.absurd(T(False{} || b), w)

def or_r(+a: Bool, -b: Bool, w: T(b)) -> T(a || b):
  match a:
    case True{}:
      Unit{}
    case False{}:
      w

# From `a || b` and `not a`, `b`.
def or_not_l(+a: Bool, -b: Bool, w: T(a || b), n: T(Bool.not(a))) -> T(b):
  match a:
    case True{}:
      Empty.absurd(T(b), n)
    case False{}:
      w

# From `not (a || b)`, `not a` and `not b`.
def nor_l(+a: Bool, -b: Bool, w: T(Bool.not(a || b))) -> T(Bool.not(a)):
  match a:
    case True{}:
      w
    case False{}:
      Unit{}

def nor_r(+a: Bool, +b: Bool, w: T(Bool.not(a || b))) -> T(Bool.not(b)):
  match a:
    case True{}:
      Empty.absurd(T(Bool.not(b)), w)
    case False{}:
      w

def not_elim(+a: Bool, wn: T(Bool.not(a)), wa: T(a)) -> Empty:
  match a:
    case True{}:
      wn
    case False{}:
      wa

def not_not(+a: Bool, w: T(Bool.not(Bool.not(a)))) -> T(a):
  match a:
    case True{}:
      Unit{}
    case False{}:
      w

def excluded(+b: Bool) -> T(Bool.not(b) || b):
  match b:
    case True{}:
      Unit{}
    case False{}:
      Unit{}

# `not a || b` from a function that turns `a` into `b`.
def imp_intro(+a: Bool, -b: Bool, f: T(a) -> T(b)) -> T(Bool.not(a) || b):
  match a:
    case True{}:
      f(Unit{})
    case False{}:
      Unit{}

def imp_elim(+a: Bool, -b: Bool, w: T(Bool.not(a) || b), wa: T(a)) -> T(b):
  match a:
    case True{}:
      w
    case False{}:
      Empty.absurd(T(b), wa)

def bool_case(+b: Bool, -P: Bool -> Type,
  t: {True{} == b : Bool} -> P(True{}),
  f: {False{} == b : Bool} -> P(False{})) -> P(b):
  match b:
    case True{}:
      t({==})
    case False{}:
      f({==})

def pick_split(-X: Type, -P: X -> Type, +c: Bool, -a: X, -b: X,
  t: {True{} == c : Bool} -> P(a),
  f: {False{} == c : Bool} -> P(b)) -> P(Bool.pick(X, c, a, b)):
  match c:
    case True{}:
      t({==})
    case False{}:
      f({==})

# Nat
# ---

def eq_refl(n: Nat) -> T(Nat.is_eq(n, n)):
  match n:
    case 0n:
      Unit{}
    case 1n+p:
      eq_refl(p)

def le_refl(n: Nat) -> T(Nat.is_le(n, n)):
  match n:
    case 0n:
      Unit{}
    case 1n+p:
      le_refl(p)

def lt_succ(n: Nat) -> T(Nat.is_lt(n, 1n+n)):
  match n:
    case 0n:
      Unit{}
    case 1n+p:
      lt_succ(p)

def le_max_l(c: Nat, +n: Nat) -> T(Nat.is_le(c, Nat.max(c, n))):
  match c:
    case 0n:
      match n:
        case 0n:
          Unit{}
        case 1n+np:
          Unit{}
    case 1n+cp:
      match n:
        case 0n:
          le_refl(cp)
        case 1n+np:
          le_max_l(cp, np)

# c <= t and t < r give c < r.
def le_lt_lt(c: Nat, t: Nat, r: Nat, le: T(Nat.is_le(c, t)), lt: T(Nat.is_lt(t, r))) -> T(Nat.is_lt(c, r)):
  match c:
    case 0n:
      match t:
        case 0n:
          lt
        case 1n+tp:
          match r:
            case 0n:
              lt
            case 1n+rp:
              Unit{}
    case 1n+cp:
      match t:
        case 0n:
          Empty.absurd(T(Nat.is_lt(1n+cp, r)), le)
        case 1n+tp:
          match r:
            case 0n:
              Empty.absurd(T(Nat.is_lt(1n+cp, 0n)), lt)
            case 1n+rp:
              le_lt_lt(cp, tp, rp, le, lt)

# n <= j and j < m give n <= m.
def le_lt_le(n: Nat, j: Nat, m: Nat, le: T(Nat.is_le(n, j)), lt: T(Nat.is_lt(j, m))) -> T(Nat.is_le(n, m)):
  match n:
    case 0n:
      match m:
        case 0n:
          Unit{}
        case 1n+mp:
          Unit{}
    case 1n+np:
      match j:
        case 0n:
          Empty.absurd(T(Nat.is_le(1n+np, m)), le)
        case 1n+jp:
          match m:
            case 0n:
              Empty.absurd(T(Nat.is_le(1n+np, 0n)), lt)
            case 1n+mp:
              le_lt_le(np, jp, mp, le, lt)

# j < n and n <= k: j is not k.
def lt_le_ne(j: Nat, n: Nat, k: Nat, lt: T(Nat.is_lt(j, n)), le: T(Nat.is_le(n, k))) -> T(Bool.not(Nat.is_eq(j, k))):
  match j:
    case 0n:
      match n:
        case 0n:
          Empty.absurd(T(Bool.not(Nat.is_eq(0n, k))), lt)
        case 1n+np:
          match k:
            case 0n:
              Empty.absurd(T(Bool.not(Nat.is_eq(0n, 0n))), le)
            case 1n+kp:
              Unit{}
    case 1n+jp:
      match n:
        case 0n:
          Empty.absurd(T(Bool.not(Nat.is_eq(1n+jp, k))), lt)
        case 1n+np:
          match k:
            case 0n:
              Unit{}
            case 1n+kp:
              lt_le_ne(jp, np, kp, lt, le)

def to_false(+b: Bool, w: T(Bool.not(b))) -> {b == False{} : Bool}:
  match b:
    case True{}:
      Empty.absurd({True{} == False{} : Bool}, w)
    case False{}:
      {==}

def nn_intro(+b: Bool, w: T(b)) -> T(Bool.not(Bool.not(b))):
  match b:
    case True{}:
      Unit{}
    case False{}:
      w

# `a` implies True.
def imp_true(+a: Bool) -> {(Bool.not(a) || True{}) == True{} : Bool}:
  match a:
    case True{}:
      {==}
    case False{}:
      {==}

# From `(x && False) || y`, `y`.
def drop_false_and(+x: Bool, -y: Bool, w: T((x && False{}) || y)) -> T(y):
  match x:
    case True{}:
      w
    case False{}:
      w

# `a || b` with `b` turned into `c`.
def or_map(+a: Bool, -b: Bool, -c: Bool, w: T(a || b), f: T(b) -> T(c)) -> T(a || c):
  match a:
    case True{}:
      Unit{}
    case False{}:
      f(w)

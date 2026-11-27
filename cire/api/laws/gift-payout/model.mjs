function word_to_u32(w) {
  let x = 0;
  for (let i = 0; w.$ === "WCon"; i++) {
    x |= Number(w.head) << i;
    w = w.tail;
  }
  return x >>> 0;
}

function u32_to_word(x) {
  let w = {$: "WNil"};
  for (let i = 31; i >= 0; i--) {
    w = {$: "WCon", head: ((x >>> i) & 1) === 1, tail: w};
  }
  return w;
}

function cmp_new(a, b) {
  return {$: a < b ? "LT" : a === b ? "EQ" : "GT"};
}

function tup_new(a, b) {
  return {$: "Tuple", fst: a, snd: b};
}

function nat_divmod(a, b) {
  return tup_new(b && Math.trunc(a / b), b ? a % b : a);
}

function nat_chk(n) {
  if (n > 281474976710655) {
    throw "bend: a Nat past the largest immediate 2^48-1";
  }
  return n;
}

function nat_in(n) {
  if (!Number.isInteger(n) || n < 0 || n > 2 ** 53) {
    throw "bend: expected a Nat host number: an integer from 0 to 2^53";
  }
  return n;
}

function f32_show(x) {
  let s = "nan";
  for (let p = 1; x === x && p <= 9 && f32_round(s) !== x; p += 1) {
    s = String(Number(x.toExponential(p - 1)));
  }
  return (Object.is(x, -0) ? "-0" : s).replace("Infinity", "inf");
}

function f32_bits(x) {
  return new Uint32Array(new Float32Array([x]).buffer)[0];
}

function f32_from_bits(u) {
  return new Float32Array(new Uint32Array([u]).buffer)[0];
}

function f32_read(s) {
  const re = /^[\t\n\v\f\r ]*[+-]?((\d+(?:\.\d*)?|\.\d+)(e[+-]?\d+)?|inf(inity)?|nan)$/i;
  return re.test(s) ? {$: "Some", value: f32_round(
    s.replace(/inf\w*/i, "Infinity"))} : {$: "None"};
}

const f32_round = function f32_round(s) {
  const d = Number(s);
  const a = Math.abs(d);
  const f = Math.fround(a);
  const g = 2 * a - Math.min(f, 2 ** 128);
  if (g === f || Math.fround(g) !== g || g === Infinity) {
    return Math.sign(d) * f;
  }
  let k = 0;
  while (a * 2 ** k % 1 !== 0) {
    k += 1;
  }
  const [, i, r, e] = /(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i.exec(s);
  const n = Number(e ?? 0) - r.length;
  const x = BigInt(i + r) * 2n ** BigInt(k) * 10n ** BigInt(Math.max(n, 0));
  const y = BigInt(a * 2 ** k) * 10n ** BigInt(Math.max(-n, 0));
  return Math.sign(d) * (x === y || x > y !== g > f ? f : g);
};

const char_new = function char_new(c) {
  return c < 55296 || c >= 57344 && c <= 1114111 ? String.fromCodePoint(c) : String.fromCharCode(56320, c >>> 22, c >>> 11 & 2047, c & 2047);
};

function char_len(s, at = 0) {
  return s[at] === "\uDC00" ? 4 : s.codePointAt(at) > 0xFFFF ? 2 : 1;
}

function char_code(s) {
  return s.length < 4 ? s.codePointAt(0)
    : (s.charCodeAt(1) << 22 | s.charCodeAt(2) << 11 | s.charCodeAt(3)) >>> 0;
}

function string_contains(s, p) {
  // A match starts at a Char, not inside a packed U32 code.
  for (let at = 0; at <= s.length; at += char_len(s, at)) {
    if (s.startsWith(p, at)) {
      return true;
    }
  }
  return false;
}

function str_out(s) {
  return s.replace(/\uDC00[^]{3}/gu, "\uFFFD");
}

function str_in(s) {
  return s.replace(/\p{Cs}/gu, "\uFFFD");
}

// Array
// =====

function array_new(d, v, lgs) {
  if (d > 31 - lgs) {
    throw "bend: an array past the deepest block class 31 (depth + log2 words per cell)";
  }
  return Array(2 ** d).fill(v);
}

function array_node(a, b) {
  if (a.length !== b.length) {
    throw "bend: runtime fail-stop";
  }
  return a.concat(b);
}

function array_rmw(a, i, f) {
  const old = a[i %= a.length];
  a[i] = f(old);
  return tup_new(a, old);
}

// Run
// ===

function run_tail(f, x) {
  return {$: "$JMP", f: f.j?.f === f ? f.j : f, x};
}

function run_clo(j) {
  const f = (x) => run_loop(j(x));
  f.j = j;
  j.f = f;
  return f;
}

function run_loop(r) {
  while (r !== null && typeof r === "object" && r.$ === "$JMP") {
    r = r.f(r.x);
  }
  return r;
}

function run_lib(f, n) {
  return (...a) => a.length < n ? run_lib((...b) => f(...a, ...b), n - a.length)
    : run_loop(f(...a));
}

// Effect
// ======

const $0eff = Object.create(null);
const io_file_append = new Set();

function io_eff(k, run) {
  if (arguments.length > 2) {
    throw new Error("bend: " + k + " takes no need: an effect that waits parks itself");
  }
  if (k in $0eff) {
    throw new Error("bend: two effects register " + k);
  }
  $0eff[k] = run;
}
// Program
// =======

function $payout_is_owner(_r_0) {
  if (_r_0.$ === "Owner") {
    return true;
  } else {
    return false;
  }
}

function $payout_has_owner(_ss_0) {
  if (_ss_0.$ === "Nil") {
    return false;
  } else {
    const _t_0 = _ss_0["head"];
    const _r_0 = _t_0["role"];
    const _rest_0 = _ss_0["tail"];
    const _x_0 = $$payout_is_owner(_r_0);
    const _x_1 = $$payout_has_owner(_rest_0);
    return (_x_0 || _x_1);
  }
}

function $payout_seated(_q_0, _ss_0) {
  if (_ss_0.$ === "Nil") {
    return false;
  } else {
    const _t_0 = _ss_0["head"];
    const _p_0 = _t_0["profile"];
    const _rest_0 = _ss_0["tail"];
    const _x_0 = $$Nat_is_eq(_p_0, _q_0);
    const _x_1 = $$payout_seated(_q_0, _rest_0);
    return (_x_0 || _x_1);
  }
}

function $payout_owns(_q_0, _ss_0) {
  if (_ss_0.$ === "Nil") {
    return false;
  } else {
    const _t_0 = _ss_0["head"];
    const _p_0 = _t_0["profile"];
    const _r_0 = _t_0["role"];
    const _rest_0 = _ss_0["tail"];
    const _x_0 = $$Bool_and($$Nat_is_eq(_p_0, _q_0), $$payout_is_owner(_r_0));
    const _x_1 = $$payout_owns(_q_0, _rest_0);
    return (_x_0 || _x_1);
  }
}

function $payout_keep_seat(_q_0, _s_0, _rest_0) {
  const _p_0 = _s_0["profile"];
  const _r_0 = _s_0["role"];
  return $Bool_pick($$Nat_is_eq(_p_0, _q_0), _rest_0, {$: "Con", "head": {$: "Seat", "profile": _p_0, "role": _r_0}, "tail": _rest_0});
}

function $payout_without(_q_0, _ss_0) {
  if (_ss_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _s_0 = _ss_0["head"];
    const _rest_0 = _ss_0["tail"];
    return $payout_keep_seat(_q_0, _s_0, $$payout_without(_q_0, _rest_0));
  }
}

function $payout_set_seat(_q_0, _r2_0, _s_0) {
  const _p_0 = _s_0["profile"];
  const _r_0 = _s_0["role"];
  return $Bool_pick($$Nat_is_eq(_p_0, _q_0), {$: "Seat", "profile": _p_0, "role": _r2_0}, {$: "Seat", "profile": _p_0, "role": _r_0});
}

function $payout_set_role(_q_0, _r2_0, _ss_0) {
  if (_ss_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _s_0 = _ss_0["head"];
    const _rest_0 = _ss_0["tail"];
    return {$: "Con", "head": $$payout_set_seat(_q_0, _r2_0, _s_0), "tail": $$payout_set_role(_q_0, _r2_0, _rest_0)};
  }
}

function $payout_member(_q_0, _ps_0) {
  if (_ps_0.$ === "Nil") {
    return false;
  } else {
    const _p_0 = _ps_0["head"];
    const _rest_0 = _ps_0["tail"];
    const _x_0 = $$Nat_is_eq(_p_0, _q_0);
    const _x_1 = $$payout_member(_q_0, _rest_0);
    return (_x_0 || _x_1);
  }
}

function $payout_keep_unerased(_ps_0, _s_0, _rest_0) {
  const _p_0 = _s_0["profile"];
  const _r_0 = _s_0["role"];
  return $Bool_pick($$payout_member(_p_0, _ps_0), _rest_0, {$: "Con", "head": {$: "Seat", "profile": _p_0, "role": _r_0}, "tail": _rest_0});
}

function $payout_erase_seats(_ps_0, _ss_0) {
  if (_ss_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _s_0 = _ss_0["head"];
    const _rest_0 = _ss_0["tail"];
    return $payout_keep_unerased(_ps_0, _s_0, $$payout_erase_seats(_ps_0, _rest_0));
  }
}

function $payout_named(_m_0) {
  if (_m_0.$ === "None") {
    return false;
  } else {
    return true;
  }
}

function $payout_is_at(_m_0, _a_0) {
  if (_m_0.$ === "None") {
    return false;
  } else {
    const _b_0 = _m_0["value"];
    return $Nat_is_eq(_b_0, _a_0);
  }
}

function $payout_seated_holder(_h_0, _ss_0) {
  if (_h_0.$ === "None") {
    return false;
  } else {
    const _p_0 = _h_0["value"];
    return $payout_owns(_p_0, _ss_0);
  }
}

function $payout_absent_of(_account_0, _holder_0, _ss_0) {
  return $Bool_and($$payout_named(_account_0), $$Bool_not($$payout_seated_holder(_holder_0, _ss_0)));
}

function $payout_holds(_q_0, _account_0, _holder_0) {
  return $Bool_and($$payout_named(_account_0), $$payout_is_at(_holder_0, _q_0));
}

function $payout_unless_erased(_ps_0, _h_0) {
  if (_h_0.$ === "None") {
    return {$: "None"};
  } else {
    const _p_0 = _h_0["value"];
    return $Bool_pick($$payout_member(_p_0, _ps_0), {$: "None"}, {$: "Some", "value": _p_0});
  }
}

function $payout_hand_ok(_by_0, _hand_0, _holder_0, _ss_0) {
  if (_hand_0.$ === "None") {
    return true;
  } else {
    const _h_0 = _hand_0["value"];
    return $Bool_and($$Bool_and($$payout_is_at(_holder_0, _by_0), $$Bool_not($$Nat_is_eq(_h_0, _by_0))), $$payout_owns(_h_0, _ss_0));
  }
}

function $payout_reason(_by_0, _hand_0, _account_0, _holder_0, _ss_0) {
  return $Bool_pick($$payout_is_at(_holder_0, _by_0), $$Bool_pick($$payout_named(_hand_0), {$: "HandedOver"}, {$: "Disconnected"}), $$Bool_pick($$payout_absent_of(_account_0, _holder_0, _ss_0), {$: "HolderAbsent"}, {$: "Replaced"}));
}

function $payout_release_rec(_a_0, _r_0) {
  const _x_0 = _r_0["account"];
  const _why_0 = _r_0["reason"];
  const _rel_0 = _r_0["released"];
  const _x_1 = $$Nat_is_eq(_x_0, _a_0);
  return {$: "Rec", "account": _x_0, "reason": _why_0, "released": (_rel_0 || _x_1)};
}

function $payout_release(_a_0, _rs_0) {
  if (_rs_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _r_0 = _rs_0["head"];
    const _rest_0 = _rs_0["tail"];
    return {$: "Con", "head": $$payout_release_rec(_a_0, _r_0), "tail": $$payout_release(_a_0, _rest_0)};
  }
}

function $payout_connect(_account_0, _by_0, _a_0, _g_0, _c_0, _live_0, _ss_0, _holder_0, _charges_0, _gifts_0, _gen_0, _recs_0) {
  if (_account_0.$ === "None") {
    return $Bool_pick($$Bool_and($$Bool_and(_live_0, $$payout_owns(_by_0, _ss_0)), $$Nat_is_eq(_g_0, _gen_0)), {$: "P", "live": _live_0, "seats": _ss_0, "account": {$: "Some", "value": _a_0}, "holder": {$: "Some", "value": _by_0}, "charges": _c_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0}, {$: "P", "live": _live_0, "seats": _ss_0, "account": {$: "None"}, "holder": _holder_0, "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0});
  } else {
    const _b_0 = _account_0["value"];
    return {$: "P", "live": _live_0, "seats": _ss_0, "account": {$: "Some", "value": _b_0}, "holder": _holder_0, "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0};
  }
}

function $payout_join(_account_0, _by_0, _a_0, _c_0, _live_0, _ss_0, _holder_0, _charges_0, _gifts_0, _gen_0, _recs_0) {
  if (_account_0.$ === "None") {
    return $Bool_pick($$Bool_and(_live_0, $$payout_owns(_by_0, _ss_0)), {$: "P", "live": _live_0, "seats": _ss_0, "account": {$: "Some", "value": _a_0}, "holder": {$: "Some", "value": _by_0}, "charges": _c_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0}, {$: "P", "live": _live_0, "seats": _ss_0, "account": {$: "None"}, "holder": _holder_0, "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0});
  } else {
    const _b_0 = _account_0["value"];
    return {$: "P", "live": _live_0, "seats": _ss_0, "account": {$: "Some", "value": _b_0}, "holder": _holder_0, "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0};
  }
}

function $payout_read_is(_m_0, _b_0) {
  if (_m_0.$ === "None") {
    return false;
  } else {
    const _a_0 = _m_0["value"];
    return $Nat_is_eq(_b_0, _a_0);
  }
}

function $payout_retire(_account_0, _by_0, _hand_0, _read_0, _g_0, _live_0, _ss_0, _holder_0, _charges_0, _gifts_0, _gen_0, _recs_0) {
  if (_account_0.$ === "None") {
    return {$: "P", "live": _live_0, "seats": _ss_0, "account": {$: "None"}, "holder": _holder_0, "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0};
  } else {
    const _b_0 = _account_0["value"];
    return $Bool_pick($$Bool_and($$Bool_and($$Bool_and($$payout_read_is(_read_0, _b_0), $$Nat_is_eq(_g_0, _gen_0)), $$Bool_and(_live_0, $$payout_owns(_by_0, _ss_0))), $$payout_hand_ok(_by_0, _hand_0, _holder_0, _ss_0)), {$: "P", "live": _live_0, "seats": _ss_0, "account": {$: "None"}, "holder": {$: "None"}, "charges": false, "gifts": _gifts_0, "gen": nat_chk(_gen_0 + 1), "retired": {$: "Con", "head": {$: "Rec", "account": _b_0, "reason": $$payout_reason(_by_0, _hand_0, {$: "Some", "value": _b_0}, _holder_0, _ss_0), "released": false}, "tail": _recs_0}}, {$: "P", "live": _live_0, "seats": _ss_0, "account": {$: "Some", "value": _b_0}, "holder": _holder_0, "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0});
  }
}

function $payout_detach(_account_0, _a_0, _live_0, _ss_0, _holder_0, _charges_0, _gifts_0, _gen_0, _recs_0) {
  if (_account_0.$ === "None") {
    return {$: "P", "live": _live_0, "seats": _ss_0, "account": {$: "None"}, "holder": _holder_0, "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": $$payout_release(_a_0, _recs_0)};
  } else {
    const _b_0 = _account_0["value"];
    return $Bool_pick($$Nat_is_eq(_b_0, _a_0), {$: "P", "live": _live_0, "seats": _ss_0, "account": {$: "None"}, "holder": {$: "None"}, "charges": false, "gifts": _gifts_0, "gen": nat_chk(_gen_0 + 1), "retired": $$payout_release(_a_0, _recs_0)}, {$: "P", "live": _live_0, "seats": _ss_0, "account": {$: "Some", "value": _b_0}, "holder": _holder_0, "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": $$payout_release(_a_0, _recs_0)});
  }
}

function $payout_go(_e_0, _live_0, _ss_0, _account_0, _holder_0, _charges_0, _gifts_0, _gen_0, _recs_0) {
  if (_e_0.$ === "Connect") {
    const _by_0 = _e_0["by"];
    const _a_0 = _e_0["account"];
    const _g_0 = _e_0["gen"];
    const _c_0 = _e_0["charges"];
    return $payout_connect(_account_0, _by_0, _a_0, _g_0, _c_0, _live_0, _ss_0, _holder_0, _charges_0, _gifts_0, _gen_0, _recs_0);
  } else if (_e_0.$ === "Join") {
    const _by_1 = _e_0["by"];
    const _a_1 = _e_0["account"];
    const _c_1 = _e_0["charges"];
    return $payout_join(_account_0, _by_1, _a_1, _c_1, _live_0, _ss_0, _holder_0, _charges_0, _gifts_0, _gen_0, _recs_0);
  } else if (_e_0.$ === "Retire") {
    const _by_2 = _e_0["by"];
    const _hand_0 = _e_0["hand"];
    const _read_0 = _e_0["read"];
    const _g_1 = _e_0["gen"];
    return $payout_retire(_account_0, _by_2, _hand_0, _read_0, _g_1, _live_0, _ss_0, _holder_0, _charges_0, _gifts_0, _gen_0, _recs_0);
  } else if (_e_0.$ === "Detach") {
    const _a_2 = _e_0["account"];
    return $payout_detach(_account_0, _a_2, _live_0, _ss_0, _holder_0, _charges_0, _gifts_0, _gen_0, _recs_0);
  } else if (_e_0.$ === "Update") {
    const _a_3 = _e_0["account"];
    const _c_2 = _e_0["charges"];
    return {$: "P", "live": _live_0, "seats": _ss_0, "account": _account_0, "holder": _holder_0, "charges": $$Bool_pick($$payout_is_at(_account_0, _a_3), _c_2, _charges_0), "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0};
  } else if (_e_0.$ === "Gifts") {
    const _t_0 = _e_0["on"];
    if (_t_0) {
      return {$: "P", "live": _live_0, "seats": _ss_0, "account": _account_0, "holder": _holder_0, "charges": _charges_0, "gifts": $$Bool_pick($$Bool_and(_live_0, $$Bool_and($$Bool_not($$payout_absent_of(_account_0, _holder_0, _ss_0)), _charges_0)), true, _gifts_0), "gen": _gen_0, "retired": _recs_0};
    } else {
      return {$: "P", "live": _live_0, "seats": _ss_0, "account": _account_0, "holder": _holder_0, "charges": _charges_0, "gifts": $$Bool_pick(_live_0, false, _gifts_0), "gen": _gen_0, "retired": _recs_0};
    }
  } else if (_e_0.$ === "Add") {
    const _q_0 = _e_0["profile"];
    const _r_0 = _e_0["role"];
    return {$: "P", "live": _live_0, "seats": $$Bool_pick($$Bool_and(_live_0, $$Bool_not($$payout_seated(_q_0, _ss_0))), {$: "Con", "head": {$: "Seat", "profile": _q_0, "role": _r_0}, "tail": _ss_0}, _ss_0), "account": _account_0, "holder": _holder_0, "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0};
  } else if (_e_0.$ === "Remove") {
    const _q_1 = _e_0["profile"];
    return {$: "P", "live": _live_0, "seats": $$Bool_pick($$Bool_and($$Bool_and(_live_0, $$payout_has_owner($$payout_without(_q_1, _ss_0))), $$Bool_not($$Bool_and($$payout_owns(_q_1, _ss_0), $$payout_holds(_q_1, _account_0, _holder_0)))), $$payout_without(_q_1, _ss_0), _ss_0), "account": _account_0, "holder": _holder_0, "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0};
  } else if (_e_0.$ === "SetRole") {
    const _q_2 = _e_0["profile"];
    const _r_1 = _e_0["role"];
    return {$: "P", "live": _live_0, "seats": $$Bool_pick($$Bool_and($$Bool_and(_live_0, $$payout_has_owner($$payout_set_role(_q_2, _r_1, _ss_0))), $$Bool_not($$Bool_and($$Bool_and($$payout_owns(_q_2, _ss_0), $$payout_holds(_q_2, _account_0, _holder_0)), $$Bool_not($$payout_is_owner(_r_1))))), $$payout_set_role(_q_2, _r_1, _ss_0), _ss_0), "account": _account_0, "holder": _holder_0, "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0};
  } else if (_e_0.$ === "Discard") {
    const _by_3 = _e_0["by"];
    return {$: "P", "live": $$Bool_pick($$Bool_and(_live_0, $$payout_owns(_by_3, _ss_0)), false, _live_0), "seats": _ss_0, "account": _account_0, "holder": _holder_0, "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0};
  } else if (_e_0.$ === "Revive") {
    const _q_3 = _e_0["profile"];
    const _x_0 = $$payout_owns(_q_3, _ss_0);
    return {$: "P", "live": (_live_0 || _x_0), "seats": _ss_0, "account": _account_0, "holder": _holder_0, "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0};
  } else {
    const _ps_0 = _e_0["profiles"];
    const _rest_0 = $$payout_erase_seats(_ps_0, _ss_0);
    return {$: "P", "live": $$Bool_and(_live_0, $$payout_has_owner(_rest_0)), "seats": _rest_0, "account": _account_0, "holder": $$payout_unless_erased(_ps_0, _holder_0), "charges": _charges_0, "gifts": _gifts_0, "gen": _gen_0, "retired": _recs_0};
  }
}

function $payout_step(_s_0, _e_0) {
  const _live_0 = _s_0["live"];
  const _ss_0 = _s_0["seats"];
  const _account_0 = _s_0["account"];
  const _holder_0 = _s_0["holder"];
  const _charges_0 = _s_0["charges"];
  const _gifts_0 = _s_0["gifts"];
  const _gen_0 = _s_0["gen"];
  const _recs_0 = _s_0["retired"];
  return $payout_go(_e_0, _live_0, _ss_0, _account_0, _holder_0, _charges_0, _gifts_0, _gen_0, _recs_0);
}

function $payout_created(_q_0) {
  return {$: "P", "live": true, "seats": {$: "Con", "head": {$: "Seat", "profile": _q_0, "role": {$: "Owner"}}, "tail": {$: "Nil"}}, "account": {$: "None"}, "holder": {$: "None"}, "charges": false, "gifts": false, "gen": 0, "retired": {$: "Nil"}};
}

function $payout_run($0, $1) {
  for (;;) {
    {
      const _es_0 = $0;
      const _s_0 = $1;
      if (_es_0.$ === "Nil") {
        return _s_0;
      } else {
        const _e_0 = _es_0["head"];
        const _rest_0 = _es_0["tail"];
        $0 = _rest_0;
        $1 = $$payout_step(_s_0, _e_0);
        continue;
      }
    }
  }
}

function $payout_absent(_s_0) {
  const _ss_0 = _s_0["seats"];
  const _account_0 = _s_0["account"];
  const _holder_0 = _s_0["holder"];
  return $payout_absent_of(_account_0, _holder_0, _ss_0);
}

function $payout_block(_s_0) {
  const _ss_0 = _s_0["seats"];
  const _account_0 = _s_0["account"];
  const _holder_0 = _s_0["holder"];
  const _charges_0 = _s_0["charges"];
  const _gifts_0 = _s_0["gifts"];
  return $Bool_pick($$payout_absent_of(_account_0, _holder_0, _ss_0), {$: "HolderGone"}, $$Bool_pick(_charges_0, $$Bool_pick(_gifts_0, {$: "Open"}, {$: "GiftsOff"}), {$: "NotReady"}));
}

function $Nat_is_eq(_a_0, _b_0) {
  return $Cmp_is_eq(cmp_new(_a_0, _b_0));
}

function $Bool_and(_a_0, _b_0) {
  if (!_a_0) {
    return false;
  } else {
    return _b_0;
  }
}

function $Bool_pick(_c_0, _a_0, _b_0) {
  if (!_c_0) {
    return _b_0;
  } else {
    return _a_0;
  }
}

function $Bool_not(_b_0) {
  if (!_b_0) {
    return true;
  } else {
    return false;
  }
}

function $Cmp_is_eq(_c_0) {
  if (_c_0.$ === "EQ") {
    return true;
  } else {
    return false;
  }
}

const $$payout_is_owner = $payout_is_owner;
const $$payout_has_owner = $payout_has_owner;
const $$Nat_is_eq = $Nat_is_eq;
const $$payout_seated = $payout_seated;
const $$Bool_and = $Bool_and;
const $$payout_owns = $payout_owns;
const $$payout_without = $payout_without;
const $$payout_set_seat = $payout_set_seat;
const $$payout_set_role = $payout_set_role;
const $$payout_member = $payout_member;
const $$payout_erase_seats = $payout_erase_seats;
const $$payout_named = $payout_named;
const $$payout_seated_holder = $payout_seated_holder;
const $$Bool_not = $Bool_not;
const $$payout_is_at = $payout_is_at;
const $$Bool_pick = $Bool_pick;
const $$payout_absent_of = $payout_absent_of;
const $$payout_release_rec = $payout_release_rec;
const $$payout_release = $payout_release;
const $$payout_read_is = $payout_read_is;
const $$payout_hand_ok = $payout_hand_ok;
const $$payout_reason = $payout_reason;
const $$payout_holds = $payout_holds;
const $$payout_unless_erased = $payout_unless_erased;
const $$payout_step = $payout_step;export default {
  "payout:is_owner": run_lib((a0) => run_loop($payout_is_owner(a0)), 1),
  "payout:has_owner": run_lib((a0) => run_loop($payout_has_owner(a0)), 1),
  "payout:seated": run_lib((a0,a1) => run_loop($payout_seated(nat_in(a0),a1)), 2),
  "payout:owns": run_lib((a0,a1) => run_loop($payout_owns(nat_in(a0),a1)), 2),
  "payout:keep_seat": run_lib((a0,a1,a2) => run_loop($payout_keep_seat(nat_in(a0),a1,a2)), 3),
  "payout:without": run_lib((a0,a1) => run_loop($payout_without(nat_in(a0),a1)), 2),
  "payout:set_seat": run_lib((a0,a1,a2) => run_loop($payout_set_seat(nat_in(a0),a1,a2)), 3),
  "payout:set_role": run_lib((a0,a1,a2) => run_loop($payout_set_role(nat_in(a0),a1,a2)), 3),
  "payout:member": run_lib((a0,a1) => run_loop($payout_member(nat_in(a0),a1)), 2),
  "payout:keep_unerased": run_lib((a0,a1,a2) => run_loop($payout_keep_unerased(a0,a1,a2)), 3),
  "payout:erase_seats": run_lib((a0,a1) => run_loop($payout_erase_seats(a0,a1)), 2),
  "payout:named": run_lib((a0) => run_loop($payout_named(a0)), 1),
  "payout:is_at": run_lib((a0,a1) => run_loop($payout_is_at(a0,nat_in(a1))), 2),
  "payout:seated_holder": run_lib((a0,a1) => run_loop($payout_seated_holder(a0,a1)), 2),
  "payout:absent_of": run_lib((a0,a1,a2) => run_loop($payout_absent_of(a0,a1,a2)), 3),
  "payout:holds": run_lib((a0,a1,a2) => run_loop($payout_holds(nat_in(a0),a1,a2)), 3),
  "payout:unless_erased": run_lib((a0,a1) => run_loop($payout_unless_erased(a0,a1)), 2),
  "payout:hand_ok": run_lib((a0,a1,a2,a3) => run_loop($payout_hand_ok(nat_in(a0),a1,a2,a3)), 4),
  "payout:reason": run_lib((a0,a1,a2,a3,a4) => run_loop($payout_reason(nat_in(a0),a1,a2,a3,a4)), 5),
  "payout:release_rec": run_lib((a0,a1) => run_loop($payout_release_rec(nat_in(a0),a1)), 2),
  "payout:release": run_lib((a0,a1) => run_loop($payout_release(nat_in(a0),a1)), 2),
  "payout:connect": run_lib((a0,a1,a2,a3,a4,a5,a6,a7,a8,a9,a10,a11) => run_loop($payout_connect(a0,nat_in(a1),nat_in(a2),nat_in(a3),a4,a5,a6,a7,a8,a9,nat_in(a10),a11)), 12),
  "payout:join": run_lib((a0,a1,a2,a3,a4,a5,a6,a7,a8,a9,a10) => run_loop($payout_join(a0,nat_in(a1),nat_in(a2),a3,a4,a5,a6,a7,a8,nat_in(a9),a10)), 11),
  "payout:read_is": run_lib((a0,a1) => run_loop($payout_read_is(a0,nat_in(a1))), 2),
  "payout:retire": run_lib((a0,a1,a2,a3,a4,a5,a6,a7,a8,a9,a10,a11) => run_loop($payout_retire(a0,nat_in(a1),a2,a3,nat_in(a4),a5,a6,a7,a8,a9,nat_in(a10),a11)), 12),
  "payout:detach": run_lib((a0,a1,a2,a3,a4,a5,a6,a7,a8) => run_loop($payout_detach(a0,nat_in(a1),a2,a3,a4,a5,a6,nat_in(a7),a8)), 9),
  "payout:go": run_lib((a0,a1,a2,a3,a4,a5,a6,a7,a8) => run_loop($payout_go(a0,a1,a2,a3,a4,a5,a6,nat_in(a7),a8)), 9),
  "payout:step": run_lib((a0,a1) => run_loop($payout_step(a0,a1)), 2),
  "payout:created": run_lib((a0) => run_loop($payout_created(nat_in(a0))), 1),
  "payout:run": run_lib((a0,a1) => run_loop($payout_run(a0,a1)), 2),
  "payout:absent": run_lib((a0) => run_loop($payout_absent(a0)), 1),
  "payout:block": run_lib((a0) => run_loop($payout_block(a0)), 1),
};

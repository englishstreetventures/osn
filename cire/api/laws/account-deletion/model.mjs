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

function $____________osn_api_laws_account_deletion_choices_delete_choice() {
  return 0;
}

function $____________osn_api_laws_account_deletion_choices_is_ok(_v_0) {
  if (_v_0.$ === "Ok") {
    return true;
  } else if (_v_0.$ === "Invalid") {
    return false;
  } else if (_v_0.$ === "Stale") {
    return false;
  } else if (_v_0.$ === "Open") {
    return false;
  } else if (_v_0.$ === "Unchecked") {
    return false;
  } else {
    return false;
  }
}

function $____________osn_api_laws_account_deletion_choices_has_nat(_x_0, _xs_0) {
  if (_xs_0.$ === "Nil") {
    return false;
  } else {
    const _y_0 = _xs_0["head"];
    const _rest_0 = _xs_0["tail"];
    const _x_1 = $$Nat_is_eq(_y_0, _x_0);
    const _x_2 = $$____________osn_api_laws_account_deletion_choices_has_nat(_x_0, _rest_0);
    return (_x_1 || _x_2);
  }
}

function $____________osn_api_laws_account_deletion_choices_is_delete(_c_0) {
  if (_c_0.$ === "Transfer") {
    return false;
  } else if (_c_0.$ === "Successor") {
    return false;
  } else {
    return true;
  }
}

function $____________osn_api_laws_account_deletion_choices_is_successor(_c_0) {
  if (_c_0.$ === "Transfer") {
    return false;
  } else if (_c_0.$ === "Successor") {
    return true;
  } else {
    return false;
  }
}

function $____________osn_api_laws_account_deletion_choices_org_offers(_h_0, _c_0) {
  if (_h_0.$ === "Nobody") {
    return $____________osn_api_laws_account_deletion_choices_is_delete(_c_0);
  } else if (_h_0.$ === "Member") {
    return true;
  } else {
    return true;
  }
}

function $____________osn_api_laws_account_deletion_choices_org_has_default(_h_0) {
  if (_h_0.$ === "Nobody") {
    return false;
  } else if (_h_0.$ === "Member") {
    return false;
  } else {
    return true;
  }
}

function $____________osn_api_laws_account_deletion_choices_find_org(_id_0, _os_0) {
  if (_os_0.$ === "Nil") {
    return {$: "None"};
  } else {
    const _t_0 = _os_0["head"];
    const _i_0 = _t_0["id"];
    const _h_0 = _t_0["heir"];
    const _rest_0 = _os_0["tail"];
    return $Bool_pick($$Nat_is_eq(_i_0, _id_0), {$: "Some", "value": _h_0}, $$____________osn_api_laws_account_deletion_choices_find_org(_id_0, _rest_0));
  }
}

function $____________osn_api_laws_account_deletion_choices_find_app(_id_0, _as_0) {
  if (_as_0.$ === "Nil") {
    return {$: "None"};
  } else {
    const _t_0 = _as_0["head"];
    const _i_0 = _t_0["id"];
    const _offers_0 = _t_0["offers"];
    const _rest_0 = _as_0["tail"];
    return $Bool_pick($$Nat_is_eq(_i_0, _id_0), {$: "Some", "value": _offers_0}, $$____________osn_api_laws_account_deletion_choices_find_app(_id_0, _rest_0));
  }
}

function $____________osn_api_laws_account_deletion_choices_org_bad(_h_0, _c_0, _member_0) {
  if (_h_0.$ === "None") {
    return false;
  } else {
    const _x_0 = _h_0["value"];
    const _x_1 = $$Bool_not($$____________osn_api_laws_account_deletion_choices_org_offers(_x_0, _c_0));
    const _x_2 = $$Bool_and($$____________osn_api_laws_account_deletion_choices_is_successor(_c_0), $$Bool_not(_member_0));
    return (_x_1 || _x_2);
  }
}

function $____________osn_api_laws_account_deletion_choices_app_bad(_o_0, _c_0) {
  if (_o_0.$ === "None") {
    return false;
  } else {
    const _offers_0 = _o_0["value"];
    return $Bool_not($$____________osn_api_laws_account_deletion_choices_has_nat(_c_0, _offers_0));
  }
}

function $____________osn_api_laws_account_deletion_choices_found_org(_h_0) {
  if (_h_0.$ === "None") {
    return false;
  } else {
    return true;
  }
}

function $____________osn_api_laws_account_deletion_choices_found_app(_o_0) {
  if (_o_0.$ === "None") {
    return false;
  } else {
    return true;
  }
}

function $____________osn_api_laws_account_deletion_choices_bad(_p_0, _os_0, _as_0) {
  if (_p_0.$ === "OrgPick") {
    const _id_0 = _p_0["id"];
    const _c_0 = _p_0["choice"];
    const _m_0 = _p_0["member"];
    return $____________osn_api_laws_account_deletion_choices_org_bad($$____________osn_api_laws_account_deletion_choices_find_org(_id_0, _os_0), _c_0, _m_0);
  } else if (_p_0.$ === "AppPick") {
    const _id_1 = _p_0["id"];
    const _c_1 = _p_0["choice"];
    return $____________osn_api_laws_account_deletion_choices_app_bad($$____________osn_api_laws_account_deletion_choices_find_app(_id_1, _as_0), _c_1);
  } else {
    return false;
  }
}

function $____________osn_api_laws_account_deletion_choices_stale(_p_0, _as_0) {
  if (_p_0.$ === "OrgPick") {
    return false;
  } else if (_p_0.$ === "AppPick") {
    const _id_1 = _p_0["id"];
    return $Bool_not($$____________osn_api_laws_account_deletion_choices_found_app($$____________osn_api_laws_account_deletion_choices_find_app(_id_1, _as_0)));
  } else {
    return false;
  }
}

function $____________osn_api_laws_account_deletion_choices_names_org($0, $1) {
  for (;;) {
    {
      const _id_0 = $0;
      const _ps_0 = $1;
      if (_ps_0.$ === "Nil") {
        return false;
      } else {
        const _t_0 = _ps_0["head"];
        if (_t_0.$ === "OrgPick") {
          const _i_0 = _t_0["id"];
          const _rest_0 = _ps_0["tail"];
          const _x_0 = $$Nat_is_eq(_i_0, _id_0);
          const _x_1 = $$____________osn_api_laws_account_deletion_choices_names_org(_id_0, _rest_0);
          return (_x_0 || _x_1);
        } else if (_t_0.$ === "AppPick") {
          const _rest_1 = _ps_0["tail"];
          $0 = _id_0;
          $1 = _rest_1;
          continue;
        } else {
          const _rest_2 = _ps_0["tail"];
          $0 = _id_0;
          $1 = _rest_2;
          continue;
        }
      }
    }
  }
}

function $____________osn_api_laws_account_deletion_choices_names_app($0, $1) {
  for (;;) {
    {
      const _id_0 = $0;
      const _ps_0 = $1;
      if (_ps_0.$ === "Nil") {
        return false;
      } else {
        const _t_0 = _ps_0["head"];
        if (_t_0.$ === "OrgPick") {
          const _rest_0 = _ps_0["tail"];
          $0 = _id_0;
          $1 = _rest_0;
          continue;
        } else if (_t_0.$ === "AppPick") {
          const _i_1 = _t_0["id"];
          const _rest_1 = _ps_0["tail"];
          const _x_0 = $$Nat_is_eq(_i_1, _id_0);
          const _x_1 = $$____________osn_api_laws_account_deletion_choices_names_app(_id_0, _rest_1);
          return (_x_0 || _x_1);
        } else {
          const _rest_2 = _ps_0["tail"];
          $0 = _id_0;
          $1 = _rest_2;
          continue;
        }
      }
    }
  }
}

function $____________osn_api_laws_account_deletion_choices_again(_p_0, _os_0, _as_0, _rest_0) {
  if (_p_0.$ === "OrgPick") {
    const _id_0 = _p_0["id"];
    return $Bool_and($$____________osn_api_laws_account_deletion_choices_found_org($$____________osn_api_laws_account_deletion_choices_find_org(_id_0, _os_0)), $$____________osn_api_laws_account_deletion_choices_names_org(_id_0, _rest_0));
  } else if (_p_0.$ === "AppPick") {
    const _id_1 = _p_0["id"];
    return $Bool_and($$____________osn_api_laws_account_deletion_choices_found_app($$____________osn_api_laws_account_deletion_choices_find_app(_id_1, _as_0)), $$____________osn_api_laws_account_deletion_choices_names_app(_id_1, _rest_0));
  } else {
    return false;
  }
}

function $____________osn_api_laws_account_deletion_choices_any_invalid(_os_0, _as_0, _ps_0) {
  if (_ps_0.$ === "Nil") {
    return false;
  } else {
    const _p_0 = _ps_0["head"];
    const _rest_0 = _ps_0["tail"];
    const _x_0 = $$____________osn_api_laws_account_deletion_choices_bad(_p_0, _os_0, _as_0);
    const _x_1 = $$____________osn_api_laws_account_deletion_choices_again(_p_0, _os_0, _as_0, _rest_0);
    const _x_2 = (_x_0 || _x_1);
    const _x_3 = $$____________osn_api_laws_account_deletion_choices_any_invalid(_os_0, _as_0, _rest_0);
    return (_x_2 || _x_3);
  }
}

function $____________osn_api_laws_account_deletion_choices_any_stale(_as_0, _ps_0) {
  if (_ps_0.$ === "Nil") {
    return false;
  } else {
    const _p_0 = _ps_0["head"];
    const _rest_0 = _ps_0["tail"];
    const _x_0 = $$____________osn_api_laws_account_deletion_choices_stale(_p_0, _as_0);
    const _x_1 = $$____________osn_api_laws_account_deletion_choices_any_stale(_as_0, _rest_0);
    return (_x_0 || _x_1);
  }
}

function $____________osn_api_laws_account_deletion_choices_open_orgs(_os_0, _ps_0) {
  if (_os_0.$ === "Nil") {
    return false;
  } else {
    const _t_0 = _os_0["head"];
    const _id_0 = _t_0["id"];
    const _h_0 = _t_0["heir"];
    const _rest_0 = _os_0["tail"];
    const _x_0 = $$Bool_and($$Bool_not($$____________osn_api_laws_account_deletion_choices_org_has_default(_h_0)), $$Bool_not($$____________osn_api_laws_account_deletion_choices_names_org(_id_0, _ps_0)));
    const _x_1 = $$____________osn_api_laws_account_deletion_choices_open_orgs(_rest_0, _ps_0);
    return (_x_0 || _x_1);
  }
}

function $____________osn_api_laws_account_deletion_choices_needs_answer(_offers_0, _d_0) {
  if (_offers_0.$ === "Nil") {
    return false;
  } else {
    if (_d_0.$ === "None") {
      return true;
    } else {
      return false;
    }
  }
}

function $____________osn_api_laws_account_deletion_choices_open_apps(_as_0, _ps_0) {
  if (_as_0.$ === "Nil") {
    return false;
  } else {
    const _t_0 = _as_0["head"];
    const _id_0 = _t_0["id"];
    const _offers_0 = _t_0["offers"];
    const _d_0 = _t_0["fallback"];
    const _rest_0 = _as_0["tail"];
    const _x_0 = $$Bool_and($$____________osn_api_laws_account_deletion_choices_needs_answer(_offers_0, _d_0), $$Bool_not($$____________osn_api_laws_account_deletion_choices_names_app(_id_0, _ps_0)));
    const _x_1 = $$____________osn_api_laws_account_deletion_choices_open_apps(_rest_0, _ps_0);
    return (_x_0 || _x_1);
  }
}

function $____________osn_api_laws_account_deletion_choices_is_open(_os_0, _as_0, _ps_0) {
  const _x_0 = $$____________osn_api_laws_account_deletion_choices_open_orgs(_os_0, _ps_0);
  const _x_1 = $$____________osn_api_laws_account_deletion_choices_open_apps(_as_0, _ps_0);
  return (_x_0 || _x_1);
}

function $____________osn_api_laws_account_deletion_choices_check(_os_0, _as_0, _ps_0) {
  const _invalid_0 = $$____________osn_api_laws_account_deletion_choices_any_invalid(_os_0, _as_0, _ps_0);
  const _stale_found_0 = $$____________osn_api_laws_account_deletion_choices_any_stale(_as_0, _ps_0);
  return $Bool_pick(_invalid_0, {$: "Invalid"}, $$Bool_pick(_stale_found_0, {$: "Stale"}, $$Bool_pick($$____________osn_api_laws_account_deletion_choices_is_open(_os_0, _as_0, _ps_0), {$: "Open"}, {$: "Ok"})));
}

function $____________osn_api_laws_account_deletion_choices_is_empty(_ps_0) {
  if (_ps_0.$ === "Nil") {
    return true;
  } else {
    return false;
  }
}

function $____________osn_api_laws_account_deletion_choices_everything_of(_r_0) {
  const _everything_0 = _r_0["everything"];
  return _everything_0;
}

function $____________osn_api_laws_account_deletion_choices_verdict(_r_0) {
  const _os_0 = _r_0["orgs"];
  const _as_0 = _r_0["apps"];
  const _ps_0 = _r_0["picks"];
  const _everything_0 = _r_0["everything"];
  const _unchecked_0 = _r_0["unchecked"];
  return $Bool_pick($$Bool_and(_everything_0, $$Bool_not($$____________osn_api_laws_account_deletion_choices_is_empty(_ps_0))), {$: "Both"}, $$Bool_pick(_unchecked_0, {$: "Unchecked"}, $$Bool_pick(_everything_0, {$: "Ok"}, $$____________osn_api_laws_account_deletion_choices_check(_os_0, _as_0, _ps_0))));
}

function $weddings_is_owner(_r_0) {
  if (_r_0.$ === "Owner") {
    return true;
  } else if (_r_0.$ === "Editor") {
    return false;
  } else if (_r_0.$ === "Viewer") {
    return false;
  } else {
    return false;
  }
}

function $weddings_has_owner(_ss_0) {
  if (_ss_0.$ === "Nil") {
    return false;
  } else {
    const _t_0 = _ss_0["head"];
    const _r_0 = _t_0["role"];
    const _rest_0 = _ss_0["tail"];
    const _x_0 = $$weddings_is_owner(_r_0);
    const _x_1 = $$weddings_has_owner(_rest_0);
    return (_x_0 || _x_1);
  }
}

function $weddings_seated(_q_0, _ss_0) {
  if (_ss_0.$ === "Nil") {
    return false;
  } else {
    const _t_0 = _ss_0["head"];
    const _p_0 = _t_0["profile"];
    const _rest_0 = _ss_0["tail"];
    const _x_0 = $$Nat_is_eq(_p_0, _q_0);
    const _x_1 = $$weddings_seated(_q_0, _rest_0);
    return (_x_0 || _x_1);
  }
}

function $weddings_owns(_q_0, _ss_0) {
  if (_ss_0.$ === "Nil") {
    return false;
  } else {
    const _t_0 = _ss_0["head"];
    const _p_0 = _t_0["profile"];
    const _r_0 = _t_0["role"];
    const _rest_0 = _ss_0["tail"];
    const _x_0 = $$Bool_and($$Nat_is_eq(_p_0, _q_0), $$weddings_is_owner(_r_0));
    const _x_1 = $$weddings_owns(_q_0, _rest_0);
    return (_x_0 || _x_1);
  }
}

function $weddings_acct_owns(_acct_0, _ss_0) {
  if (_ss_0.$ === "Nil") {
    return false;
  } else {
    const _t_0 = _ss_0["head"];
    const _a_0 = _t_0["account"];
    const _r_0 = _t_0["role"];
    const _rest_0 = _ss_0["tail"];
    const _x_0 = $$Bool_and($$Nat_is_eq(_a_0, _acct_0), $$weddings_is_owner(_r_0));
    const _x_1 = $$weddings_acct_owns(_acct_0, _rest_0);
    return (_x_0 || _x_1);
  }
}

function $weddings_keep_seat(_q_0, _s_0, _rest_0) {
  const _p_0 = _s_0["profile"];
  const _a_0 = _s_0["account"];
  const _r_0 = _s_0["role"];
  return $Bool_pick($$Nat_is_eq(_p_0, _q_0), _rest_0, {$: "Con", "head": {$: "Seat", "profile": _p_0, "account": _a_0, "role": _r_0}, "tail": _rest_0});
}

function $weddings_without(_q_0, _ss_0) {
  if (_ss_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _s_0 = _ss_0["head"];
    const _rest_0 = _ss_0["tail"];
    return $weddings_keep_seat(_q_0, _s_0, $$weddings_without(_q_0, _rest_0));
  }
}

function $weddings_set_seat(_q_0, _r2_0, _s_0) {
  const _p_0 = _s_0["profile"];
  const _a_0 = _s_0["account"];
  const _r_0 = _s_0["role"];
  return $Bool_pick($$Nat_is_eq(_p_0, _q_0), {$: "Seat", "profile": _p_0, "account": _a_0, "role": _r2_0}, {$: "Seat", "profile": _p_0, "account": _a_0, "role": _r_0});
}

function $weddings_set_role(_q_0, _r2_0, _ss_0) {
  if (_ss_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _s_0 = _ss_0["head"];
    const _rest_0 = _ss_0["tail"];
    return {$: "Con", "head": $$weddings_set_seat(_q_0, _r2_0, _s_0), "tail": $$weddings_set_role(_q_0, _r2_0, _rest_0)};
  }
}

function $weddings_keep_other(_acct_0, _s_0, _rest_0) {
  const _p_0 = _s_0["profile"];
  const _a_0 = _s_0["account"];
  const _r_0 = _s_0["role"];
  return $Bool_pick($$Nat_is_eq(_a_0, _acct_0), _rest_0, {$: "Con", "head": {$: "Seat", "profile": _p_0, "account": _a_0, "role": _r_0}, "tail": _rest_0});
}

function $weddings_erase_seats(_acct_0, _ss_0) {
  if (_ss_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _s_0 = _ss_0["head"];
    const _rest_0 = _ss_0["tail"];
    return $weddings_keep_other(_acct_0, _s_0, $$weddings_erase_seats(_acct_0, _rest_0));
  }
}

function $weddings_guarded(_ss_0, _changed_0) {
  return $Bool_pick($$weddings_has_owner(_changed_0), _changed_0, _ss_0);
}

function $weddings_step_live(_e_0, _ss_0) {
  if (_e_0.$ === "Add") {
    const _q_0 = _e_0["profile"];
    const _a_0 = _e_0["account"];
    const _r_0 = _e_0["role"];
    return {$: "W", "live": true, "seats": $$Bool_pick($$weddings_seated(_q_0, _ss_0), _ss_0, {$: "Con", "head": {$: "Seat", "profile": _q_0, "account": _a_0, "role": _r_0}, "tail": _ss_0})};
  } else if (_e_0.$ === "Remove") {
    const _q_1 = _e_0["profile"];
    return {$: "W", "live": true, "seats": $$weddings_guarded(_ss_0, $$weddings_without(_q_1, _ss_0))};
  } else if (_e_0.$ === "SetRole") {
    const _q_2 = _e_0["profile"];
    const _r_1 = _e_0["role"];
    return {$: "W", "live": true, "seats": $$weddings_guarded(_ss_0, $$weddings_set_role(_q_2, _r_1, _ss_0))};
  } else if (_e_0.$ === "EraseAcct") {
    const _a_1 = _e_0["account"];
    const _rest_0 = $$weddings_erase_seats(_a_1, _ss_0);
    return {$: "W", "live": $$weddings_has_owner(_rest_0), "seats": _rest_0};
  } else if (_e_0.$ === "Discard") {
    return {$: "W", "live": false, "seats": _ss_0};
  } else {
    return {$: "W", "live": true, "seats": _ss_0};
  }
}

function $weddings_step_dead(_e_0, _ss_0) {
  if (_e_0.$ === "Add") {
    return {$: "W", "live": false, "seats": _ss_0};
  } else if (_e_0.$ === "Remove") {
    return {$: "W", "live": false, "seats": _ss_0};
  } else if (_e_0.$ === "SetRole") {
    return {$: "W", "live": false, "seats": _ss_0};
  } else if (_e_0.$ === "EraseAcct") {
    const _a_1 = _e_0["account"];
    return {$: "W", "live": false, "seats": $$weddings_erase_seats(_a_1, _ss_0)};
  } else if (_e_0.$ === "Discard") {
    return {$: "W", "live": false, "seats": _ss_0};
  } else {
    const _q_3 = _e_0["profile"];
    return {$: "W", "live": $$weddings_owns(_q_3, _ss_0), "seats": _ss_0};
  }
}

function $weddings_step(_w_0, _e_0) {
  const _t_0 = _w_0["live"];
  if (_t_0) {
    const _ss_0 = _w_0["seats"];
    return $weddings_step_live(_e_0, _ss_0);
  } else {
    const _ss_1 = _w_0["seats"];
    return $weddings_step_dead(_e_0, _ss_1);
  }
}

function $weddings_created(_q_0, _a_0) {
  return {$: "W", "live": true, "seats": {$: "Con", "head": {$: "Seat", "profile": _q_0, "account": _a_0, "role": {$: "Owner"}}, "tail": {$: "Nil"}}};
}

function $weddings_run($0, $1) {
  for (;;) {
    {
      const _es_0 = $0;
      const _w_0 = $1;
      if (_es_0.$ === "Nil") {
        return _w_0;
      } else {
        const _e_0 = _es_0["head"];
        const _rest_0 = _es_0["tail"];
        $0 = _rest_0;
        $1 = $$weddings_step(_w_0, _e_0);
        continue;
      }
    }
  }
}

function $weddings_sole(_acct_0, _w_0) {
  const _live_0 = _w_0["live"];
  const _ss_0 = _w_0["seats"];
  return $Bool_and($$Bool_and(_live_0, $$weddings_acct_owns(_acct_0, _ss_0)), $$Bool_not($$weddings_has_owner($$weddings_erase_seats(_acct_0, _ss_0))));
}

function $weddings_wedding_action(_wid_0) {
  return {$: "AppAct", "id": _wid_0, "offers": {$: "Con", "head": $$____________osn_api_laws_account_deletion_choices_delete_choice(), "tail": {$: "Nil"}}, "fallback": {$: "None"}};
}

function $weddings_preview(_acct_0, _wid_0, _w_0) {
  return $Bool_pick($$weddings_sole(_acct_0, _w_0), {$: "Con", "head": $$weddings_wedding_action(_wid_0), "tail": {$: "Nil"}}, {$: "Nil"});
}

function $Nat_is_eq(_a_0, _b_0) {
  return $Cmp_is_eq(cmp_new(_a_0, _b_0));
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

function $Bool_and(_a_0, _b_0) {
  if (!_a_0) {
    return false;
  } else {
    return _b_0;
  }
}

function $Cmp_is_eq(_c_0) {
  if (_c_0.$ === "EQ") {
    return true;
  } else {
    return false;
  }
}

const $$Nat_is_eq = $Nat_is_eq;
const $$____________osn_api_laws_account_deletion_choices_has_nat = $____________osn_api_laws_account_deletion_choices_has_nat;
const $$____________osn_api_laws_account_deletion_choices_find_org = $____________osn_api_laws_account_deletion_choices_find_org;
const $$____________osn_api_laws_account_deletion_choices_find_app = $____________osn_api_laws_account_deletion_choices_find_app;
const $$____________osn_api_laws_account_deletion_choices_org_offers = $____________osn_api_laws_account_deletion_choices_org_offers;
const $$Bool_not = $Bool_not;
const $$____________osn_api_laws_account_deletion_choices_is_successor = $____________osn_api_laws_account_deletion_choices_is_successor;
const $$Bool_and = $Bool_and;
const $$____________osn_api_laws_account_deletion_choices_found_app = $____________osn_api_laws_account_deletion_choices_found_app;
const $$____________osn_api_laws_account_deletion_choices_names_org = $____________osn_api_laws_account_deletion_choices_names_org;
const $$____________osn_api_laws_account_deletion_choices_names_app = $____________osn_api_laws_account_deletion_choices_names_app;
const $$____________osn_api_laws_account_deletion_choices_found_org = $____________osn_api_laws_account_deletion_choices_found_org;
const $$____________osn_api_laws_account_deletion_choices_bad = $____________osn_api_laws_account_deletion_choices_bad;
const $$____________osn_api_laws_account_deletion_choices_again = $____________osn_api_laws_account_deletion_choices_again;
const $$____________osn_api_laws_account_deletion_choices_any_invalid = $____________osn_api_laws_account_deletion_choices_any_invalid;
const $$____________osn_api_laws_account_deletion_choices_stale = $____________osn_api_laws_account_deletion_choices_stale;
const $$____________osn_api_laws_account_deletion_choices_any_stale = $____________osn_api_laws_account_deletion_choices_any_stale;
const $$____________osn_api_laws_account_deletion_choices_org_has_default = $____________osn_api_laws_account_deletion_choices_org_has_default;
const $$____________osn_api_laws_account_deletion_choices_open_orgs = $____________osn_api_laws_account_deletion_choices_open_orgs;
const $$____________osn_api_laws_account_deletion_choices_needs_answer = $____________osn_api_laws_account_deletion_choices_needs_answer;
const $$____________osn_api_laws_account_deletion_choices_open_apps = $____________osn_api_laws_account_deletion_choices_open_apps;
const $$____________osn_api_laws_account_deletion_choices_is_open = $____________osn_api_laws_account_deletion_choices_is_open;
const $$Bool_pick = $Bool_pick;
const $$____________osn_api_laws_account_deletion_choices_is_empty = $____________osn_api_laws_account_deletion_choices_is_empty;
const $$____________osn_api_laws_account_deletion_choices_check = $____________osn_api_laws_account_deletion_choices_check;
const $$weddings_is_owner = $weddings_is_owner;
const $$weddings_has_owner = $weddings_has_owner;
const $$weddings_seated = $weddings_seated;
const $$weddings_owns = $weddings_owns;
const $$weddings_acct_owns = $weddings_acct_owns;
const $$weddings_without = $weddings_without;
const $$weddings_set_seat = $weddings_set_seat;
const $$weddings_set_role = $weddings_set_role;
const $$weddings_erase_seats = $weddings_erase_seats;
const $$weddings_guarded = $weddings_guarded;
const $$weddings_step = $weddings_step;
const $$____________osn_api_laws_account_deletion_choices_delete_choice = $____________osn_api_laws_account_deletion_choices_delete_choice;
const $$weddings_sole = $weddings_sole;
const $$weddings_wedding_action = $weddings_wedding_action;export default {
  "../../../../osn/api/laws/account-deletion/choices:delete_choice": run_lib(() => run_loop($____________osn_api_laws_account_deletion_choices_delete_choice()), 0),
  "../../../../osn/api/laws/account-deletion/choices:is_ok": run_lib((a0) => run_loop($____________osn_api_laws_account_deletion_choices_is_ok(a0)), 1),
  "../../../../osn/api/laws/account-deletion/choices:has_nat": run_lib((a0,a1) => run_loop($____________osn_api_laws_account_deletion_choices_has_nat(nat_in(a0),a1)), 2),
  "../../../../osn/api/laws/account-deletion/choices:is_delete": run_lib((a0) => run_loop($____________osn_api_laws_account_deletion_choices_is_delete(a0)), 1),
  "../../../../osn/api/laws/account-deletion/choices:is_successor": run_lib((a0) => run_loop($____________osn_api_laws_account_deletion_choices_is_successor(a0)), 1),
  "../../../../osn/api/laws/account-deletion/choices:org_offers": run_lib((a0,a1) => run_loop($____________osn_api_laws_account_deletion_choices_org_offers(a0,a1)), 2),
  "../../../../osn/api/laws/account-deletion/choices:org_has_default": run_lib((a0) => run_loop($____________osn_api_laws_account_deletion_choices_org_has_default(a0)), 1),
  "../../../../osn/api/laws/account-deletion/choices:find_org": run_lib((a0,a1) => run_loop($____________osn_api_laws_account_deletion_choices_find_org(nat_in(a0),a1)), 2),
  "../../../../osn/api/laws/account-deletion/choices:find_app": run_lib((a0,a1) => run_loop($____________osn_api_laws_account_deletion_choices_find_app(nat_in(a0),a1)), 2),
  "../../../../osn/api/laws/account-deletion/choices:org_bad": run_lib((a0,a1,a2) => run_loop($____________osn_api_laws_account_deletion_choices_org_bad(a0,a1,a2)), 3),
  "../../../../osn/api/laws/account-deletion/choices:app_bad": run_lib((a0,a1) => run_loop($____________osn_api_laws_account_deletion_choices_app_bad(a0,nat_in(a1))), 2),
  "../../../../osn/api/laws/account-deletion/choices:found_org": run_lib((a0) => run_loop($____________osn_api_laws_account_deletion_choices_found_org(a0)), 1),
  "../../../../osn/api/laws/account-deletion/choices:found_app": run_lib((a0) => run_loop($____________osn_api_laws_account_deletion_choices_found_app(a0)), 1),
  "../../../../osn/api/laws/account-deletion/choices:bad": run_lib((a0,a1,a2) => run_loop($____________osn_api_laws_account_deletion_choices_bad(a0,a1,a2)), 3),
  "../../../../osn/api/laws/account-deletion/choices:stale": run_lib((a0,a1) => run_loop($____________osn_api_laws_account_deletion_choices_stale(a0,a1)), 2),
  "../../../../osn/api/laws/account-deletion/choices:names_org": run_lib((a0,a1) => run_loop($____________osn_api_laws_account_deletion_choices_names_org(nat_in(a0),a1)), 2),
  "../../../../osn/api/laws/account-deletion/choices:names_app": run_lib((a0,a1) => run_loop($____________osn_api_laws_account_deletion_choices_names_app(nat_in(a0),a1)), 2),
  "../../../../osn/api/laws/account-deletion/choices:again": run_lib((a0,a1,a2,a3) => run_loop($____________osn_api_laws_account_deletion_choices_again(a0,a1,a2,a3)), 4),
  "../../../../osn/api/laws/account-deletion/choices:any_invalid": run_lib((a0,a1,a2) => run_loop($____________osn_api_laws_account_deletion_choices_any_invalid(a0,a1,a2)), 3),
  "../../../../osn/api/laws/account-deletion/choices:any_stale": run_lib((a0,a1) => run_loop($____________osn_api_laws_account_deletion_choices_any_stale(a0,a1)), 2),
  "../../../../osn/api/laws/account-deletion/choices:open_orgs": run_lib((a0,a1) => run_loop($____________osn_api_laws_account_deletion_choices_open_orgs(a0,a1)), 2),
  "../../../../osn/api/laws/account-deletion/choices:needs_answer": run_lib((a0,a1) => run_loop($____________osn_api_laws_account_deletion_choices_needs_answer(a0,a1)), 2),
  "../../../../osn/api/laws/account-deletion/choices:open_apps": run_lib((a0,a1) => run_loop($____________osn_api_laws_account_deletion_choices_open_apps(a0,a1)), 2),
  "../../../../osn/api/laws/account-deletion/choices:is_open": run_lib((a0,a1,a2) => run_loop($____________osn_api_laws_account_deletion_choices_is_open(a0,a1,a2)), 3),
  "../../../../osn/api/laws/account-deletion/choices:check": run_lib((a0,a1,a2) => run_loop($____________osn_api_laws_account_deletion_choices_check(a0,a1,a2)), 3),
  "../../../../osn/api/laws/account-deletion/choices:is_empty": run_lib((a0) => run_loop($____________osn_api_laws_account_deletion_choices_is_empty(a0)), 1),
  "../../../../osn/api/laws/account-deletion/choices:everything_of": run_lib((a0) => run_loop($____________osn_api_laws_account_deletion_choices_everything_of(a0)), 1),
  "../../../../osn/api/laws/account-deletion/choices:verdict": run_lib((a0) => run_loop($____________osn_api_laws_account_deletion_choices_verdict(a0)), 1),
  "weddings:is_owner": run_lib((a0) => run_loop($weddings_is_owner(a0)), 1),
  "weddings:has_owner": run_lib((a0) => run_loop($weddings_has_owner(a0)), 1),
  "weddings:seated": run_lib((a0,a1) => run_loop($weddings_seated(nat_in(a0),a1)), 2),
  "weddings:owns": run_lib((a0,a1) => run_loop($weddings_owns(nat_in(a0),a1)), 2),
  "weddings:acct_owns": run_lib((a0,a1) => run_loop($weddings_acct_owns(nat_in(a0),a1)), 2),
  "weddings:keep_seat": run_lib((a0,a1,a2) => run_loop($weddings_keep_seat(nat_in(a0),a1,a2)), 3),
  "weddings:without": run_lib((a0,a1) => run_loop($weddings_without(nat_in(a0),a1)), 2),
  "weddings:set_seat": run_lib((a0,a1,a2) => run_loop($weddings_set_seat(nat_in(a0),a1,a2)), 3),
  "weddings:set_role": run_lib((a0,a1,a2) => run_loop($weddings_set_role(nat_in(a0),a1,a2)), 3),
  "weddings:keep_other": run_lib((a0,a1,a2) => run_loop($weddings_keep_other(nat_in(a0),a1,a2)), 3),
  "weddings:erase_seats": run_lib((a0,a1) => run_loop($weddings_erase_seats(nat_in(a0),a1)), 2),
  "weddings:guarded": run_lib((a0,a1) => run_loop($weddings_guarded(a0,a1)), 2),
  "weddings:step_live": run_lib((a0,a1) => run_loop($weddings_step_live(a0,a1)), 2),
  "weddings:step_dead": run_lib((a0,a1) => run_loop($weddings_step_dead(a0,a1)), 2),
  "weddings:step": run_lib((a0,a1) => run_loop($weddings_step(a0,a1)), 2),
  "weddings:created": run_lib((a0,a1) => run_loop($weddings_created(nat_in(a0),nat_in(a1))), 2),
  "weddings:run": run_lib((a0,a1) => run_loop($weddings_run(a0,a1)), 2),
  "weddings:sole": run_lib((a0,a1) => run_loop($weddings_sole(nat_in(a0),a1)), 2),
  "weddings:wedding_action": run_lib((a0) => run_loop($weddings_wedding_action(nat_in(a0))), 1),
  "weddings:preview": run_lib((a0,a1,a2) => run_loop($weddings_preview(nat_in(a0),nat_in(a1),a2)), 3),
};

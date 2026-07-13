/* ═══════════════════════════════════════════════════════════════════
   Calc Pro — Wolfram-style math pad: the expression engine.
   Pure client-side, zero dependencies. UMD-lite: window.CalcPro in a
   browser, module.exports under node. This mirrors the engine half of
   calcpro.js on subnsub.com — keep both sides in lockstep when maths
   behaviour changes.

   Numeric tower:  Rational(BigInt n/d)  →  Float  →  Complex
                   Quantity wraps R|F with a 9-dim vector + unit map.
   Dimensions: [length, mass, time, current, temp, amount, luminous,
                angle, data]
   v1 scope: exact arithmetic, units & conversion (to/in/as), number
   bases & bitwise ops, date arithmetic, percent conventions, factorial,
   nCr/nPr, closed-form detection (π/√/e/φ families).
   v2 (not yet built): CAS — solve/derive/integrate via a vendored CAS.
   ═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CalcPro = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── guards ─────────────────────────────────────────────────────── */
  var BITLIM = 1 << 17;          // rational num+den bit budget (~39k digits)
  var MAXTOK = 512, MAXDEPTH = 120;
  var FACT_EXACT_MAX = 10000n, POW_EXP_MAX = 100000n, SHIFT_MAX = 65536n;

  function CalcErr(kind, msg) { this.kind = kind; this.msg = msg; }

  function bitLen(n) { if (n < 0n) n = -n; return n === 0n ? 1 : n.toString(16).length * 4; }

  /* ── numeric tower ──────────────────────────────────────────────── */
  function gcdBig(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { var t = a % b; a = b; b = t; } return a; }

  function mkR(n, d) {
    if (d === 0n) throw new CalcErr('math', 'division by zero');
    if (d < 0n) { n = -n; d = -d; }
    var g = gcdBig(n, d); if (g > 1n) { n /= g; d /= g; }
    if (bitLen(n) + bitLen(d) > BITLIM) return mkF(ratToNumber(n, d));
    return { k: 'r', n: n, d: d };
  }
  function mkF(v) { return { k: 'f', v: v }; }
  function mkC(re, im) { return im === 0 ? mkF(re) : { k: 'c', re: re, im: im }; }
  var DIMZ = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  function dimIsZero(d) { for (var i = 0; i < 9; i++) if (d[i] !== 0) return false; return true; }
  function dimEq(a, b) { for (var i = 0; i < 9; i++) if (a[i] !== b[i]) return false; return true; }
  function mkQ(v, dim, ue) {
    if (v.k === 'c') throw new CalcErr('math', 'complex quantities are not supported');
    if (dimIsZero(dim)) return v;
    return { k: 'q', v: v, dim: dim, ue: ue || {} };
  }

  function ratToNumber(n, d) {
    var neg = (n < 0n); if (neg) n = -n;
    /* normalise numerator and denominator SEPARATELY — one shared shift
       zeroes whichever side is small (1n >> 5n === 0n) and turned finite
       values like sqrt(2^64+1) into ∞. Compensate with the exponent gap. */
    var sn = Math.max(0, bitLen(n) - 60), sd = Math.max(0, bitLen(d) - 60);
    var r = (Number(n >> BigInt(sn)) / Number(d >> BigInt(sd))) * Math.pow(2, sn - sd);
    return neg ? -r : r;
  }
  function toF(x) {
    if (x.k === 'r') return ratToNumber(x.n, x.d);
    if (x.k === 'f') return x.v;
    throw new CalcErr('math', 'expected a real number');
  }
  function isInt(x) { return x.k === 'r' && x.d === 1n; }
  function asIntBig(x, what) {
    if (x.k === 'f' && Number.isInteger(x.v) && Math.abs(x.v) <= 9007199254740991) return BigInt(x.v);
    if (!isInt(x)) throw new CalcErr('math', (what || 'this operation') + ' needs an integer');
    return x.n;
  }
  function isZero(x) {
    if (x.k === 'r') return x.n === 0n;
    if (x.k === 'f') return x.v === 0;
    if (x.k === 'c') return x.re === 0 && x.im === 0;
    return false;
  }

  /* dispatching arithmetic.  q handled by callers (evalNode) except mul/div. */
  function addN(a, b) {
    if (a.k === 'q' || b.k === 'q') {
      if (a.k !== 'q' || b.k !== 'q' || !dimEq(a.dim, b.dim)) throw dimErr(a, b, '+');
      return mkQ(addN(a.v, b.v), a.dim, a.ue);
    }
    if (a.k === 'c' || b.k === 'c') { var ca = toC(a), cb = toC(b); return mkC(ca.re + cb.re, ca.im + cb.im); }
    if (a.k === 'f' || b.k === 'f') return mkF(toF(a) + toF(b));
    return mkR(a.n * b.d + b.n * a.d, a.d * b.d);
  }
  function negN(a) {
    if (a.k === 'q') return mkQ(negN(a.v), a.dim, a.ue);
    if (a.k === 'c') return mkC(-a.re, -a.im);
    if (a.k === 'f') return mkF(-a.v);
    return { k: 'r', n: -a.n, d: a.d };
  }
  function subN(a, b) { return addN(a, negN(b)); }
  function mulN(a, b) {
    if (a.k === 'q' || b.k === 'q') {
      var qa = a.k === 'q' ? a : null, qb = b.k === 'q' ? b : null;
      var dim = [], i;
      for (i = 0; i < 9; i++) dim.push((qa ? qa.dim[i] : 0) + (qb ? qb.dim[i] : 0));
      var ue = mergeUE(qa ? qa.ue : null, qb ? qb.ue : null, 1);
      return mkQ(mulN(qa ? qa.v : a, qb ? qb.v : b), dim, ue);
    }
    if (a.k === 'c' || b.k === 'c') {
      var ca = toC(a), cb = toC(b);
      return mkC(ca.re * cb.re - ca.im * cb.im, ca.re * cb.im + ca.im * cb.re);
    }
    if (a.k === 'f' || b.k === 'f') return mkF(toF(a) * toF(b));
    return mkR(a.n * b.n, a.d * b.d);
  }
  function divN(a, b) {
    if (b.k === 'q' || a.k === 'q') {
      var qa = a.k === 'q' ? a : null, qb = b.k === 'q' ? b : null;
      var dim = [], i;
      for (i = 0; i < 9; i++) dim.push((qa ? qa.dim[i] : 0) - (qb ? qb.dim[i] : 0));
      var ue = mergeUE(qa ? qa.ue : null, qb ? qb.ue : null, -1);
      return mkQ(divN(qa ? qa.v : a, qb ? qb.v : b), dim, ue);
    }
    if (a.k === 'c' || b.k === 'c') {
      var ca = toC(a), cb = toC(b), m = cb.re * cb.re + cb.im * cb.im;
      if (m === 0) throw new CalcErr('math', 'division by zero');
      return mkC((ca.re * cb.re + ca.im * cb.im) / m, (ca.im * cb.re - ca.re * cb.im) / m);
    }
    if (a.k === 'f' || b.k === 'f') {
      var fb = toF(b);
      if (fb === 0) throw new CalcErr('math', 'division by zero');
      return mkF(toF(a) / fb);
    }
    if (b.n === 0n) throw new CalcErr('math', 'division by zero');
    return mkR(a.n * b.d, a.d * b.n);
  }
  function toC(x) {
    if (x.k === 'c') return x;
    return { re: toF(x), im: 0 };
  }
  function dimErr(a, b, op) {
    return new CalcErr('math', 'unit mismatch: cannot ' + (op === '+' ? 'add' : 'combine') + ' ' +
      humanDim(a) + ' and ' + humanDim(b));
  }
  function humanDim(x) {
    if (x.k !== 'q') return 'a plain number';
    var s = ueToString(x.ue); return s ? '“' + s + '”' : 'a derived quantity';
  }
  function mergeUE(a, b, sgn) {
    var out = {}, k;
    if (a) for (k in a) out[k] = a[k];
    if (b) for (k in b) out[k] = (out[k] || 0) + sgn * b[k];
    for (k in out) if (out[k] === 0) delete out[k];
    return out;
  }

  /* ── pow / roots / factorial ────────────────────────────────────── */
  function ipowBig(base, e) { // e >= 0
    var r = 1n;
    while (e > 0n) { if (e & 1n) r *= base; base *= base; e >>= 1n; }
    return r;
  }
  function powN(a, b) {
    if (a.k === 'q') {
      if (b.k === 'q') throw new CalcErr('math', 'exponent cannot carry units');
      var er = b.k === 'r' ? b : null;
      if (!er && b.k === 'f' && Number.isInteger(b.v)) er = mkR(BigInt(b.v), 1n);
      if (!er) throw new CalcErr('math', 'quantity exponent must be rational');
      var dim = [], ue = {}, i, k;
      for (i = 0; i < 9; i++) {
        var m = mkR(BigInt(a.dim[i]) * er.n, er.d);
        if (!isInt(m)) throw new CalcErr('math', 'fractional unit dimensions');
        dim.push(Number(m.n));
      }
      for (k in a.ue) {
        var me = mkR(BigInt(a.ue[k]) * er.n, er.d);
        if (isInt(me)) ue[k] = Number(me.n); else { ue = null; break; }
      }
      return mkQ(powN(a.v, b), dim, ue || {});
    }
    if (b.k === 'q') throw new CalcErr('math', 'exponent cannot carry units');
    if (a.k === 'c' || b.k === 'c') return cpow(toC(a), b);
    if (isZero(a)) {
      var bf = b.k === 'r' ? ratToNumber(b.n, b.d) : b.v;
      if (bf < 0) throw new CalcErr('math', 'division by zero (0 to a negative power)');
      return bf === 0 ? mkR(1n, 1n) : mkR(0n, 1n);
    }
    if (a.k === 'r' && b.k === 'r') {
      if (b.d === 1n) { // integer exponent
        var e = b.n, neg = e < 0n; if (neg) e = -e;
        if (e <= POW_EXP_MAX && (bitLen(a.n) + bitLen(a.d)) * Number(e) <= BITLIM * 1.1) {
          var nn = ipowBig(a.n, e), dd = ipowBig(a.d, e);
          return neg ? mkR(dd, nn) : mkR(nn, dd);
        }
        return powFloat(ratToNumber(a.n, a.d), ratToNumber(b.n, b.d));
      }
      if (b.d <= 64n) { // try exact q-th root, then p-th power
        var rt = ratRoot(a, Number(b.d));
        if (rt) return powN(rt, mkR(b.n, 1n));
      }
      /* negative base with an odd-denominator rational exponent → the
         real root (consistent with cbrt/root), not the principal value */
      if (a.n < 0n && b.d % 2n === 1n) {
        var mag = Math.pow(ratToNumber(-a.n, a.d), ratToNumber(b.n, b.d));
        return mkF(b.n % 2n === 0n ? mag : -mag);
      }
      return powFloat(ratToNumber(a.n, a.d), ratToNumber(b.n, b.d));
    }
    return powFloat(toF(a), toF(b));
  }
  function powFloat(x, y) {
    if (x < 0 && !Number.isInteger(y)) { // principal complex value
      return cpow({ re: x, im: 0 }, mkF(y));
    }
    return mkF(Math.pow(x, y));
  }
  function cpow(z, w) {
    if (w.k === 'r' && w.d === 1n && w.n >= -64n && w.n <= 64n) { // fast int pow
      var e = Number(w.n), inv = e < 0; if (inv) e = -e;
      var r = { re: 1, im: 0 }, b = { re: z.re, im: z.im };
      while (e > 0) {
        if (e & 1) r = { re: r.re * b.re - r.im * b.im, im: r.re * b.im + r.im * b.re };
        b = { re: b.re * b.re - b.im * b.im, im: 2 * b.re * b.im };
        e >>= 1;
      }
      if (inv) { var m = r.re * r.re + r.im * r.im; r = { re: r.re / m, im: -r.im / m }; }
      return mkC(r.re, r.im);
    }
    var wc = toC(w);
    var mod = Math.hypot(z.re, z.im);
    if (mod === 0) return mkF(0);
    var arg = Math.atan2(z.im, z.re);
    var lr = Math.log(mod);
    var reE = wc.re * lr - wc.im * arg, imE = wc.re * arg + wc.im * lr;
    var ex = Math.exp(reE);
    return mkC(ex * Math.cos(imE), ex * Math.sin(imE));
  }
  function inthRoot(a, n) { // BigInt floor n-th root, a>=0n
    if (a < 2n) return a;
    var bits = BigInt(bitLen(a));
    var x = 1n << (bits / BigInt(n) + 1n), y;
    var N = BigInt(n);
    for (; ;) {
      y = ((N - 1n) * x + a / ipowBig(x, N - 1n)) / N;
      if (y >= x) break;
      x = y;
    }
    return x;
  }
  function ratRoot(a, q) { // exact q-th root of rational a, or null
    var negR = a.n < 0n;
    if (negR && q % 2 === 0) return null;
    var n = negR ? -a.n : a.n;
    var rn = inthRoot(n, q), rd = inthRoot(a.d, q);
    if (ipowBig(rn, BigInt(q)) !== n || ipowBig(rd, BigInt(q)) !== a.d) return null;
    return mkR(negR ? -rn : rn, rd);
  }
  var LANCZOS = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  function gammaF(x) {
    if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gammaF(1 - x));
    x -= 1;
    var g = 0.99999999999980993, i;
    for (i = 0; i < 8; i++) g += LANCZOS[i] / (x + i + 1);
    var t = x + 7.5;
    return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * g;
  }
  function factN(x) {
    if (x.k === 'q') throw new CalcErr('math', 'factorial of a quantity');
    if (x.k === 'c') throw new CalcErr('math', 'factorial of a complex number');
    if (isInt(x) && x.n >= 0n) {
      if (x.n <= FACT_EXACT_MAX) {
        var r = 1n, i;
        for (i = 2n; i <= x.n; i++) r *= i;
        return mkR(r, 1n);
      }
      return mkF(gammaF(toF(x) + 1)); // Infinity beyond ~170! in float — fine
    }
    var f = toF(x);
    if (f < 0 && Number.isInteger(f)) throw new CalcErr('math', 'factorial pole at negative integers');
    return mkF(gammaF(f + 1));
  }

  /* ── units ──────────────────────────────────────────────────────── */
  /* dims:            L  M  T  I  Θ  N  J  A  D  */
  function D() { var d = DIMZ.slice(); for (var i = 0; i < arguments.length; i += 2) d[arguments[i]] = arguments[i + 1]; return d; }
  var L = 0, M = 1, T = 2, EI = 3, TH = 4, AM = 5, LU = 6, AN = 7, DA = 8;
  function r_(n, d) { return mkR(BigInt(n), BigInt(d || 1)); }

  var UNITS = {};
  function U(names, dim, f, opts) {
    var def = { dim: dim, f: f, off: (opts && opts.off) || null, pfx: !!(opts && opts.pfx) };
    names.split(' ').forEach(function (nm) { UNITS[nm] = def; });
  }
  /* length */
  U('m meter meters metre metres', D(L, 1), r_(1), { pfx: true });
  U('km', D(L, 1), r_(1000)); U('dm', D(L, 1), r_(1, 10)); U('cm', D(L, 1), r_(1, 100));
  U('mm', D(L, 1), r_(1, 1000)); U('um µm micron microns', D(L, 1), r_(1, 1000000));
  U('nm', D(L, 1), r_(1, 1e9)); U('pm', D(L, 1), r_(1, 1e12));
  U('mi mile miles', D(L, 1), r_(201168, 125));
  U('yd yard yards', D(L, 1), r_(1143, 1250));
  U('ft foot feet ′ \'', D(L, 1), r_(381, 1250));
  U('in inch inches ″ "', D(L, 1), r_(127, 5000));
  U('nmi', D(L, 1), r_(1852)); U('au AU', D(L, 1), r_(149597870700));
  U('ly lightyear lightyears', D(L, 1), r_(9460730472580800));
  /* mass */
  U('kg', D(M, 1), r_(1)); U('g gram grams', D(M, 1), r_(1, 1000), { pfx: true });
  U('mg', D(M, 1), r_(1, 1e6)); U('ug µg', D(M, 1), r_(1, 1e9));
  U('t tonne tonnes ton tons', D(M, 1), r_(1000));
  U('lb lbs pound pounds', D(M, 1), r_(45359237, 1e8));
  U('oz', D(M, 1), r_(45359237, 16e8));
  U('st stone', D(M, 1), r_(317514663, 5e7));
  /* time */
  U('s sec secs second seconds', D(T, 1), r_(1), { pfx: true });
  U('ms', D(T, 1), r_(1, 1000)); U('us µs', D(T, 1), r_(1, 1e6)); U('ns', D(T, 1), r_(1, 1e9));
  U('min mins minute minutes', D(T, 1), r_(60));
  U('h hr hrs hour hours', D(T, 1), r_(3600));
  U('day days', D(T, 1), r_(86400));
  U('wk week weeks', D(T, 1), r_(604800));
  U('mo month months', D(T, 1), r_(2629746));       // mean Gregorian month
  U('yr year years', D(T, 1), r_(31556952));        // mean Gregorian year
  /* electric / thermo / amount / luminous */
  U('A amp amps ampere amperes', D(EI, 1), r_(1), { pfx: true });
  U('K kelvin', D(TH, 1), r_(1), { pfx: true });
  U('degC celsius C ℃', D(TH, 1), r_(1), { off: r_(5463, 20) });
  U('degF fahrenheit F ℉', D(TH, 1), r_(5, 9), { off: r_(45967, 180) });
  U('mol', D(AM, 1), r_(1), { pfx: true });
  U('cd', D(LU, 1), r_(1));
  /* angle */
  U('rad radian radians', D(AN, 1), r_(1), { pfx: true });
  U('deg degree degrees °', D(AN, 1), mkF(Math.PI / 180));
  U('grad gon', D(AN, 1), mkF(Math.PI / 200));
  U('turn turns rev', D(AN, 1), mkF(2 * Math.PI));
  U('arcmin', D(AN, 1), mkF(Math.PI / 10800)); U('arcsec', D(AN, 1), mkF(Math.PI / 648000));
  /* data (base = bit) */
  U('bit bits', D(DA, 1), r_(1), { pfx: true });
  U('B byte bytes', D(DA, 1), r_(8), { pfx: true });
  U('KB', D(DA, 1), r_(8000)); U('MB', D(DA, 1), r_(8e6)); U('GB', D(DA, 1), r_(8e9));
  U('TB', D(DA, 1), r_(8e12)); U('PB', D(DA, 1), r_(8e15));
  U('KiB', D(DA, 1), r_(8192)); U('MiB', D(DA, 1), r_(8388608)); U('GiB', D(DA, 1), r_(8589934592));
  U('TiB', D(DA, 1), r_(8796093022208)); U('PiB', D(DA, 1), r_(9007199254740992));
  U('Kb', D(DA, 1), r_(1000)); U('Mb', D(DA, 1), r_(1e6)); U('Gb', D(DA, 1), r_(1e9)); U('Tb', D(DA, 1), r_(1e12));
  /* derived */
  U('Hz hertz', D(T, -1), r_(1), { pfx: true });
  U('kHz', D(T, -1), r_(1000)); U('MHz', D(T, -1), r_(1e6)); U('GHz', D(T, -1), r_(1e9));
  U('N newton newtons', D(L, 1, M, 1, T, -2), r_(1), { pfx: true });
  U('Pa pascal', D(L, -1, M, 1, T, -2), r_(1), { pfx: true });
  U('kPa', D(L, -1, M, 1, T, -2), r_(1000)); U('MPa', D(L, -1, M, 1, T, -2), r_(1e6));
  U('hPa', D(L, -1, M, 1, T, -2), r_(100));
  U('bar', D(L, -1, M, 1, T, -2), r_(100000)); U('mbar', D(L, -1, M, 1, T, -2), r_(100));
  U('atm', D(L, -1, M, 1, T, -2), r_(101325));
  U('psi', D(L, -1, M, 1, T, -2), mkF(6894.757293168361));
  U('mmHg', D(L, -1, M, 1, T, -2), mkF(133.322387415));
  U('torr', D(L, -1, M, 1, T, -2), r_(20265, 152));   // exactly atm/760
  U('J joule joules', D(L, 2, M, 1, T, -2), r_(1), { pfx: true });
  U('kJ', D(L, 2, M, 1, T, -2), r_(1000)); U('MJ', D(L, 2, M, 1, T, -2), r_(1e6)); U('GJ', D(L, 2, M, 1, T, -2), r_(1e9));
  U('cal', D(L, 2, M, 1, T, -2), r_(523, 125), { pfx: true }); U('kcal', D(L, 2, M, 1, T, -2), r_(4184));
  U('Wh', D(L, 2, M, 1, T, -2), r_(3600)); U('kWh', D(L, 2, M, 1, T, -2), r_(3600000)); U('MWh', D(L, 2, M, 1, T, -2), r_(36e8));
  U('eV', D(L, 2, M, 1, T, -2), mkF(1.602176634e-19), { pfx: true });
  U('BTU btu', D(L, 2, M, 1, T, -2), mkF(1055.05585262));
  U('W watt watts', D(L, 2, M, 1, T, -3), r_(1), { pfx: true });
  U('kW', D(L, 2, M, 1, T, -3), r_(1000)); U('MW', D(L, 2, M, 1, T, -3), r_(1e6)); U('GW', D(L, 2, M, 1, T, -3), r_(1e9));
  U('hp', D(L, 2, M, 1, T, -3), mkF(745.6998715822702));
  U('V volt volts', D(L, 2, M, 1, T, -3, EI, -1), r_(1), { pfx: true });
  U('ohm ohms Ω', D(L, 2, M, 1, T, -3, EI, -2), r_(1), { pfx: true });
  U('L liter liters litre litres l', D(L, 3), r_(1, 1000), { pfx: true });
  U('mL ml', D(L, 3), r_(1, 1e6)); U('dL dl', D(L, 3), r_(1, 1e4)); U('cL cl', D(L, 3), r_(1, 1e5));
  U('gal gallon gallons', D(L, 3), r_(473176473, 125e9));
  U('ha hectare hectares', D(L, 2), r_(10000));
  U('acre acres', D(L, 2), r_(316160658, 78125));
  U('mph', D(L, 1, T, -1), r_(1397, 3125));
  U('kph', D(L, 1, T, -1), r_(5, 18));
  U('knot knots kn', D(L, 1, T, -1), r_(463, 900));

  var PREFIX = { P: r_(1e15), T: r_(1e12), G: r_(1e9), M: r_(1e6), k: r_(1000), m: r_(1, 1000), 'µ': r_(1, 1e6), u: r_(1, 1e6), n: r_(1, 1e9), p: r_(1, 1e12), f: r_(1, 1e15) };
  var BINPFX = { Ki: r_(1024), Mi: r_(1048576), Gi: r_(1073741824), Ti: r_(1099511627776), Pi: r_(1125899906842624) };

  function lookupUnit(name) {
    if (UNITS[name]) return { f: UNITS[name].f, dim: UNITS[name].dim, off: UNITS[name].off, name: name };
    var bp = name.slice(0, 2), rest2 = name.slice(2);
    if (BINPFX[bp] && UNITS[rest2] && UNITS[rest2].pfx && !UNITS[rest2].off)
      return { f: mulN(BINPFX[bp], UNITS[rest2].f), dim: UNITS[rest2].dim, off: null, name: name };
    var p = name.charAt(0), rest = name.slice(1);
    if (PREFIX[p] && UNITS[rest] && UNITS[rest].pfx && !UNITS[rest].off)
      return { f: mulN(PREFIX[p], UNITS[rest].f), dim: UNITS[rest].dim, off: null, name: name };
    return null;
  }
  var UNAME = { degC: '°C', degF: '°F', C: '°C', F: '°F', celsius: '°C', fahrenheit: '°F', ohm: 'Ω', ohms: 'Ω', um: 'µm', us: 'µs', ug: 'µg' };
  function ueToString(ue) {
    var pos = [], neg = [], k, e;
    var keys = Object.keys(ue);
    for (var i = 0; i < keys.length; i++) {
      k = UNAME[keys[i]] || keys[i]; e = ue[keys[i]];
      if (e > 0) pos.push(e === 1 ? k : k + '^' + e);
      else neg.push(e === -1 ? k : k + '^' + (-e));
    }
    if (!pos.length && !neg.length) return '';
    var s = pos.join('·');
    if (neg.length) s = (s || '1') + '/' + (neg.length > 1 ? '(' + neg.join('·') + ')' : neg[0]);
    return s;
  }
  function ueFactor(ue) { // combined SI factor of a display-unit map
    var f = mkR(1n, 1n), k;
    for (k in ue) {
      var u = lookupUnit(k);
      if (!u) return null;
      f = mulN(f, powN(u.f, mkR(BigInt(ue[k]), 1n)));
    }
    return f;
  }

  /* ── tokenizer ──────────────────────────────────────────────────── */
  var WORDOPS = { to: 1, as: 1, of: 1, and: 1, or: 1, xor: 1, mod: 1 };
  function isDigit(c) { return c >= '0' && c <= '9'; }
  function isIdent0(c) { return /[A-Za-z_µ°ΩπτφΔ'"′″]/.test(c); }
  function isIdentC(c) { return /[A-Za-z0-9_]/.test(c); }

  function tokenize(src) {
    var toks = [], i = 0, n = src.length, c;
    while (i < n) {
      c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === ' ') { i++; continue; }
      if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
        /* a base literal followed by a digit that its base can't contain
           (0b102, 0o78, 0x1F.5) must be an error, not a silent implicit
           multiplication that "answers" the typo */
        var badTail = function (j) {
          if (j < n && /[0-9.]/.test(src[j])) throw new CalcErr('syntax', 'malformed number literal “' + src.slice(i, j + 1) + '…”');
        };
        if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
          var j = i + 2; while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
          if (j === i + 2) throw new CalcErr('syntax', 'incomplete hex literal');
          badTail(j);
          toks.push({ t: 'num', base: 16, s: src.slice(i + 2, j) }); i = j; continue;
        }
        if (c === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B') && /[01]/.test(src[i + 2] || '')) {
          var j2 = i + 2; while (j2 < n && /[01]/.test(src[j2])) j2++;
          badTail(j2);
          toks.push({ t: 'num', base: 2, s: src.slice(i + 2, j2) }); i = j2; continue;
        }
        if (c === '0' && (src[i + 1] === 'o' || src[i + 1] === 'O')) {
          var j3 = i + 2; while (j3 < n && /[0-7]/.test(src[j3])) j3++;
          if (j3 === i + 2) throw new CalcErr('syntax', 'incomplete octal literal');
          badTail(j3);
          toks.push({ t: 'num', base: 8, s: src.slice(i + 2, j3) }); i = j3; continue;
        }
        var m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
        toks.push({ t: 'num', base: 10, s: m[0] }); i += m[0].length; continue;
      }
      if (isIdent0(c)) {
        if (c === '°') { // ° / °C / °F
          if (src[i + 1] === 'C') { toks.push({ t: 'id', s: 'degC' }); i += 2; continue; }
          if (src[i + 1] === 'F') { toks.push({ t: 'id', s: 'degF' }); i += 2; continue; }
          toks.push({ t: 'id', s: 'deg' }); i++; continue;
        }
        if (c === "'" || c === '′') { toks.push({ t: 'id', s: 'ft' }); i++; continue; }
        if (c === '"' || c === '″') { toks.push({ t: 'id', s: 'in', quoted: true }); i++; continue; }
        if (c === 'π') { toks.push({ t: 'id', s: 'pi' }); i++; continue; }
        if (c === 'τ') { toks.push({ t: 'id', s: 'tau' }); i++; continue; }
        if (c === 'φ') { toks.push({ t: 'id', s: 'phi' }); i++; continue; }
        if (c === 'Ω') { toks.push({ t: 'id', s: 'ohm' }); i++; continue; }
        var j4 = i + 1; while (j4 < n && isIdentC(src[j4])) j4++;
        var w = src.slice(i, j4);
        var lw = w.toLowerCase();
        if (lw === 'in') toks.push({ t: 'conv?', s: 'in' });        // resolved in a post-pass
        else if (lw === 'as') toks.push({ t: 'op', s: 'to' });      // `as` is a convert synonym
        else if (WORDOPS[lw]) toks.push({ t: 'op', s: lw });
        else toks.push({ t: 'id', s: w });
        i = j4; continue;
      }
      if (src.startsWith('**', i)) { toks.push({ t: 'op', s: '^' }); i += 2; continue; }
      if (src.startsWith('<<', i)) { toks.push({ t: 'op', s: '<<' }); i += 2; continue; }
      if (src.startsWith('>>', i)) { toks.push({ t: 'op', s: '>>' }); i += 2; continue; }
      if ('+-*/^%!&|~(),'.indexOf(c) >= 0) { toks.push({ t: c === '(' || c === ')' || c === ',' ? c : 'op', s: c }); i++; continue; }
      if (c === '×' || c === '⋅' || c === '·') { toks.push({ t: 'op', s: '*' }); i++; continue; }
      if (c === '÷') { toks.push({ t: 'op', s: '/' }); i++; continue; }
      if (c === '−') { toks.push({ t: 'op', s: '-' }); i++; continue; }
      if (c === '=') { // tolerate a TRAILING "=" only — a mid-expression "=" must not vanish (`1=2` is not 2)
        if (/^\s*$/.test(src.slice(i + 1))) { i++; continue; }
        throw new CalcErr('syntax', 'unexpected “=” — equations are not supported yet');
      }
      throw new CalcErr('syntax', 'unexpected character “' + c + '”');
    }
    if (toks.length > MAXTOK) throw new CalcErr('syntax', 'expression too long');

    /* post-pass 1: resolve `in` — inch vs convert.
       inch when: previous token is a NUMBER and the next token is
       missing / another convert word / an operator / ')' / '!'.
       convert otherwise. */
    for (var kk = 0; kk < toks.length; kk++) {
      if (toks[kk].t !== 'conv?') continue;
      var prev = toks[kk - 1], next = toks[kk + 1];
      var inch = prev && prev.t === 'num' &&
        (!next || next.t === 'conv?' || (next.t === 'op' && next.s !== 'of') || next.t === ')');
      toks[kk] = inch ? { t: 'id', s: 'in' } : { t: 'op', s: 'to' };
    }
    /* post-pass 2: '%' is MOD when a value follows (including a unary-
       signed one: `5 % -2`), PERCENT otherwise */
    for (var pp = 0; pp < toks.length; pp++) {
      if (toks[pp].t === 'op' && toks[pp].s === '%') {
        var nx = toks[pp + 1];
        var isVal = function (t) { return t && (t.t === 'num' || t.t === 'id' || t.t === '(' || t.t === 'conv?'); };
        var isMod = isVal(nx) ||
          (nx && nx.t === 'op' && (nx.s === '-' || nx.s === '+' || nx.s === '~') && isVal(toks[pp + 2]));
        toks[pp].s = isMod ? 'mod' : '%pct';
      }
    }
    return toks;
  }

  /* ── parser (precedence climbing) ───────────────────────────────── */
  var BASE_WORDS = { hex: 16, hexadecimal: 16, bin: 2, binary: 2, oct: 8, octal: 8, dec: 10, decimal: 10 };
  function Parser(toks) { this.toks = toks; this.i = 0; this.depth = 0; }
  Parser.prototype.peek = function () { return this.toks[this.i] || null; };
  Parser.prototype.next = function () { return this.toks[this.i++] || null; };
  Parser.prototype.expect = function (t) {
    var tk = this.next();
    if (!tk || tk.t !== t) throw new CalcErr('syntax', tk ? 'unexpected “' + tk.s + '”' : 'unexpected end of expression');
    return tk;
  };
  var BP = { to: 1, or: 2, '|': 2, xor: 3, and: 4, '&': 4, '<<': 5, '>>': 5, '+': 6, '-': 6, '*': 7, '/': 7, mod: 7, of: 7, '^': 9 };

  Parser.prototype.parseExpr = function (minbp) {
    if (++this.depth > MAXDEPTH) throw new CalcErr('syntax', 'expression too deeply nested');
    var lhs = this.parsePrefix();
    for (; ;) {
      var tk = this.peek();
      if (!tk) break;
      if (tk.t === 'op' && tk.s === '%pct') { this.next(); lhs = { t: 'pct', x: lhs }; continue; }
      if (tk.t === 'op' && tk.s === '!') { this.next(); lhs = { t: 'fact', x: lhs }; continue; }
      var op = null, bp = 0;
      if (tk.t === 'op' && BP[tk.s] !== undefined) { op = tk.s; bp = BP[tk.s]; }
      /* implicit multiplication (2pi, 3 km, 2(1+2)) binds TIGHTER than
         explicit * and / — so `20 L / 100 km` is (20 L)/(100 km) and
         `1/2pi` is 1/(2π), matching unit intuition and Casio convention.
         Deliberately NOT for a bare number after a number (`2 3`): silent
         juxtaposition-as-multiplication answers typos like `0b10 2`. */
      else if (tk.t === 'id' || tk.t === '(') { op = '*imp'; bp = 8; }
      else break;
      if (bp < minbp) break;
      if (op === 'to') {
        this.next();
        var bw = this.peek();
        if (bw && bw.t === 'id' && BASE_WORDS[bw.s.toLowerCase()]) {
          this.next();
          lhs = { t: 'convbase', x: lhs, base: BASE_WORDS[bw.s.toLowerCase()] };
        } else {
          var target = this.parseExpr(BP.to + 1);
          lhs = { t: 'conv', x: lhs, target: target };
        }
        continue;
      }
      if (op === '*imp') {
        var rhs0 = this.parseExpr(9); // rhs above imp level so `2 m^2` = 2·(m²) and chains stay left-assoc
        lhs = { t: 'bin', op: '*', l: lhs, r: rhs0, implicit: true };
        continue;
      }
      this.next();
      var rbp = (op === '^') ? bp : bp + 1;   // ^ right-assoc
      var rhs = this.parseExpr(rbp);
      lhs = { t: 'bin', op: op, l: lhs, r: rhs };
    }
    this.depth--;
    return lhs;
  };
  Parser.prototype.parsePrefix = function () {
    var tk = this.next();
    if (!tk) throw new CalcErr('syntax', 'unexpected end of expression');
    if (tk.t === 'op' && (tk.s === '-' || tk.s === '+')) {
      var x = this.parseExpr(8);
      return tk.s === '-' ? { t: 'neg', x: x } : x;
    }
    if (tk.t === 'op' && tk.s === '~') return { t: 'bnot', x: this.parseExpr(8) };
    if (tk.t === '(') {
      var e = this.parseExpr(0);
      this.expect(')');
      return e;
    }
    if (tk.t === 'num') return { t: 'num', base: tk.base, s: tk.s };
    if (tk.t === 'id') {
      if (this.peek() && this.peek().t === '(') {
        this.next();
        var args = [];
        if (this.peek() && this.peek().t !== ')') {
          args.push(this.parseExpr(0));
          while (this.peek() && this.peek().t === ',') { this.next(); args.push(this.parseExpr(0)); }
        }
        this.expect(')');
        return { t: 'call', name: tk.s, args: args };
      }
      return { t: 'id', name: tk.s };
    }
    throw new CalcErr('syntax', 'unexpected “' + tk.s + '”');
  };

  /* ── evaluation ─────────────────────────────────────────────────── */
  var CONSTS = {
    pi: function () { return mkF(Math.PI); },
    tau: function () { return mkF(2 * Math.PI); },
    e: function () { return mkF(Math.E); },
    phi: function () { return mkF((1 + Math.sqrt(5)) / 2); },
    i: function () { return mkC(0, 1); }
  };
  function real1(fn) {
    return function (a) { return mkF(fn(angleToF(a))); };
  }
  function angleToF(a) { // trig accepts pure-angle quantities (radians SI)
    if (a && a.k === 'q') {
      var pure = a.dim.every(function (e, ix) { return ix === AN ? true : e === 0; });
      if (pure && a.dim[AN] === 1) return toF(a.v);
      throw new CalcErr('math', 'expected an angle or plain number');
    }
    return toF(a);
  }
  function plainF(a) {
    if (a && a.k === 'q') throw new CalcErr('math', 'this function takes a plain number — convert the unit away first');
    return toF(a);
  }
  var FUNCS = {
    sin: { n: 1, f: real1(Math.sin) }, cos: { n: 1, f: real1(Math.cos) }, tan: { n: 1, f: real1(Math.tan) },
    asin: { n: 1, f: function (a) { return mkF(Math.asin(plainF(a))); } },
    acos: { n: 1, f: function (a) { return mkF(Math.acos(plainF(a))); } },
    atan: { n: 1, f: function (a) { return mkF(Math.atan(plainF(a))); } },
    atan2: { n: 2, f: function (a, b) { return mkF(Math.atan2(plainF(a), plainF(b))); } },
    sinh: { n: 1, f: function (a) { return mkF(Math.sinh(plainF(a))); } },
    cosh: { n: 1, f: function (a) { return mkF(Math.cosh(plainF(a))); } },
    tanh: { n: 1, f: function (a) { return mkF(Math.tanh(plainF(a))); } },
    asinh: { n: 1, f: function (a) { return mkF(Math.asinh(plainF(a))); } },
    acosh: { n: 1, f: function (a) { return mkF(Math.acosh(plainF(a))); } },
    atanh: { n: 1, f: function (a) { return mkF(Math.atanh(plainF(a))); } },
    sqrt: {
      n: 1, f: function (a) {
        if (a.k === 'q') return powN(a, mkR(1n, 2n));
        if (a.k === 'c') return cpow(a, mkR(1n, 2n));
        if (a.k === 'r') {
          if (a.n >= 0n) { var rt = ratRoot(a, 2); if (rt) return rt; return mkF(Math.sqrt(ratToNumber(a.n, a.d))); }
          var pos = mkR(-a.n, a.d), rt2 = ratRoot(pos, 2);
          return mkC(0, rt2 ? toF(rt2) : Math.sqrt(ratToNumber(pos.n, pos.d)));
        }
        return a.v >= 0 ? mkF(Math.sqrt(a.v)) : mkC(0, Math.sqrt(-a.v));
      }
    },
    cbrt: {
      n: 1, f: function (a) {
        if (a.k === 'q') return powN(a, mkR(1n, 3n));
        if (a.k === 'c') return cpow(a, mkR(1n, 3n));
        if (a.k === 'r') { var rt = ratRoot(a, 3); if (rt) return rt; }
        return mkF(Math.cbrt(toF(a)));
      }
    },
    root: {
      n: 2, f: function (a, b) {
        var nB = asIntBig(b, 'root index');
        if (nB < 2n || nB > 64n) throw new CalcErr('math', 'root index must be 2…64');
        var ni = Number(nB);
        if (a.k === 'q') return powN(a, mkR(1n, nB));
        var negA = (a.k === 'r' && a.n < 0n) || (a.k === 'f' && a.v < 0);
        if (negA && ni % 2 === 0) throw new CalcErr('math', 'even root of a negative number — use sqrt for the complex value');
        if (a.k === 'r') { var rt = ratRoot(a, ni); if (rt) return rt; }
        var f = toF(a);
        return mkF(Math.sign(f) * Math.pow(Math.abs(f), 1 / ni));
      }
    },
    abs: {
      n: 1, f: function (a) {
        if (a.k === 'q') return mkQ(FUNCS.abs.f(a.v), a.dim, a.ue);
        if (a.k === 'c') return mkF(Math.hypot(a.re, a.im));
        if (a.k === 'r') return a.n < 0n ? mkR(-a.n, a.d) : a;
        return mkF(Math.abs(a.v));
      }
    },
    exp: { n: 1, f: function (a) { if (a.k === 'c') { var ex = Math.exp(a.re); return mkC(ex * Math.cos(a.im), ex * Math.sin(a.im)); } return mkF(Math.exp(plainF(a))); } },
    ln: {
      n: 1, f: function (a) {
        if (a.k === 'c') return mkC(Math.log(Math.hypot(a.re, a.im)), Math.atan2(a.im, a.re));
        var f = plainF(a);
        if (f < 0) return mkC(Math.log(-f), Math.PI);
        if (f === 0) throw new CalcErr('math', 'ln(0) is undefined');
        return mkF(Math.log(f));
      }
    },
    log: {
      n: -1, f: function (args) {
        if (args.length === 1) return mkF(Math.log10(posF(args[0], 'log')));
        if (args.length === 2) {
          var base = posF(args[1], 'log base');
          if (base === 1) throw new CalcErr('math', 'log base cannot be 1');
          return mkF(Math.log(posF(args[0], 'log')) / Math.log(base));
        }
        throw new CalcErr('math', 'log takes 1 or 2 arguments');
      }
    },
    log2: { n: 1, f: function (a) { return mkF(Math.log2(posF(a, 'log2'))); } },
    log10: { n: 1, f: function (a) { return mkF(Math.log10(posF(a, 'log10'))); } },
    floor: { n: 1, f: roundy(function (f) { return Math.floor(f); }, function (n, d) { return n / d - (n % d !== 0n && n < 0n ? 1n : 0n); }) },
    ceil: { n: 1, f: roundy(function (f) { return Math.ceil(f); }, function (n, d) { return n / d + (n % d !== 0n && n > 0n ? 1n : 0n); }) },
    round: {
      n: 1, f: roundy(function (f) { return Math.round(f); }, function (n, d) {
        var q = n / d, r = n % d; if (r < 0n) { q -= 1n; r += d; }
        return (2n * r >= d) ? q + 1n : q;
      })
    },
    trunc: { n: 1, f: roundy(function (f) { return Math.trunc(f); }, function (n, d) { return n / d; }) },
    frac: {
      n: 1, f: function (a) {
        if (a.k === 'r') { var q = FUNCS.trunc.f(a); return subN(a, q); }
        var f = plainF(a); return mkF(f - Math.trunc(f));
      }
    },
    sign: { n: 1, f: function (a) { var f = plainF(a.k === 'q' ? a.v : a); return mkR(BigInt(Math.sign(f)), 1n); } },
    gcd: { n: -1, f: intFold('gcd', function (x, y) { return gcdBig(x, y); }) },
    lcm: {
      n: -1, f: intFold('lcm', function (x, y) {
        if (x === 0n || y === 0n) return 0n;
        return (x / gcdBig(x, y)) * y;
      })
    },
    min: { n: -1, f: cmpFold(-1) }, max: { n: -1, f: cmpFold(1) },
    ncr: {
      n: 2, f: function (a, b) {
        var n = asIntBig(a, 'nCr'), r = asIntBig(b, 'nCr');
        if (n < 0n || r < 0n) throw new CalcErr('math', 'nCr needs non-negative integers');
        if (r > n) return mkR(0n, 1n);
        if (n - r < r) r = n - r;
        if (r > 200000n) throw new CalcErr('math', 'nCr argument too large');
        var num = 1n, i;
        for (i = 0n; i < r; i++) {
          num = num * (n - i) / (i + 1n);
          if (bitLen(num) > BITLIM) throw new CalcErr('math', 'nCr result too large');
        }
        return mkR(num, 1n);
      }
    },
    npr: {
      n: 2, f: function (a, b) {
        var n = asIntBig(a, 'nPr'), r = asIntBig(b, 'nPr');
        if (n < 0n || r < 0n) throw new CalcErr('math', 'nPr needs non-negative integers');
        if (r > n) return mkR(0n, 1n);
        if (r > 200000n) throw new CalcErr('math', 'nPr argument too large');
        var out = 1n, i;
        for (i = 0n; i < r; i++) {
          out *= (n - i);
          if (bitLen(out) > BITLIM) throw new CalcErr('math', 'nPr result too large');
        }
        return mkR(out, 1n);
      }
    },
    fact: { n: 1, f: factN },
    gamma: { n: 1, f: function (a) { return mkF(gammaF(plainF(a))); } },
    mod: { n: 2, f: function (a, b) { return modN(a, b); } },
    re: { n: 1, f: function (a) { return a.k === 'c' ? mkF(a.re) : (a.k === 'q' ? errPlain() : a); } },
    im: { n: 1, f: function (a) { return a.k === 'c' ? mkF(a.im) : mkR(0n, 1n); } },
    conj: { n: 1, f: function (a) { return a.k === 'c' ? mkC(a.re, -a.im) : a; } },
    arg: { n: 1, f: function (a) { var c = toC(a.k === 'q' ? errPlain() : a); return mkF(Math.atan2(c.im, c.re)); } }
  };
  function errPlain() { throw new CalcErr('math', 'this function takes a plain number'); }
  function posF(a, what) {
    var f = plainF(a);
    if (f <= 0) throw new CalcErr('math', what + ' needs a positive number');
    return f;
  }
  function roundy(ff, fr) {
    return function (a) {
      if (a.k === 'q') throw new CalcErr('math', 'convert to a target unit first, then round the number');
      if (a.k === 'c') throw new CalcErr('math', 'cannot round a complex number');
      if (a.k === 'r') return mkR(fr(a.n, a.d), 1n);
      return mkF(ff(a.v));
    };
  }
  function intFold(name, op) {
    return function (args) {
      if (!args.length) throw new CalcErr('math', name + ' needs arguments');
      var acc = asIntBig(args[0], name), i;
      for (i = 1; i < args.length; i++) acc = op(acc, asIntBig(args[i], name));
      return mkR(acc, 1n);
    };
  }
  function cmpFold(sgn) {
    return function (args) {
      if (!args.length) throw new CalcErr('math', 'min/max need arguments');
      var best = args[0], i;
      for (i = 1; i < args.length; i++) {
        var a = args[i];
        var fa = a.k === 'q' ? toF(a.v) : toF(a), fb = best.k === 'q' ? toF(best.v) : toF(best);
        if (a.k === 'q' || best.k === 'q') {
          if (!(a.k === 'q' && best.k === 'q' && dimEq(a.dim, best.dim))) throw new CalcErr('math', 'min/max arguments must share units');
        }
        if (sgn * (fa - fb) > 0) best = a;
      }
      return best;
    };
  }
  function modN(a, b) {
    if (a.k === 'q' || b.k === 'q') throw new CalcErr('math', 'mod of quantities is not supported');
    if (a.k === 'r' && b.k === 'r') {
      if (b.n === 0n) throw new CalcErr('math', 'mod by zero');
      // floored mod on rationals: a - b*floor(a/b)
      var q = FUNCS.floor.f(divN(a, b));
      return subN(a, mulN(b, q));
    }
    var fb = toF(b);
    if (fb === 0) throw new CalcErr('math', 'mod by zero');
    var fa = toF(a);
    var r = fa - fb * Math.floor(fa / fb);
    return mkF(r);
  }

  function parseNumTok(node) {
    if (node.base !== 10) return mkR(BigInt((node.base === 16 ? '0x' : node.base === 8 ? '0o' : '0b') + node.s), 1n);
    var s = node.s, em = /[eE]/.exec(s), exp = 0, mant = s;
    if (em) { exp = parseInt(s.slice(em.index + 1), 10); mant = s.slice(0, em.index); }
    var dot = mant.indexOf('.');
    var digits = dot < 0 ? mant : mant.slice(0, dot) + mant.slice(dot + 1);
    var scale = dot < 0 ? 0 : mant.length - dot - 1;
    var e10 = exp - scale;
    if (Math.abs(e10) > 20000) return mkF(parseFloat(s));
    digits = digits.replace(/^0+(?=\d)/, '');
    var base = BigInt(digits || '0');
    if (e10 >= 0) return mkR(base * ipowBig(10n, BigInt(e10)), 1n);
    return mkR(base, ipowBig(10n, BigInt(-e10)));
  }

  function Evaluator(env) {
    this.env = env || {};
    this.sawBase = false;       // saw a hex/bin/oct literal or bitwise op
    this.sawConvBase = 0;       // requested output base
  }
  Evaluator.prototype.run = function (node) {
    var self = this;
    function ev(nd) {
      switch (nd.t) {
        case 'num':
          if (nd.base !== 10) self.sawBase = true;
          return parseNumTok(nd);
        case 'id': return self.ident(nd.name);
        case 'neg': return negN(ev(nd.x));
        case 'bnot': self.sawBase = true; return mkR(~asIntBig(ev(nd.x), 'bitwise not'), 1n);
        case 'pct': return divN(ev(nd.x), mkR(100n, 1n));
        case 'fact': return factN(ev(nd.x));
        case 'call': return self.call(nd);
        case 'conv': return self.convert(nd, ev);
        case 'convbase': {
          self.sawConvBase = nd.base;
          var v = ev(nd.x);
          asIntBig(v, 'base conversion'); // validates
          return v;
        }
        case 'bin': {
          var op = nd.op;
          if (op === '+' || op === '-') {
            var l = ev(nd.l);
            if (nd.r.t === 'pct') { // percent convention: A ± p%  →  A·(1 ± p/100)
              var p = divN(ev(nd.r.x), mkR(100n, 1n));
              var fac = op === '+' ? addN(mkR(1n, 1n), p) : subN(mkR(1n, 1n), p);
              return mulN(l, fac);
            }
            var r = ev(nd.r);
            return op === '+' ? addN(l, r) : subN(l, r);
          }
          if (op === '*') {
            /* affine temperature: `25 degC` / `25 * degC` as a direct number×unit pair */
            if (nd.r.t === 'id') {
              var u = lookupUnit(nd.r.name);
              if (u && u.off) {
                var lv = ev(nd.l);
                if (lv.k === 'r' || lv.k === 'f') {
                  var si = addN(mulN(lv, u.f), u.off);
                  var ueT = {}; ueT[nd.r.name] = 1;
                  return mkQ(si, u.dim, ueT);
                }
              }
            }
            return mulN(ev(nd.l), ev(nd.r));
          }
          if (op === '/') return divN(ev(nd.l), ev(nd.r));
          if (op === '^') return powN(ev(nd.l), ev(nd.r));
          if (op === 'mod') return modN(ev(nd.l), ev(nd.r));
          if (op === 'of') return mulN(ev(nd.l), ev(nd.r));
          if (op === 'and' || op === 'or' || op === 'xor') {
            self.sawBase = true;
            var la = asIntBig(ev(nd.l), 'bitwise ' + op), rb = asIntBig(ev(nd.r), 'bitwise ' + op);
            return mkR(op === 'and' ? (la & rb) : op === 'or' ? (la | rb) : (la ^ rb), 1n);
          }
          if (op === '<<' || op === '>>') {
            self.sawBase = true;
            var lv2 = asIntBig(ev(nd.l), 'shift'), sh = asIntBig(ev(nd.r), 'shift amount');
            if (sh < 0n) { sh = -sh; op = op === '<<' ? '>>' : '<<'; }
            if (sh > SHIFT_MAX) throw new CalcErr('math', 'shift amount too large');
            return mkR(op === '<<' ? (lv2 << sh) : (lv2 >> sh), 1n);
          }
          if (op === '&' ) { self.sawBase = true; return mkR(asIntBig(ev(nd.l), 'bitwise and') & asIntBig(ev(nd.r), 'bitwise and'), 1n); }
          if (op === '|') { self.sawBase = true; return mkR(asIntBig(ev(nd.l), 'bitwise or') | asIntBig(ev(nd.r), 'bitwise or'), 1n); }
          throw new CalcErr('syntax', 'unknown operator ' + op);
        }
      }
      throw new CalcErr('syntax', 'malformed expression');
    }
    return ev(node);
  };
  Evaluator.prototype.ident = function (name) {
    var lw = name.toLowerCase();
    if (lw === 'ans') {
      if (!this.env.ans) throw new CalcErr('math', 'no previous result yet');
      return this.env.ans;
    }
    if (CONSTS[lw] && (lw !== 'e' || name === 'e')) return CONSTS[lw]();
    var u = lookupUnit(name);
    if (u) {
      if (u.off) // a bare affine unit has no meaningful linear value
        throw new CalcErr('math', 'write temperatures as “25 ' + name + '”, or convert with “to ' + name + '”');
      var ue = {}; ue[name] = 1;
      return mkQ(u.f, u.dim, ue);
    }
    if (FUNCS[lw]) throw new CalcErr('syntax', name + ' is a function — call it like ' + lw + '(…)');
    throw new CalcErr('math', 'unknown name “' + name + '”');
  };
  Evaluator.prototype.call = function (nd) {
    var fn = FUNCS[nd.name.toLowerCase()];
    if (!fn) throw new CalcErr('math', 'unknown function “' + nd.name + '”');
    var self = this;
    var args = nd.args.map(function (a) { return self.run(a); });
    if (fn.n === -1) return fn.f(args);
    if (args.length !== fn.n) throw new CalcErr('math', nd.name + ' takes ' + fn.n + ' argument' + (fn.n > 1 ? 's' : ''));
    return fn.f.apply(null, args);
  };
  Evaluator.prototype.convert = function (nd, ev) {
    var val = ev(nd.x);
    /* affine target: `x to degF` where target is a bare unit ident.
       The quantity KEEPS its SI value — the affine offset is applied at
       display time only (fmtNum), so chained converts and ans stay true. */
    if (nd.target.t === 'id') {
      var u = lookupUnit(nd.target.name);
      if (u && u.off) {
        if (val.k !== 'q' || !dimEq(val.dim, u.dim)) throw new CalcErr('math', 'unit mismatch: expected a temperature');
        var ue1 = {}; ue1[nd.target.name] = 1;
        return { k: 'q', v: val.v, dim: u.dim, ue: ue1 };
      }
    }
    var tgt = ev(nd.target);
    if (tgt.k !== 'q') {
      if (val.k === 'q') throw new CalcErr('math', 'conversion target must be a unit');
      throw new CalcErr('math', 'nothing to convert — left side has no units');
    }
    if (val.k !== 'q') {
      if (dimEq(tgt.dim, UNITS['in'].dim)) // classic "5 in ft" confusion
        throw new CalcErr('math', 'left side has no units — write the source unit (e.g. “5 in to ft” means 5 inches)');
      throw new CalcErr('math', 'left side has no units to convert');
    }
    if (!dimEq(val.dim, tgt.dim)) throw new CalcErr('math', 'unit mismatch: cannot convert ' + humanDim(val) + ' to ' + humanDim(tgt));
    return { k: 'q', v: val.v, dim: val.dim, ue: tgt.ue };
  };

  /* ── formatting ─────────────────────────────────────────────────── */
  function groupInt(s) {
    var neg = s[0] === '-'; if (neg) s = s.slice(1);
    var out = '', i = s.length;
    for (; i > 3; i -= 3) out = ',' + s.slice(i - 3, i) + out;
    return (neg ? '-' : '') + s.slice(0, i) + out;
  }
  function fmtF(v) {
    if (Object.is(v, -0)) v = 0;
    if (Number.isNaN(v)) return 'undefined';
    if (v === Infinity) return '∞';
    if (v === -Infinity) return '-∞';
    var a = Math.abs(v);
    if (a !== 0 && (a >= 1e21 || a < 1e-9)) {
      var s = v.toExponential(11);
      var mm = /^(-?\d(?:\.\d+)?)e([+-]\d+)$/.exec(s);
      var mant = mm[1].replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
      return mant + 'e' + String(parseInt(mm[2], 10));
    }
    var t = String(parseFloat(v.toPrecision(15)));
    if (t.indexOf('e') < 0 && t.indexOf('.') < 0) return groupInt(t);
    if (t.indexOf('e') < 0 && t.indexOf('.') > 0) {
      var parts = t.split('.');
      return groupInt(parts[0]) + '.' + parts[1];
    }
    return t;
  }
  /* rational with terminating decimal (den = 2^a·5^b, ≤ 20 places) → exact decimal string */
  function ratDecimal(x) {
    var d = x.d, a = 0, b = 0;
    while (d % 2n === 0n) { d /= 2n; a++; }
    while (d % 5n === 0n) { d /= 5n; b++; }
    if (d !== 1n) return null;
    var places = Math.max(a, b);
    if (places === 0 || places > 20) return null;
    var scale = ipowBig(10n, BigInt(places));
    var scaled = (x.n < 0n ? -x.n : x.n) * scale / x.d;
    var s = scaled.toString().padStart(places + 1, '0');
    var ip = s.slice(0, s.length - places), fp = s.slice(s.length - places).replace(/0+$/, '');
    return (x.n < 0n ? '-' : '') + groupInt(ip) + (fp ? '.' + fp : '');
  }
  function fmtNum(x) { // → { text, approx?, note?, full? }
    if (x.k === 'r') {
      if (x.d === 1n) {
        var s = x.n.toString();
        if (s.replace('-', '').length > 60) {
          var digits = s.replace('-', '').length;
          var head = (x.n < 0n ? '-' : '') + s.replace('-', '')[0] + '.' + s.replace('-', '').slice(1, 13);
          return { text: head + 'e' + (digits - 1), note: groupInt(String(digits)) + ' digits', full: s };
        }
        return { text: groupInt(s) };
      }
      var dec = ratDecimal(x);
      if (dec) return { text: dec };
      return { text: groupInt(x.n.toString()) + '/' + groupInt(x.d.toString()), approx: fmtF(ratToNumber(x.n, x.d)) };
    }
    if (x.k === 'f') return { text: fmtF(x.v) };
    if (x.k === 'c') {
      var re = x.re, im = x.im, out;
      var ims = (Math.abs(im) === 1 ? '' : fmtF(Math.abs(im))) + 'i';
      if (re === 0) out = (im < 0 ? '-' : '') + ims;
      else out = fmtF(re) + (im < 0 ? ' - ' : ' + ') + ims;
      return { text: out };
    }
    if (x.k === 'q') {
      var us = ueToString(x.ue);
      var disp = null;
      var qkeys = Object.keys(x.ue);
      if (qkeys.length === 1 && x.ue[qkeys[0]] === 1) {
        var au = lookupUnit(qkeys[0]);
        if (au && au.off) disp = divN(subN(x.v, au.off), au.f); // affine scale, display-time only
      }
      if (!disp) {
        var f = ueFactor(x.ue);
        disp = f ? divN(x.v, f) : x.v;
      }
      var inner = fmtNum(disp);
      if (inner.approx) { inner.text = inner.approx; inner.approx = null; } // quantities read as decimals, not fractions
      inner.text += ' ' + us;
      return inner;
    }
    return { text: '?' };
  }

  /* ── closed-form detection ──────────────────────────────────────── */
  var NAMED = [
    { v: Math.PI, s: 'π' }, { v: Math.E, s: 'e' }, { v: (1 + Math.sqrt(5)) / 2, s: 'φ' },
    { v: Math.LN2, s: 'ln 2' }, { v: Math.log(10), s: 'ln 10' }, { v: Math.sqrt(2 * Math.PI), s: '√(2π)' }
  ];
  function closedForm(v) {
    if (!isFinite(v) || v === 0) return null;
    var a = Math.abs(v), sgn = v < 0 ? '-' : '';
    if (a < 1e-8 || a > 1e8) return null;
    var d, n, cand;
    /* small non-terminating rationals: 1/3, 5/6, … */
    for (d = 3; d <= 12; d++) {
      if (d === 4 || d === 5 || d === 8 || d === 10) continue; // terminating — display already exact
      n = Math.round(a * d);
      if (n === 0 || n > 240) continue;
      if (n % d === 0) continue;
      var g = gcdInt(n, d); if (g > 1) continue; // reduced form has a smaller d — found later? no: skip dup
      cand = n / d;
      if (relOk(a, cand)) return sgn + n + '/' + d;
    }
    /* k·π/d */
    for (d = 1; d <= 12; d++) {
      n = Math.round(a * d / Math.PI);
      if (n === 0 || n > 36) continue;
      var g2 = gcdInt(n, d); if (g2 > 1) continue;
      cand = n * Math.PI / d;
      if (relOk(a, cand)) {
        var num = (n === 1 ? 'π' : n + 'π');
        return sgn + (d === 1 ? num : num + '/' + d);
      }
    }
    /* √m and √m/d */
    for (d = 1; d <= 10; d++) {
      var sq = a * d, m = Math.round(sq * sq);
      if (m < 2 || m > 1000) continue;
      var r = Math.sqrt(m);
      if (Number.isInteger(r)) continue;
      cand = r / d;
      if (relOk(a, cand)) return sgn + '√' + m + (d === 1 ? '' : '/' + d);
    }
    /* named constants ×(n/d) small */
    for (var ci = 0; ci < NAMED.length; ci++) {
      for (d = 1; d <= 6; d++) {
        n = Math.round(a * d / NAMED[ci].v);
        if (n === 0 || n > 12) continue;
        var g3 = gcdInt(n, d); if (g3 > 1) continue;
        cand = n * NAMED[ci].v / d;
        if (relOk(a, cand)) {
          var lead = n === 1 ? '' : n === -1 ? '-' : String(n);
          var core = (NAMED[ci].s.length > 2 && n !== 1 ? n + '·' + NAMED[ci].s : lead + NAMED[ci].s);
          return sgn + (d === 1 ? core : core + '/' + d);
        }
      }
    }
    return null;
  }
  function relOk(a, cand) { return cand > 0 && Math.abs(a - cand) / cand < 1e-14; }
  function gcdInt(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }

  /* ── common conversion tables (for the units card) ─────────────── */
  var COMMONS = [
    { dim: D(L, 1), units: ['km', 'm', 'cm', 'mm', 'mi', 'yd', 'ft', 'in'] },
    { dim: D(M, 1), units: ['t', 'kg', 'g', 'lb', 'oz'] },
    { dim: D(T, 1), units: ['year', 'week', 'day', 'h', 'min', 's', 'ms'] },
    { dim: D(DA, 1), units: ['TB', 'GB', 'MB', 'KB', 'B', 'bit', 'GiB', 'MiB', 'KiB'] },
    { dim: D(L, 1, T, -1), units: ['kph', 'mph', 'knot'], extra: [{ label: 'm/s', ue: { m: 1, s: -1 } }] },
    { dim: D(L, 2, M, 1, T, -2), units: ['J', 'kJ', 'cal', 'kcal', 'Wh', 'kWh'] },
    { dim: D(L, -1, M, 1, T, -2), units: ['Pa', 'kPa', 'bar', 'atm', 'psi', 'mmHg'] },
    { dim: D(L, 2, M, 1, T, -3), units: ['W', 'kW', 'hp'] },
    { dim: D(AN, 1), units: ['rad', 'deg', 'grad', 'turn'] },
    { dim: D(T, -1), units: ['Hz', 'kHz', 'MHz', 'GHz'] },
    { dim: D(L, 3), units: ['L', 'mL', 'gal'], extra: [{ label: 'm^3', ue: { m: 3 } }] }
  ];
  function unitsCard(q) {
    if (dimEq(q.dim, D(TH, 1))) { // temperature — affine three-way (q.v is always SI kelvin now)
      var si = toF(q.v);
      return {
        t: 'units', title: 'temperature scales', rows: [
          [fmtF(si - 273.15), '°C'], [fmtF(si * 9 / 5 - 459.67), '°F'], [fmtF(si), 'K']
        ]
      };
    }
    for (var i = 0; i < COMMONS.length; i++) {
      if (!dimEq(q.dim, COMMONS[i].dim)) continue;
      var rows = [], j, shownUe = ueToString(q.ue);
      var list = COMMONS[i].units;
      for (j = 0; j < list.length && rows.length < 6; j++) {
        if (list[j] === shownUe) continue;
        var u = lookupUnit(list[j]);
        rows.push([stripTrail(fmtNum(divN(q.v, u.f)).approx || fmtNum(divN(q.v, u.f)).text), list[j]]);
      }
      (COMMONS[i].extra || []).forEach(function (ex) {
        if (rows.length >= 7 || ueToString(ex.ue) === shownUe) return;
        rows.push([stripTrail(fmtNum(divN(q.v, ueFactor(ex.ue))).approx || fmtNum(divN(q.v, ueFactor(ex.ue))).text), ex.label]);
      });
      return rows.length ? { t: 'units', title: 'also equal to', rows: rows } : null;
    }
    return null;
  }
  function stripTrail(s) { return s; }

  /* ── base card ──────────────────────────────────────────────────── */
  function baseCard(x, want) {
    if (!isInt(x)) return null;
    var n = x.n, neg = n < 0n; if (neg) n = -n;
    if (bitLen(n) > 1024) return null;
    function grp(s, size) {
      var out = '', i = s.length;
      for (; i > size; i -= size) out = ' ' + s.slice(i - size, i) + out;
      return s.slice(0, i) + out;
    }
    var sg = neg ? '-' : '';
    var rows = [
      ['hex', sg + '0x' + grp(n.toString(16).toUpperCase(), 4)],
      ['dec', sg + groupInt(n.toString())],
      ['oct', sg + '0o' + grp(n.toString(8), 3)],
      ['bin', sg + '0b' + grp(n.toString(2), 4)]
    ];
    var order = { 16: 0, 10: 1, 8: 2, 2: 3 };
    return { t: 'base', title: 'number bases', rows: rows, hot: want ? order[want] : -1 };
  }

  /* ── date engine ────────────────────────────────────────────────── */
  var DATE_UNITS = { day: 'd', days: 'd', d: 'd', week: 'w', weeks: 'w', wk: 'w', month: 'mo', months: 'mo', mo: 'mo', year: 'y', years: 'y', yr: 'y', hour: 'h', hours: 'h', h: 'h', minute: 'mi', minutes: 'mi', min: 'mi' };
  function dateSniff(src) {
    return /\b(today|now|tomorrow|yesterday)\b/i.test(src) || /\b\d{4}-\d{2}-\d{2}\b/.test(src);
  }
  function dateEval(src, nowMs) {
    var s = src.trim().replace(/\s+/g, ' ');
    var now = new Date(nowMs);
    var mDiff = /^(.+?)\s+(?:to|until|-)\s+(.+)$/i.exec(s);
    if (mDiff) {
      var d1 = parseDateAtom(mDiff[1], now), d2 = parseDateAtom(mDiff[2], now);
      if (d1 && d2) return diffCards(d1.d, d2.d, mDiff[1], mDiff[2]);
    }
    var m = /^(today|now|tomorrow|yesterday|\d{4}-\d{2}-\d{2})((\s*[-+]\s*\d+\s*[a-z]+)*)$/i.exec(s);
    if (!m) throw new CalcErr('math', 'date syntax: <date> ± N days/weeks/months/years, or <date> to <date>');
    var atom = parseDateAtom(m[1], now);
    if (!atom) throw new CalcErr('math', 'unrecognised date “' + m[1] + '”');
    var d = new Date(atom.d), hasTime = atom.time, stepsRaw = m[2] || '';
    var re = /([-+])\s*(\d+)\s*([a-z]+)/gi, st, any = false;
    while ((st = re.exec(stepsRaw))) {
      any = true;
      var sign = st[1] === '-' ? -1 : 1, nn = parseInt(st[2], 10), uu = DATE_UNITS[st[3].toLowerCase()];
      if (!uu) throw new CalcErr('math', 'unknown date unit “' + st[3] + '” (try days, weeks, months, years)');
      if (nn > 5000000) throw new CalcErr('math', 'date offset too large');
      if (uu === 'd') d.setDate(d.getDate() + sign * nn);
      else if (uu === 'w') d.setDate(d.getDate() + sign * 7 * nn);
      else if (uu === 'mo') addMonths(d, sign * nn);
      else if (uu === 'y') addMonths(d, sign * 12 * nn);
      else if (uu === 'h') { d.setHours(d.getHours() + sign * nn); hasTime = true; }
      else if (uu === 'mi') { d.setMinutes(d.getMinutes() + sign * nn); hasTime = true; }
      if (!Number.isFinite(d.getTime())) throw new CalcErr('math', 'date out of range'); // Date caps at ±275,760 years
    }
    if (!Number.isFinite(d.getTime())) throw new CalcErr('math', 'date out of range');
    var iso = isoDate(d);
    /* drows are SEMANTIC (slug + numbers): the mount layer localises them
       via i18n + Intl; engine text stays a neutral ISO string. */
    var drows = [{ k: 'weekday', ts: d.getTime() }];
    if (hasTime) drows.push({ k: 'time', hh: d.getHours(), mm: d.getMinutes() });
    var today0 = midnight(now), that0 = midnight(d);
    var dd = Math.round((that0 - today0) / 86400000);
    if (any || dd !== 0) drows.push({ k: 'fromToday', days: dd });
    drows.push({ k: 'dayOfYear', n: dayOfYear(d) });
    drows.push({ k: 'isoWeek', n: isoWeek(d) });
    return { cards: [{ t: 'date', big: iso, drows: drows }], text: iso };
  }
  function parseDateAtom(s, now) {
    s = s.trim().toLowerCase();
    var d = new Date(now), time = false;
    if (s === 'today') { d = midnightD(now); }
    else if (s === 'now') { time = true; }
    else if (s === 'tomorrow') { d = midnightD(now); d.setDate(d.getDate() + 1); }
    else if (s === 'yesterday') { d = midnightD(now); d.setDate(d.getDate() - 1); }
    else {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (!m) return null;
      d = new Date(+m[1], +m[2] - 1, +m[3]);
      if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) throw new CalcErr('math', '“' + s + '” is not a real calendar date');
    }
    return { d: d, time: time };
  }
  function diffCards(a, b, la, lb) {
    var a0 = midnight(a), b0 = midnight(b);
    var days = Math.round((b0 - a0) / 86400000);
    var absDays = Math.abs(days);
    var from = new Date(Math.min(a0, b0)), to = new Date(Math.max(a0, b0));
    /* anchor-walk calendar breakdown: step whole months from `from`
       (with day clamping) while we stay ≤ to, then count leftover real
       days — a single subtract-and-borrow can leave dd negative
       (2026-01-31 → 2026-03-01 used to show "1 month -2 days"). */
    var months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    var anchor = new Date(from); addMonths(anchor, months);
    if (anchor > to) { months--; anchor = new Date(from); addMonths(anchor, months); }
    var y = Math.floor(months / 12), mo = months % 12;
    var dd = Math.round((midnight(to) - midnight(anchor)) / 86400000);
    return {
      cards: [{
        t: 'date', days: absDays, drows: [
          { k: 'calendar', y: y, mo: mo, d: dd },
          { k: 'weeks', w: Math.floor(absDays / 7), d: absDays % 7 },
          { k: 'direction', text: days >= 0 ? la.trim() + ' → ' + lb.trim() : lb.trim() + ' → ' + la.trim() }
        ]
      }],
      text: absDays + ' days'
    };
  }
  function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function midnightD(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addMonths(d, n) {
    var day = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + n);
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  }
  function isoDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dayOfYear(d) { return Math.round((midnight(d) - new Date(d.getFullYear(), 0, 1).getTime()) / 86400000) + 1; }
  function isoWeek(d) {
    var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() + 4 - (t.getDay() || 7));
    var y0 = new Date(t.getFullYear(), 0, 1);
    return Math.ceil(((t - y0) / 86400000 + 1) / 7);
  }

  /* ── top-level evaluate ─────────────────────────────────────────── */
  function evaluate(src, opts) {
    opts = opts || {};
    src = String(src || '');
    if (!src.trim()) return { ok: false, kind: 'syntax', msg: 'empty' };
    /* hard length gate BEFORE any parsing (including the date engine) —
       MAXTOK alone doesn't bound a single million-digit literal entering
       BigInt(), nor a date expression with thousands of ±N steps. */
    if (src.length > 2000) return { ok: false, kind: 'math', msg: 'expression too long (2,000 characters max)' };
    try {
      if (dateSniff(src)) {
        var dr = dateEval(src, opts.now || Date.now());
        return { ok: true, kindOf: 'date', cards: dr.cards, text: dr.text, ans: null };
      }
      var toks = tokenize(src);
      if (!toks.length) return { ok: false, kind: 'syntax', msg: 'empty' };
      var p = new Parser(toks);
      var ast = p.parseExpr(0);
      if (p.peek()) throw new CalcErr('syntax', 'unexpected “' + p.peek().s + '”');
      var ev = new Evaluator({ ans: opts.ans || null });
      var val = ev.run(ast);

      var cards = [], main = fmtNum(val);
      var mainCard = { t: 'main', exact: main.text, approx: main.approx || null, note: main.note || null, full: main.full || null };
      cards.push(mainCard);
      if (val.k === 'f') {
        var cf = closedForm(val.v);
        if (cf) cards.push({ t: 'closed', text: cf });
      }
      if (val.k === 'q') {
        var uc = unitsCard(val);
        if (uc) cards.push(uc);
      }
      if ((ev.sawBase || ev.sawConvBase) && val.k === 'r') {
        var bc = baseCard(val, ev.sawConvBase || 16);
        if (bc) {
          if (ev.sawConvBase) { // hoist requested base into the main line
            var hot = bc.rows[bc.hot];
            mainCard.exact = hot[1];
            mainCard.approx = null;
          }
          cards.push(bc);
        }
      }
      var short = mainCard.exact + (mainCard.approx ? ' ≈ ' + mainCard.approx : '');
      return { ok: true, kindOf: 'math', cards: cards, text: short, ans: val.k === 'q' ? { k: 'q', v: val.v, dim: val.dim, ue: val.ue } : val };
    } catch (err) {
      if (err instanceof CalcErr) return { ok: false, kind: err.kind, msg: err.msg };
      if (err instanceof RangeError) return { ok: false, kind: 'math', msg: 'number too large to compute' };
      return { ok: false, kind: 'math', msg: 'could not evaluate (' + (err && err.message || 'error') + ')' };
    }
  }

  return {
    evaluate: evaluate,
    /* exposed for tests */
    _internals: { tokenize: tokenize, fmtF: fmtF, closedForm: closedForm, lookupUnit: lookupUnit }
  };
});

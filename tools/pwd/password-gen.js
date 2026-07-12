/* Password generation. Core logic of the Password tool on subnsub.com,
   kept in lockstep with the in-page version.

   Every character is drawn from crypto.getRandomValues through rejection
   sampling: 32-bit words that land in the truncated remainder zone above
   the largest multiple of the alphabet size are discarded, so each draw is
   exactly uniform — plain modulo would bias the low end of the alphabet.
   With 32-bit words the rejection zone is under N in 2^32 (one word in
   tens of millions here), so the 64-word batch — sized to the tool's
   maximum length — covers a whole password in one getRandomValues call
   essentially always.

   The strength meter is capacity, not pattern analysis: bits =
   log2(alphabet size) × length, bucketed at 40/60/90. It grades what this
   generator produced; it is not a judge of human-chosen passwords.

   Needs crypto.getRandomValues (all current browsers, Node 18+). */

export const PWD_SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digit: '0123456789',
  symbol: '!@#$%^&*()-_=+[]{};:,.<>/?',
};

/* Glyphs that read alike in most UI fonts (zero/oh, one/ell/eye). */
export const PWD_AMBIG = new Set('0O1lI');

/* Assemble the draw alphabet. `sets` is an iterable of PWD_SETS keys (the
   on-site toggles). Order follows the iterable, but only membership matters
   for uniformity. Returns '' when no sets are selected. */
export function pwdCharset(sets, excludeAmbig) {
  let s = '';
  for (const k of sets) {
    if (typeof PWD_SETS[k] !== 'string') throw new Error('Unknown character set: ' + k);
    s += PWD_SETS[k];
  }
  if (excludeAmbig) s = [...s].filter(c => !PWD_AMBIG.has(c)).join('');
  return s;
}

export function pwdRandomFromAlphabet(alphabet, len) {
  // Rejection sampling for uniform distribution.
  const out = new Array(len);
  const N = alphabet.length;
  const limit = Math.floor(0x100000000 / N) * N;
  const buf = new Uint32Array(64);
  let i = 0;
  while (i < len) {
    crypto.getRandomValues(buf);
    for (let j = 0; j < buf.length && i < len; j++) {
      if (buf[j] < limit) out[i++] = alphabet[buf[j] % N];
    }
  }
  return out.join('');
}

/* Entropy grade for a password of the given length drawn from a charset of
   csSize symbols. Levels map to the on-site meter: 0 none, 1 weak, 2 fair,
   3 strong, 4 very strong. */
export function pwdStrength(pwd, csSize) {
  if (!pwd || csSize < 2) return { label: '—', bits: 0, level: 0 };
  const bits = Math.round(Math.log2(csSize) * pwd.length);
  let label, level;
  if (bits < 40) { label = 'Weak'; level = 1; }
  else if (bits < 60) { label = 'Fair'; level = 2; }
  else if (bits < 90) { label = 'Strong'; level = 3; }
  else { label = 'Very strong'; level = 4; }
  return { label, bits, level };
}

/* One-call flow matching the on-site card: build the alphabet, draw the
   password, grade it. Defaults mirror the tool's initial state (length 16,
   lower + upper + digit, ambiguous characters kept).
   Returns { password, charset, strength }. */
export function generatePassword({ length = 16, sets = ['lower', 'upper', 'digit'], excludeAmbiguous = false } = {}) {
  const cs = pwdCharset(sets, excludeAmbiguous);
  if (!cs) throw new Error('Select at least one character set');
  const password = pwdRandomFromAlphabet(cs, length);
  return { password, charset: cs, strength: pwdStrength(password, cs.length) };
}

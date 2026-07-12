/* Line diff. Core logic of the Diff tool on subnsub.com, kept in lockstep
   with the in-page version.

   Classic O(m·n) longest-common-subsequence table over lines, backtracked
   into a single edit script. The quadratic table is why each side is capped
   at MAX_LINES — past that the tool refuses (returns null) instead of
   freezing the page. The >= tie-break on the insert branch of the backtrack
   makes replaced blocks come out as removals followed by additions, which
   is the order the on-site view renders. */

export const MAX_LINES = 800;

/* LCS edit script over two arrays. The tool feeds it lines, but any arrays
   of ===-comparable values work. Returns null when either side exceeds
   MAX_LINES; otherwise an array of {t, v} ops in document order, where t is
   '=' (unchanged), '+' (added, value from b) or '-' (removed, value from a). */
export function lcs(a, b) {
  const m = a.length, n = b.length;
  if (m > MAX_LINES || n > MAX_LINES) return null;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const r = []; let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { r.unshift({ t: '=', v: a[i - 1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { r.unshift({ t: '+', v: b[j - 1] }); j--; }
    else { r.unshift({ t: '-', v: a[i - 1] }); i--; }
  }
  return r;
}

/* Diff two blobs of text line by line (split on '\n' exactly — a trailing
   newline therefore contributes one empty last line, same as on site).
   Returns null when either side is over MAX_LINES lines, otherwise
   { ops, added, removed, unchanged } with the counts the summary bar shows. */
export function diffLines(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  const d = lcs(la, lb);
  if (!d) return null;
  let added = 0, removed = 0;
  for (const item of d) {
    if (item.t === '+') added++;
    if (item.t === '-') removed++;
  }
  const unchanged = d.length - added - removed;
  return { ops: d, added, removed, unchanged };
}

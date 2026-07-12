/* Byte-mode QR encoder → SVG string. Core logic of the QR Code tool on
   subnsub.com (the QR tab / standalone /qr page), kept in lockstep with
   the in-page version; the LAN pairing widget renders its codes through
   the same encoder.

   ISO/IEC 18004, versions 1-40, byte mode only: input is UTF-8 encoded
   and stored as 8-bit codewords — no numeric/alphanumeric/kanji
   segmentation, so what the scanner decodes is exactly the bytes that
   went in. The smallest version that fits is chosen automatically
   (≈2.9 KB at level L). Reed-Solomon ECC over GF(256) (poly 0x11d),
   block split + interleave per the spec tables, all eight masks tried
   and the lowest ISO penalty score wins, format/version info
   BCH-protected.

   Output is a self-contained <svg> string (one <path> for every dark
   module, crispEdges) — nothing here touches the DOM or the network.
   Decoding is out of scope: the site's scan features use the
   third-party jsQR library (MIT), which is not part of this module. */

const QR = {
  // ECC codewords per block, indexed by [level][version-1]
  ECC: [
    [7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
    [13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  ],
  // Number of error correction blocks, indexed by [level][version-1]
  BLK: [
    [1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25,26],
    [1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
    [1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
    [1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81],
  ],
  // Total codewords (data + ECC) per version (1..40)
  TOTAL: [26,44,70,100,134,172,196,242,292,346,404,466,532,581,655,733,815,901,991,1085,1156,1258,1364,1474,1588,1706,1828,1921,2051,2185,2323,2465,2611,2761,2876,3034,3196,3362,3532,3706],
  LVL: { L: 0, M: 1, Q: 2, H: 3 },
  FMT: [1, 0, 3, 2], // format-info bits for L,M,Q,H
  EXP: null, LOG: null,
  init() {
    this.EXP = new Uint8Array(512); this.LOG = new Uint8Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) { this.EXP[i] = x; this.LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) this.EXP[i] = this.EXP[i - 255];
  },
  mul(a, b) { return a && b ? this.EXP[this.LOG[a] + this.LOG[b]] : 0; },
  alignPos(ver) {
    if (ver < 2) return [];
    const num = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
    const r = [6];
    for (let p = ver * 4 + 10; r.length < num; p -= step) r.splice(1, 0, p);
    return r;
  },
  rsGenPoly(d) {
    let p = new Uint8Array([1]); let root = 1;
    for (let i = 0; i < d; i++) {
      const np = new Uint8Array(p.length + 1);
      for (let j = 0; j < p.length; j++) { np[j + 1] ^= p[j]; np[j] ^= this.mul(p[j], root); }
      p = np; root = this.mul(root, 2);
    }
    // p has length d+1, leading coef = 1; return last d coefs in descending order for rsRem.
    const out = new Uint8Array(d);
    for (let i = 0; i < d; i++) out[i] = p[d - 1 - i];
    return out;
  },
  rsRem(data, gen) {
    const d = gen.length, res = new Uint8Array(d);
    for (let i = 0; i < data.length; i++) {
      const f = data[i] ^ res[0];
      for (let j = 0; j < d - 1; j++) res[j] = res[j + 1] ^ this.mul(gen[j], f);
      res[d - 1] = this.mul(gen[d - 1], f);
    }
    return res;
  },
  encode(text, levelKey = 'M') {
    if (!this.EXP) this.init();
    const data = new TextEncoder().encode(text);
    const lvl = this.LVL[levelKey];
    if (lvl === undefined) throw new Error('Invalid ECC level');
    // Find smallest version that fits.
    let ver = 0, dataCwTotal = 0;
    for (let v = 1; v <= 40; v++) {
      const total = this.TOTAL[v - 1], blk = this.BLK[lvl][v - 1], ecc = this.ECC[lvl][v - 1];
      const dCw = total - ecc * blk;
      const ccBits = v < 10 ? 8 : 16;
      if (4 + ccBits + 8 * data.length <= dCw * 8) { ver = v; dataCwTotal = dCw; break; }
    }
    if (!ver) throw new Error('Data too long for QR');
    const total = this.TOTAL[ver - 1], numBlk = this.BLK[lvl][ver - 1], eccPerBlk = this.ECC[lvl][ver - 1];
    // Bit stream: mode + char count + data + terminator + pad.
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    push(0b0100, 4);
    push(data.length, ver < 10 ? 8 : 16);
    for (const b of data) push(b, 8);
    const term = Math.min(4, dataCwTotal * 8 - bits.length);
    for (let i = 0; i < term; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const pad = [0xEC, 0x11];
    while (bits.length < dataCwTotal * 8) push(pad[(bits.length / 8) % 2], 8);
    const dataCw = new Uint8Array(dataCwTotal);
    for (let i = 0; i < dataCwTotal; i++) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j]; dataCw[i] = b; }
    // Split into RS blocks.
    const shortBlk = Math.floor(total / numBlk) - eccPerBlk;
    const numShort = numBlk - (total % numBlk);
    const blocks = []; const gen = this.rsGenPoly(eccPerBlk);
    let off = 0;
    for (let i = 0; i < numBlk; i++) {
      const dlen = shortBlk + (i < numShort ? 0 : 1);
      const d = dataCw.slice(off, off + dlen); off += dlen;
      blocks.push({ data: d, ecc: this.rsRem(d, gen) });
    }
    // Interleave codewords.
    const cw = new Uint8Array(total); let idx = 0;
    for (let j = 0; j <= shortBlk; j++) for (let i = 0; i < numBlk; i++) {
      if (j < blocks[i].data.length) cw[idx++] = blocks[i].data[j];
    }
    for (let j = 0; j < eccPerBlk; j++) for (let i = 0; i < numBlk; i++) cw[idx++] = blocks[i].ecc[j];
    // Build matrix.
    const N = 4 * ver + 17;
    const m = Array.from({ length: N }, () => new Uint8Array(N));
    const fn = Array.from({ length: N }, () => new Uint8Array(N));
    // Finder patterns at three corners + separators.
    // 7x7: dark ring at r=3 (outer border) + white ring at r=2 + dark 3x3 center (r=0,1).
    for (const [cy, cx] of [[0, 0], [0, N - 7], [N - 7, 0]]) {
      for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
        const y = cy + dy, x = cx + dx;
        if (y < 0 || y >= N || x < 0 || x >= N) continue;
        fn[y][x] = 1;
        if (dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6) {
          const r = Math.max(Math.abs(dy - 3), Math.abs(dx - 3));
          m[y][x] = (r !== 2) ? 1 : 0;
        }
      }
    }
    // Alignment patterns (skip those overlapping finders).
    const ap = this.alignPos(ver);
    for (const ay of ap) for (const ax of ap) {
      if ((ay === 6 && ax === 6) || (ay === 6 && ax === N - 7) || (ay === N - 7 && ax === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const y = ay + dy, x = ax + dx;
        fn[y][x] = 1;
        const r = Math.max(Math.abs(dy), Math.abs(dx));
        m[y][x] = (r === 0 || r === 2) ? 1 : 0;
      }
    }
    // Timing patterns.
    for (let i = 0; i < N; i++) {
      if (!fn[6][i]) { m[6][i] = 1 - (i % 2); fn[6][i] = 1; }
      if (!fn[i][6]) { m[i][6] = 1 - (i % 2); fn[i][6] = 1; }
    }
    // Reserve format info.
    for (let i = 0; i < 9; i++) { fn[8][i] = 1; fn[i][8] = 1; }
    for (let i = 0; i < 8; i++) { fn[N - 1 - i][8] = 1; fn[8][N - 1 - i] = 1; }
    // Reserve version info (v >= 7).
    if (ver >= 7) {
      for (let y = 0; y < 6; y++) for (let x = N - 11; x < N - 8; x++) { fn[y][x] = 1; fn[x][y] = 1; }
    }
    // Place data bits in zig-zag from bottom-right.
    let bidx = 0, xCounter = 0;
    for (let right = N - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      xCounter++;
      const upward = (xCounter & 1) !== 0;
      for (let vert = 0; vert < N; vert++) {
        for (let jj = 0; jj < 2; jj++) {
          const x = right - jj;
          const y = upward ? N - 1 - vert : vert;
          if (!fn[y][x] && bidx < cw.length * 8) {
            m[y][x] = (cw[bidx >> 3] >> (7 - (bidx & 7))) & 1;
            bidx++;
          }
        }
      }
    }
    // Mask functions and helpers.
    const masks = [
      (x, y) => (x + y) % 2 === 0,
      (x, y) => y % 2 === 0,
      (x, y) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0,
      (x, y) => (((y / 2) | 0) + ((x / 3) | 0)) % 2 === 0,
      (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
      (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
      (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
    ];
    const drawFormat = (mat, mask) => {
      const d = (this.FMT[lvl] << 3) | mask;
      let r = d;
      for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      const b = ((d << 10) | (r & 0x3FF)) ^ 0x5412;
      // First copy: L-shape around top-left finder.
      for (let i = 0; i <= 5; i++) mat[i][8] = (b >> i) & 1;
      mat[7][8] = (b >> 6) & 1;
      mat[8][8] = (b >> 7) & 1;
      mat[8][7] = (b >> 8) & 1;
      for (let i = 9; i < 15; i++) mat[8][14 - i] = (b >> i) & 1;
      // Second copy: bottom-left vertical + top-right horizontal + dark module.
      for (let i = 0; i < 8; i++) mat[8][N - 1 - i] = (b >> i) & 1;
      for (let i = 8; i < 15; i++) mat[N - 15 + i][8] = (b >> i) & 1;
      mat[N - 8][8] = 1;
    };
    const drawVersion = (mat) => {
      if (ver < 7) return;
      let r = ver;
      for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
      const b = (ver << 12) | (r & 0xFFF);
      for (let i = 0; i < 18; i++) {
        const a = (i / 3) | 0, c = N - 11 + i % 3, bit = (b >> i) & 1;
        mat[a][c] = bit; mat[c][a] = bit;
      }
    };
    const score = (mat) => {
      let p = 0;
      // Rule 1: runs of 5+ same color.
      for (let y = 0; y < N; y++) {
        let c = -1, r = 0;
        for (let x = 0; x < N; x++) { if (mat[y][x] === c) { r++; if (r === 5) p += 3; else if (r > 5) p++; } else { c = mat[y][x]; r = 1; } }
      }
      for (let x = 0; x < N; x++) {
        let c = -1, r = 0;
        for (let y = 0; y < N; y++) { if (mat[y][x] === c) { r++; if (r === 5) p += 3; else if (r > 5) p++; } else { c = mat[y][x]; r = 1; } }
      }
      // Rule 2: 2x2 blocks of same color.
      for (let y = 0; y < N - 1; y++) for (let x = 0; x < N - 1; x++) {
        const c = mat[y][x];
        if (mat[y][x + 1] === c && mat[y + 1][x] === c && mat[y + 1][x + 1] === c) p += 3;
      }
      // Rule 3: 1:1:3:1:1 ratio finder-look-alike, padded with 4 white.
      const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
      const checkLine = (line) => {
        let cnt = 0;
        for (let j = 0; j <= N - 11; j++) {
          let a = true, b = true;
          for (let k = 0; k < 11; k++) {
            if (line[j + k] !== p1[k]) a = false;
            if (line[j + k] !== p2[k]) b = false;
            if (!a && !b) break;
          }
          if (a) cnt++;
          if (b) cnt++;
        }
        return cnt;
      };
      for (let y = 0; y < N; y++) p += 40 * checkLine(mat[y]);
      for (let x = 0; x < N; x++) {
        const col = new Uint8Array(N);
        for (let y = 0; y < N; y++) col[y] = mat[y][x];
        p += 40 * checkLine(col);
      }
      // Rule 4: dark module proportion (target 50%).
      let dark = 0;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (mat[y][x]) dark++;
      const tot = N * N;
      p += Math.floor(Math.abs(dark * 20 - tot * 10) / tot) * 10;
      return p;
    };
    // Try all 8 masks; pick lowest penalty.
    let bestMask = 0, bestScore = Infinity;
    for (let mk = 0; mk < 8; mk++) {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!fn[y][x] && masks[mk](x, y)) m[y][x] ^= 1;
      drawFormat(m, mk); drawVersion(m);
      const s = score(m);
      if (s < bestScore) { bestScore = s; bestMask = mk; }
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!fn[y][x] && masks[mk](x, y)) m[y][x] ^= 1;
    }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!fn[y][x] && masks[bestMask](x, y)) m[y][x] ^= 1;
    drawFormat(m, bestMask); drawVersion(m);
    return { matrix: m, size: N, version: ver, mask: bestMask, level: levelKey };
  },
  toSvg(qr, opts = {}) {
    const moduleSize = opts.moduleSize || 10, margin = opts.margin != null ? opts.margin : 4;
    const fg = opts.fg || '#000', bg = opts.bg || '#fff';
    const total = (qr.size + margin * 2) * moduleSize;
    let path = '';
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
      if (qr.matrix[y][x]) path += `M${(x + margin) * moduleSize},${(y + margin) * moduleSize}h${moduleSize}v${moduleSize}h-${moduleSize}z`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="${bg}"/><path d="${path}" fill="${fg}"/></svg>`;
  },
};

/* Encode text into a QR symbol.
     text     string — UTF-8 encoded, stored as byte-mode codewords
     level    'L' | 'M' | 'Q' | 'H' (default 'M')
   Returns { matrix, size, version, mask, level }: matrix is an array of
   size Uint8Array rows (1 = dark module), size = 4·version + 17.
   Throws on an unknown level or when the data outgrows version 40. */
export function encode(text, level = 'M') {
  return QR.encode(text, level);
}

/* Render an encode() result as an SVG string.
   opts: { moduleSize=10, margin=4 (quiet-zone modules), fg='#000', bg='#fff' } */
export function toSvg(qr, opts = {}) {
  return QR.toSvg(qr, opts);
}

/* One-step text → SVG string; the site exposes exactly this as its
   window.QRCodeSVG global. opts additionally takes level ('M' default). */
export function qrSvg(text, opts = {}) {
  return QR.toSvg(QR.encode(text, opts.level || 'M'), opts);
}

/* UUID v4 generation + inspection. Core logic of the UUID Generator tab
   on subnsub.com, kept in lockstep with the in-page version.

   Sixteen bytes from crypto.getRandomValues (a CSPRNG — Math.random is
   never involved), then the two structural stamps of RFC 4122: version
   nibble 0100 into byte 6, variant bits 10 into byte 8. 122 random bits
   remain. getRandomValues rather than crypto.randomUUID because it is
   the same generator without randomUUID's secure-context gate.

   inspect checks the canonical hyphenated shape (either case), version
   digit 1–5 and RFC variant nibble [89ab] — the same test the tab runs
   on pasted UUIDs. It validates form, not provenance: a well-shaped
   UUID says nothing about how random its source was. */

/* Generate one v4 UUID in canonical lowercase form. */
export function genUuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b).map(x => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

/* Inspect a pasted UUID. Returns { valid: false } or
   { valid: true, version } with version 1–5 (1 time-based, 2 DCE
   security, 3 MD5 name-based, 4 random, 5 SHA-1 name-based). */
export function inspectUuid(u) {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-([1-5])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const m = String(u).trim().match(uuidRe);
  if (!m) return { valid: false };
  return { valid: true, version: Number(m[1]) };
}

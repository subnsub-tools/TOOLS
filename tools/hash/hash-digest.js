/* Multi-algorithm digest. Core logic of the Hash tool on subnsub.com,
   kept in lockstep with the in-page version.

   Everything goes through WebCrypto's crypto.subtle.digest — there is no
   hand-rolled hash code, so correctness rides on the platform, not on us.
   The tool computes SHA-1, SHA-256 and SHA-512 side by side over the same
   bytes; SHA-1 is there for checksum interop with older ecosystems, not as
   a security recommendation.

   Strings are hashed as their UTF-8 encoding. Whole-buffer operation: the
   on-site version hashes dropped files the same way (file.arrayBuffer()
   first), so inputs must fit in memory.

   Requires a secure context (HTTPS or localhost): crypto.subtle is
   undefined elsewhere. */

/* Algorithm list mirrors the on-site result rows, in display order. The
   second element names the key in hashBytes()'s result object. */
const ALGOS = [['SHA-1', 'sha1'], ['SHA-256', 'sha256'], ['SHA-512', 'sha512']];

export const ALGORITHMS = ALGOS.map(([name]) => name);

/* Digest text or raw bytes with every algorithm at once.
     bytes  string | Uint8Array — strings are UTF-8 encoded first
   Resolves to { sha1, sha256, sha512 }, each a lowercase hex string.
   The three digests run concurrently; the input buffer is shared, which
   is safe because digest() never mutates it. */
export async function hashBytes(bytes) {
  const enc = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  const out = {};
  await Promise.all(ALGOS.map(async ([algo, key]) => {
    const buf = await crypto.subtle.digest(algo, enc);
    out[key] = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }));
  return out;
}

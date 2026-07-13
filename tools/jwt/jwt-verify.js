/* JWT decode + local signature verification — core logic of the JWT
   Decoder & Verifier tab on subnsub.com, kept in lockstep with the
   in-page version.

   Decoding is plain base64url + JSON on the first two segments of a
   compact JWS — no crypto involved, so it works on any token. Verification
   runs on WebCrypto and covers the JWA families it implements natively:
   HS256/384/512 (HMAC secret), RS256/384/512 (RSASSA-PKCS1-v1_5),
   PS256/384/512 (RSA-PSS), ES256/384/512 (ECDSA on P-256/P-384/P-521,
   SPKI "BEGIN PUBLIC KEY" PEM input for the RSA/EC families).

   The algorithm is always taken from the token's OWN decoded header —
   jwtVerify() decodes the token itself and never trusts an
   externally-supplied header, so it can never be talked into verifying
   with an algorithm other than the one the token embeds. "alg" is matched
   case-sensitively against the exact JWA identifiers (RFC 7518): a
   lowercase "hs256" is Unsupported, not HS256. Segments are decoded with
   the strict compact-JWS base64url alphabet (A–Z a–z 0–9 - _, no padding,
   no whitespace, no standard +/).

   alg="none" is treated as well-formed but *unsigned* — surfaced as its
   own indeterminate state so it can never be confused with a verified
   signature; a "none" header with a non-empty signature segment is flagged
   as malformed outright.

   Verify results are {ok, label, detail}: ok===true verified, ok===false
   failed (with the reason in detail), ok===null indeterminate (unsigned
   token, or no key supplied yet). Secrets and public keys stay in the
   caller's memory — nothing leaves the device. WebCrypto requires a secure
   context (HTTPS or localhost).

   Note: this verifies the signature against whatever key material the
   caller supplies, interpreted per the token's own alg. For an interactive
   inspector that is the intended contract (the human sees the alg). A
   server that keeps an asymmetric public key should still pin the expected
   algorithm before trusting a token, so a "none"/HS token can't be replayed
   against an RSA/EC key. */

const B64URL_RE=/^[A-Za-z0-9_-]*$/;

/* Strict compact-JWS base64url -> bytes. Rejects padding, standard +/,
   whitespace and any other character outside the URL-safe alphabet. */
function b64urlBytes(seg){
  if(typeof seg!=='string'||!B64URL_RE.test(seg)) throw new Error('segment is not valid base64url');
  const rem=seg.length%4;
  if(rem===1) throw new Error('segment is not valid base64url');
  let s=seg.replace(/-/g,'+').replace(/_/g,'/');
  if(rem) s+='='.repeat(4-rem);
  const bin=atob(s); const u=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
  return u;
}
/* Strict base64url segment -> parsed JSON (UTF-8). */
function b64urlJson(seg){
  return JSON.parse(new TextDecoder('utf-8').decode(b64urlBytes(seg)));
}
function pemToBytes(pem){
  const cleaned=pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----/g,'').replace(/\s+/g,'');
  if(!cleaned) throw new Error('empty key');
  const bin=atob(cleaned); const u=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
  return u.buffer;
}

/* Split and decode a compact JWS. Throws when the token is not three
   dot-separated parts, a segment is not strict base64url / valid JSON, or
   the header does not decode to a JSON object (a JOSE header must be an
   object — this keeps callers from dereferencing .alg on null/array/scalar).
   The signature segment is returned verbatim (it may be '' for alg="none"
   tokens). */
export function decodeJwt(token){
  const v=String(token==null?'':token).trim();
  const parts=v.split('.');
  if(parts.length!==3) throw new Error('Not a valid JWT — expected 3 dot-separated parts');
  const header=b64urlJson(parts[0]);
  if(header===null||typeof header!=='object'||Array.isArray(header)) throw new Error('JWT header is not a JSON object');
  const payload=b64urlJson(parts[1]);
  return { header, payload, signature: parts[2] };
}

/* Parse the JWT alg header into a kind we can dispatch on. "alg" is
   case-sensitive (RFC 7515 §4.1.1 / RFC 7518): only the exact registered
   spellings match. Returns null when the header has no alg field. */
export function jwtAlgInfo(alg){
  if(!alg||typeof alg!=='string') return null;
  if(alg==='none') return {kind:'none', alg:'none'};
  const m=alg.match(/^(HS|RS|PS|ES)(256|384|512)$/);
  if(!m) return {kind:'unsupported', alg};
  return {kind:m[1].toLowerCase(), bits:m[2], alg};
}

/* Returns {ok, label, detail}. ok===null means "indeterminate"
   (unsigned token, or waiting for the caller to supply a key).

   The algorithm is read from the token's OWN header — jwtVerify decodes
   the token internally and takes no external header, so the signature is
   always checked with the algorithm the token actually embeds.

   keyText is the raw HMAC secret for the HS family, or a PEM SPKI
   public key for the RS / PS / ES families. */
export async function jwtVerify(token, keyText=''){
  let decoded;
  try{ decoded=decodeJwt(token); }
  catch(e){ return {ok:false, label:'Bad', detail:(e&&e.message)||'Malformed token — could not decode.'}; }
  const header=decoded.header;
  const info=jwtAlgInfo(header.alg);
  if(!info) return {ok:false, label:'No alg', detail:'Header is missing the "alg" field — cannot verify.'};
  if(info.kind==='unsupported') return {ok:false, label:'Unsupported', detail:'Algorithm {alg} is not implemented by Web Crypto for JWT verification.'.replace('{alg}',info.alg)};
  const parts=String(token).trim().split('.');
  const data=new TextEncoder().encode(parts[0]+'.'+parts[1]);
  if(info.kind==='none'){
    // alg="none" is well-formed JWT syntax but explicitly disclaims any
    // cryptographic guarantee. Surface that as a warning state so it can
    // never be confused with a successfully verified signature.
    return decoded.signature
      ? {ok:false, label:'Bad', detail:'Header claims alg="none" but the token still has a signature segment.'}
      : {ok:null, kind:'unsigned', label:'Unsigned', detail:'Token uses alg="none" with no signature — well-formed but not cryptographically authenticated. Treat the payload as untrusted input.'};
  }
  if(!keyText.trim()){
    const detail=info.kind==='hs'?'Paste the HMAC secret above to verify.':info.kind==='es'?'Paste the EC public key above to verify.':'Paste the RSA public key above to verify.';
    return {ok:null, label:'Awaiting key', detail};
  }
  let sigBytes;
  try{ sigBytes=b64urlBytes(decoded.signature); }
  catch(e){ return {ok:false, label:'Bad signature', detail:'Could not base64url-decode the signature segment.'}; }
  try{
    if(info.kind==='hs'){
      const k=await crypto.subtle.importKey('raw', new TextEncoder().encode(keyText),
        {name:'HMAC', hash:'SHA-'+info.bits}, false, ['verify']);
      const ok=await crypto.subtle.verify('HMAC', k, sigBytes, data);
      return ok
        ? {ok:true,  label:'Valid', detail:'HMAC-SHA{bits} matches with the provided secret.'.replace('{bits}',info.bits)}
        : {ok:false, label:'Invalid', detail:'HMAC mismatch — wrong secret or tampered token.'};
    }
    if(info.kind==='rs' || info.kind==='ps'){
      const keyData=pemToBytes(keyText);
      const algName=info.kind==='ps'?'RSA-PSS':'RSASSA-PKCS1-v1_5';
      const k=await crypto.subtle.importKey('spki', keyData,
        {name:algName, hash:'SHA-'+info.bits}, false, ['verify']);
      const params=info.kind==='ps'
        ? {name:'RSA-PSS', saltLength: parseInt(info.bits)/8}
        : 'RSASSA-PKCS1-v1_5';
      const ok=await crypto.subtle.verify(params, k, sigBytes, data);
      return ok
        ? {ok:true,  label:'Valid', detail:'{alg} with SHA-{bits} verified against the public key.'.replace('{alg}',algName).replace('{bits}',info.bits)}
        : {ok:false, label:'Invalid', detail:'Signature did not match — wrong public key or tampered token.'};
    }
    if(info.kind==='es'){
      // RFC 7518 §3.4: ES256/384 use P-256/384, ES512 uses curve P-521 (not 512).
      const curveMap={'256':'P-256','384':'P-384','512':'P-521'};
      const curve=curveMap[info.bits];
      const keyData=pemToBytes(keyText);
      const k=await crypto.subtle.importKey('spki', keyData,
        {name:'ECDSA', namedCurve:curve}, false, ['verify']);
      const ok=await crypto.subtle.verify({name:'ECDSA', hash:'SHA-'+info.bits}, k, sigBytes, data);
      return ok
        ? {ok:true,  label:'Valid', detail:'ECDSA on {curve} with SHA-{bits} verified.'.replace('{curve}',curve).replace('{bits}',info.bits)}
        : {ok:false, label:'Invalid', detail:'Signature did not match — wrong public key or tampered token.'};
    }
  }catch(e){
    return {ok:false, label:'Key error', detail:'Could not import key — {e}'.replace('{e}',(e.message||e))};
  }
}

/* TOTP / HOTP — core logic of the TOTP / HOTP Generator tab on
   subnsub.com, kept in lockstep with the in-page version.

   RFC 4226 HOTP with RFC 6238 time-based counters: the code is a dynamic
   truncation of HMAC(secret, 8-byte big-endian counter), where the counter
   is either an explicit HOTP counter or floor(unixTime / period). Secrets
   are Base32 (RFC 4648 alphabet; padding and whitespace tolerated);
   otpauth:// URIs are parsed and emitted per the Google Authenticator
   conventions. SHA-1 / SHA-256 / SHA-512 and 6 / 7 / 8 digits, matching
   what authenticator apps actually ship.

   The HMAC runs on WebCrypto, so a secure context (HTTPS or localhost) is
   required — crypto.subtle is undefined elsewhere. The secret never leaves
   the caller's memory: no network, no storage, nothing derived is kept. */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function b32dec(s){
  const c = s.replace(/=+$/,'').replace(/\s+/g,'').toUpperCase();
  if(!c) throw new Error('Empty secret');
  if(!/^[A-Z2-7]+$/.test(c)) throw new Error('Invalid Base32 characters');
  let bits='';
  for(const ch of c) bits += B32.indexOf(ch).toString(2).padStart(5,'0');
  const b=new Uint8Array(Math.floor(bits.length/8));
  for(let i=0;i<b.length;i++) b[i]=parseInt(bits.slice(i*8,i*8+8),2);
  return b;
}

export async function hmacSign(keyBytes, msgBytes, hashName){
  const k=await crypto.subtle.importKey('raw', keyBytes, {name:'HMAC', hash:hashName}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, msgBytes));
}

/* RFC 4226 dynamic-truncation HOTP. The counter is encoded big-endian
   into 8 bytes; for TOTP that counter is floor(unixTime / period). */
export async function genCode(secret, counter, hashName, digits){
  const key=b32dec(secret);
  const msg=new Uint8Array(8);
  const dv=new DataView(msg.buffer);
  dv.setUint32(0, Math.floor(counter / 2**32));
  dv.setUint32(4, counter >>> 0);
  const h=await hmacSign(key, msg, hashName);
  const off=h[h.length-1] & 0x0f;
  const bin=((h[off]&0x7f)<<24)|((h[off+1]&0xff)<<16)|((h[off+2]&0xff)<<8)|(h[off+3]&0xff);
  return (bin % (10 ** digits)).toString().padStart(digits,'0');
}

/* otpauth:// URI parser per Google Authenticator / RFC 6238 conventions.
   Returns null when the URI does not look like one. */
export function parseOtpAuth(uri){
  const m=uri.trim().match(/^otpauth:\/\/(totp|hotp)\/([^?]*)\??(.*)$/i);
  if(!m) return null;
  const params={};
  if(m[3]) m[3].split('&').forEach(kv=>{
    const eq=kv.indexOf('=');
    if(eq<0) return;
    const k=kv.slice(0,eq).toLowerCase();
    const v=kv.slice(eq+1);
    try{ params[k]=decodeURIComponent(v.replace(/\+/g,'%20')); } catch{ params[k]=v; }
  });
  let label=''; try{ label=decodeURIComponent(m[2]); }catch{ label=m[2]; }
  return {
    type: m[1].toLowerCase(),
    label,
    secret: (params.secret||'').replace(/\s+/g,''),
    issuer: params.issuer||'',
    algorithm: (params.algorithm||'SHA1').toUpperCase(),
    digits: parseInt(params.digits)||6,
    period: parseInt(params.period)||30,
    counter: parseInt(params.counter)||0
  };
}

/* otpauth URIs spell algorithms without the dash ("SHA256"); WebCrypto
   wants "SHA-256". Anything unrecognised falls back to SHA-1, like the
   authenticator apps do. */
export function algoNorm(a){ const n=String(a||'').toUpperCase().replace('-',''); return n==='SHA256'?'SHA-256':n==='SHA512'?'SHA-512':'SHA-1'; }
export function algoCompact(a){ return a.replace('-',''); }

/* The generator's input gate: collapse whitespace, drop trailing padding,
   upcase, then insist on at least 8 Base32 chars before any HMAC runs.
   Returns the cleaned secret, or '' when nothing was entered; throws the
   same two messages the panel shows for bad input. */
export function normalizeSecret(raw){
  const t=String(raw||'').trim();
  if(!t) return '';
  const c=t.replace(/\s+/g,'').replace(/=+$/,'').toUpperCase();
  if(!/^[A-Z2-7]+$/.test(c)||c.length<8){
    throw new Error(c.length<8 && /^[A-Z2-7]*$/.test(c)
      ? 'Need at least 8 Base32 chars'
      : 'Non-Base32 characters (A–Z, 2–7 only)');
  }
  return c;
}

/* Option gates — exactly the values the in-page switches accept; anything
   else falls back to the same defaults the panel uses. */
export function normalizeConfig(cfg){
  const c=cfg||{};
  return {
    mode: c.mode==='hotp' ? 'hotp' : 'totp',
    algorithm: c.algorithm==='SHA-256'||c.algorithm==='SHA-512' ? c.algorithm : 'SHA-1',
    digits: [6,7,8].includes(+c.digits) ? +c.digits : 6,
    period: +c.period===60 ? 60 : 30,
    counter: Math.max(0, Math.floor(+c.counter||0)),
  };
}

/* TOTP time window: which counter step nowMs falls in, and how much of the
   step is left (fractional seconds — this drives the countdown bar). */
export function totpWindow(period, nowMs=Date.now()){
  const now=nowMs/1000;
  const counter=Math.floor(now/period);
  return { counter, remaining: period-(now-counter*period) };
}

/* One generator tick: current / previous / next codes for the active time
   window (TOTP) or the fixed counter (HOTP). previous is '' at counter 0 —
   there is no step -1. remaining is null in HOTP mode. */
export async function otpCodes(secret, config, nowMs=Date.now()){
  const cfg=normalizeConfig(config);
  const c=normalizeSecret(secret);
  if(!c) throw new Error('Empty secret');
  let counter, rem=null;
  if(cfg.mode==='totp'){
    const w=totpWindow(cfg.period, nowMs);
    counter=w.counter; rem=w.remaining;
  } else {
    counter=cfg.counter;
  }
  const prevP=counter>0 ? genCode(c, counter-1, cfg.algorithm, cfg.digits) : Promise.resolve('');
  const [current, previous, next]=await Promise.all([
    genCode(c, counter, cfg.algorithm, cfg.digits),
    prevP,
    genCode(c, counter+1, cfg.algorithm, cfg.digits)
  ]);
  return { current, previous, next, counter, remaining: rem };
}

/* Build an otpauth:// URI from generator state — this feeds the "Show as
   QR" action. Returns null until the secret passes the input gate. issuer
   and account are inserted verbatim (the site uses fixed URI-safe labels),
   so keep them URI-safe. */
export function buildOtpAuth(state){
  const st=normalizeConfig(state);
  const c=String((state&&state.secret)||'').trim().replace(/\s+/g,'').replace(/=+$/,'').toUpperCase();
  if(!c||!/^[A-Z2-7]+$/.test(c)||c.length<8) return null;
  const issuer=(state&&state.issuer)||'DevTools';
  const account=(state&&state.account)||'user';
  const params=[
    'secret='+c,
    'algorithm='+algoCompact(st.algorithm),
    'digits='+st.digits
  ];
  if(st.mode==='totp') params.push('period='+st.period);
  else params.push('counter='+st.counter);
  params.push('issuer='+issuer);
  return `otpauth://${st.mode}/${issuer}:${account}?${params.join('&')}`;
}

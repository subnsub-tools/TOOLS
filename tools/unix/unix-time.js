/* Unix timestamp ↔ date conversion. Logic of the Unix Timestamp
   tab on [subnsub.com](https://subnsub.com), kept in lockstep with the
   in-page version.

   One field, one answer: `unixParse` takes whatever names a moment —
   epoch seconds, epoch milliseconds, an ISO 8601 string, or a common
   regional date form — works out which one it is, and returns epoch
   milliseconds. `unixFormatUtc8` renders those milliseconds as a
   UTC+8 wall clock, and `unixRelative` as "in 3 hours" / "2 days ago".

   Milliseconds are the internal unit throughout (JavaScript's own), so
   nothing here juggles ×1000 on the caller's behalf.

   UTC+8 is deliberate and fixed. Reading a zoneless date in the
   viewer's own zone would make the same input mean different instants
   on different machines, which is exactly what you do not want when
   two people are comparing one timestamp; a date that carries an
   explicit offset keeps its own and is converted for display.

   Pure computation: no DOM, no network, no storage. */

const UNIX_UTC8_MS=8*60*60*1000;

function unixPad(n,w=2){ return String(n).padStart(w,'0'); }

/* Epoch milliseconds → 'YYYY-MM-DD HH:MM:SS' on the UTC+8 wall clock.
   Returns null for anything that is not a finite number (the tab only
   ever feeds it a parsed value, but a bare import can hand it
   anything). */
export function unixFormatUtc8(ms){
  if(!Number.isFinite(ms)) return null;
  const d=new Date(ms+UNIX_UTC8_MS);
  return `${unixPad(d.getUTCFullYear(),4)}-${unixPad(d.getUTCMonth()+1)}-${unixPad(d.getUTCDate())} ${unixPad(d.getUTCHours())}:${unixPad(d.getUTCMinutes())}:${unixPad(d.getUTCSeconds())}`;
}

/* Epoch milliseconds → relative phrasing against now, via
   Intl.RelativeTimeFormat with the largest unit that fits (second under
   a minute, then minute, hour, day). `locale` is optional; engines
   without Intl.RelativeTimeFormat fall back to a plain English form.
   Returns null for a non-finite input. */
export function unixRelative(ms,locale){
  if(!Number.isFinite(ms)) return null;
  const diff=(ms-Date.now())/1000, abs=Math.abs(diff);
  let unit='second', size=1;
  if(abs>=86400){ unit='day'; size=86400; }
  else if(abs>=3600){ unit='hour'; size=3600; }
  else if(abs>=60){ unit='minute'; size=60; }
  const value=Math.round(diff/size);
  try{
    return new Intl.RelativeTimeFormat(locale||undefined,{numeric:'auto'}).format(value,unit);
  }catch(_){ return value<0?`${Math.abs(value)} ${unit}${Math.abs(value)===1?'':'s'} ago`:`in ${value} ${unit}${value===1?'':'s'}`; }
}

/* [year, month, day, hour, minute, second, millis] read as UTC+8 →
   epoch milliseconds, or null when those numbers are not a real instant.
   The round-trip check is what rejects 2026-02-30 instead of letting it
   roll into March, and it also catches an out-of-range month or hour. */
export function unixDateFromParts(parts){
  const [year,month,day,hour=0,minute=0,second=0,millis=0]=parts.map(Number);
  const ms=Date.UTC(year,month-1,day,hour,minute,second,millis)-UNIX_UTC8_MS;
  if(!Number.isFinite(ms)||Math.abs(ms)>8640000000000000)return null;
  const check=new Date(ms+UNIX_UTC8_MS);
  return check.getUTCFullYear()===year&&check.getUTCMonth()+1===month&&check.getUTCDate()===day&&
    check.getUTCHours()===hour&&check.getUTCMinutes()===minute&&check.getUTCSeconds()===second&&check.getUTCMilliseconds()===millis ? ms : null;
}

/* The deterministic date grammars, tried before anything else:
   'YYYY-MM-DD', 'YYYY/MM/DD' and 'YYYY.MM.DD' with an optional time,
   the Chinese 'YYYY年M月D日' form, and an unpunctuated 'YYYYMMDD' /
   'YYYYMMDDHHMMSS' run.

   Three-state on purpose: epoch ms when it parsed, null when the string
   matched a grammar but names an impossible date (so the caller reports
   an error instead of handing it to Date.parse, which would silently
   roll 2026-02-30 into March), and undefined for "not one of these
   grammars, keep looking". */
function unixParseCommonDate(value){
  let m=value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?(?:\.(\d{1,3}))?)?$/);
  if(!m)m=value.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?(?:\s*(\d{1,2})(?:[:时](\d{1,2}))?(?:[:分](\d{1,2}))?秒?)?$/);
  if(!m){
    const compact=value.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/);
    /* An unpunctuated digit run is ambiguous: 20260608 reads as a date, but
       12345678 is a perfectly good epoch second and 10000000000000 a good
       millisecond value. Only claim the string when those digits really do
       spell a calendar date — otherwise report "not this grammar" so the
       numeric branch in unixParse picks it up. Forms WITH separators still
       fall through to the null below (matched, but impossible), which is
       what keeps Date.parse from rolling 2026-02-30 into March. */
    if(compact&&Number(compact[1])>=1000){
      const ms=unixDateFromParts([compact[1],compact[2],compact[3],compact[4]||0,compact[5]||0,compact[6]||0,0]);
      return ms===null?undefined:ms;
    }
  }
  if(!m)return undefined;
  const fraction=m[7]?Number(m[7].padEnd(3,'0')):0;
  return unixDateFromParts([m[1],m[2],m[3],m[4]||0,m[5]||0,m[6]||0,fraction]);
}

/* Anything that names a moment → epoch milliseconds, or null when the
   input cannot be read as one.

   Order of attack: the deterministic date grammars above, then a bare
   number (epoch seconds up to 11 digits, milliseconds beyond — the
   threshold sits far past any plausible second-precision date, and
   fractional seconds are kept), then Date.parse for the rest.

   The tab hands this a trimmed string; a bare import may not, so the
   value is coerced and trimmed here. */
export function unixParse(value){
  value=String(value==null?'':value).trim();
  const common=unixParseCommonDate(value);
  if(common!==undefined)return common;
  if(/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)){
    const n=Number(value);
    if(!Number.isFinite(n))return null;
    const ms=Math.trunc(Math.abs(n)>=1e11?n:n*1000);
    return Math.abs(ms)<=8640000000000000&&Number.isFinite(new Date(ms).getTime())?ms:null;
  }
  /* Explicit offsets win. Other Date.parse-compatible strings are read in
     UTC+8 as well, so a pasted English date doesn't silently depend on the
     computer's local zone. The structured parser above owns the common,
     deterministic numeric forms. */
  if(!/\d/.test(value))return null;
  const prefixed=value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?(?:\.(\d{1,3}))?)?/);
  if(prefixed){
    const fraction=prefixed[7]?Number(prefixed[7].padEnd(3,'0')):0;
    if(unixDateFromParts([prefixed[1],prefixed[2],prefixed[3],prefixed[4]||0,prefixed[5]||0,prefixed[6]||0,fraction])===null)return null;
  }
  const explicit=/(?:Z|[+-]\d{2}:?\d{2}|\b(?:UTC|GMT))\s*$/i.test(value);
  const parsed=Date.parse(explicit?value:value+' GMT+0800');
  return Number.isFinite(parsed)?parsed:null;
}

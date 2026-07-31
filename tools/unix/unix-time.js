/* Unix timestamp ↔ date conversion. Logic of the Unix Timestamp
   tab on [subnsub.com](https://subnsub.com), kept in lockstep with the
   in-page version.

   One field, one answer: `unixParse` takes whatever names a moment —
   epoch seconds, epoch milliseconds, an ISO 8601 string, or a common
   regional date form — works out which one it is, and returns epoch
   milliseconds. `unixFormatZone` renders those milliseconds on a chosen
   zone's wall clock, and `unixRelative` as "in 3 hours" / "2 days ago".

   Milliseconds are the internal unit throughout (JavaScript's own), so
   nothing here juggles ×1000 on the caller's behalf.

   Every function that touches a wall clock takes a `zone`:
     ''            a FIXED +08:00 offset — the tab's default. Deliberately
                   not 'Asia/Shanghai': that zone observed daylight saving
                   in the summers of 1986-1991, and a control that says
                   UTC+8 ought to mean UTC+8.
     'local'       whatever the running device resolves to, DST included.
     an IANA name  'UTC', 'America/New_York', … handed to Intl.
   An epoch number means the same instant in every zone; the zone decides
   how a zoneless date is READ and how a result is SHOWN. A string that
   carries its own offset (Z, +02:00, GMT) always keeps it.

   Pure computation: no DOM, no network, no storage. */

const UNIX_UTC8_MS=8*60*60*1000;
const unixTzFmt=new Map();
function unixZoneFormatter(zone){
  let f=unixTzFmt.get(zone);
  if(!f){
    f=new Intl.DateTimeFormat('en-US',{timeZone:zone,hour12:false,era:'short',
      year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
    unixTzFmt.set(zone,f);
  }
  return f;
}
/* `ms` shifted so that reading it back with the getUTC* accessors yields
   the wall clock of `zone`: format into the zone, read the fields back as
   if they were UTC. The standard trick, and the only one that needs no
   offset table of our own. */
function unixZoneShift(ms,zone){
  if(!zone) return ms+UNIX_UTC8_MS;
  if(zone==='local') return ms-new Date(ms).getTimezoneOffset()*60000;
  const p={};
  for(const part of unixZoneFormatter(zone).formatToParts(ms)){ if(part.type!=='literal') p[part.type]=part.value; }
  let y=Number(p.year);
  if(p.era&&/^B/.test(p.era)) y=1-y;                  /* 1 BC is year 0 */
  /* Placeholder year, then stamped: Date.UTC folds 0-99 onto 1900-1999.
     Intl carries no milliseconds, and they are zone-independent anyway,
     so they come off the input. */
  const d=new Date(Date.UTC(2000,Number(p.month)-1,Number(p.day),Number(p.hour)%24,Number(p.minute),Number(p.second),0));
  d.setUTCFullYear(y);
  return d.getTime()+(((ms%1000)+1000)%1000);
}
function unixPad(n,w=2){ return String(n).padStart(w,'0'); }
export function unixFormatZone(ms,zone){
  if(!Number.isFinite(ms)) return null;
  const d=new Date(unixZoneShift(ms,zone));
  return `${unixPad(d.getUTCFullYear(),4)}-${unixPad(d.getUTCMonth()+1)}-${unixPad(d.getUTCDate())} ${unixPad(d.getUTCHours())}:${unixPad(d.getUTCMinutes())}:${unixPad(d.getUTCSeconds())}`;
}
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
/* Wall-clock fields in `zone` → epoch ms, or null when they name no real
   instant: an impossible date (2026-02-30) or an hour a DST spring-forward
   skips. Two passes converge because the offset is constant either side of
   a transition, and the round-trip check is what rejects the rest. */
export function unixDateFromParts(parts,zone){
  const [year,month,day,hour=0,minute=0,second=0,millis=0]=parts.map(Number);
  const wall=Date.UTC(year,month-1,day,hour,minute,second,millis);
  if(!Number.isFinite(wall))return null;
  let ms;
  if(!zone) ms=wall-UNIX_UTC8_MS;
  else {
    ms=wall-(unixZoneShift(wall,zone)-wall);
    ms=wall-(unixZoneShift(ms,zone)-ms);
  }
  if(!Number.isFinite(ms)||Math.abs(ms)>8640000000000000)return null;
  const check=new Date(unixZoneShift(ms,zone));
  return check.getUTCFullYear()===year&&check.getUTCMonth()+1===month&&check.getUTCDate()===day&&
    check.getUTCHours()===hour&&check.getUTCMinutes()===minute&&check.getUTCSeconds()===second&&check.getUTCMilliseconds()===millis ? ms : null;
}
function unixParseCommonDate(value,zone){
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
      const ms=unixDateFromParts([compact[1],compact[2],compact[3],compact[4]||0,compact[5]||0,compact[6]||0,0],zone);
      return ms===null?undefined:ms;
    }
  }
  /* undefined means “not this grammar”; null means it matched but the date
     is impossible. Keeping those distinct prevents Date.parse from silently
     rolling 2026-02-30 into March below. */
  if(!m)return undefined;
  const fraction=m[7]?Number(m[7].padEnd(3,'0')):0;
  return unixDateFromParts([m[1],m[2],m[3],m[4]||0,m[5]||0,m[6]||0,fraction],zone);
}
export function unixParse(value,zone){
  value=String(value==null?'':value).trim();
  const common=unixParseCommonDate(value,zone);
  if(common!==undefined)return common;
  if(/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)){
    const n=Number(value);
    if(!Number.isFinite(n))return null;
    const ms=Math.trunc(Math.abs(n)>=1e11?n:n*1000);
    return Math.abs(ms)<=8640000000000000&&Number.isFinite(new Date(ms).getTime())?ms:null;
  }
  /* Explicit offsets win. Everything else is read in the chosen zone, so
     a pasted English date doesn't silently depend on the computer's own
     zone unless that is what you picked. The structured parser above owns
     the common, deterministic numeric forms. */
  if(!/\d/.test(value))return null;
  const prefixed=value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?(?:\.(\d{1,3}))?)?/);
  if(prefixed){
    const fraction=prefixed[7]?Number(prefixed[7].padEnd(3,'0')):0;
    if(unixDateFromParts([prefixed[1],prefixed[2],prefixed[3],prefixed[4]||0,prefixed[5]||0,prefixed[6]||0,fraction],zone)===null)return null;
  }
  const explicit=/(?:Z|[+-]\d{2}:?\d{2}|\b(?:UTC|GMT))\s*$/i.test(value);
  if(explicit){ const parsed=Date.parse(value); return Number.isFinite(parsed)?parsed:null; }
  /* No offset in the string: read those wall-clock fields in the chosen
     zone. Parsing as UTC first gives the fields as an epoch value, which
     is exactly what unixDateFromParts wants back. */
  const wall=Date.parse(value+' GMT+0000');
  if(!Number.isFinite(wall))return null;
  const w=new Date(wall);
  return unixDateFromParts([w.getUTCFullYear(),w.getUTCMonth()+1,w.getUTCDate(),
    w.getUTCHours(),w.getUTCMinutes(),w.getUTCSeconds(),w.getUTCMilliseconds()],zone);
}

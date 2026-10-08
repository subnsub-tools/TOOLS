/* Unix timestamp ↔ date conversion. Logic of the Unix Timestamp
   tab on [subnsub.com](https://subnsub.com), kept in lockstep with the
   in-page version.

   One field, one answer: `unixParse` takes whatever names a moment —
   epoch seconds, epoch milliseconds, an ISO 8601 string, or a common
   regional date form — works out which one it is, and returns epoch
   milliseconds. `unixFormatZone` renders those milliseconds on a zone's
   wall clock, and `unixRelative` as "in 3 hours" / "2 days ago".

   Milliseconds are the internal unit throughout (JavaScript's own), so
   nothing here juggles ×1000 on the caller's behalf.

   Every function that touches a wall clock takes a `zone`: '' means the
   running device's own zone (DST included) and is the tab's default,
   anything else is an IANA name handed to Intl. An epoch number means
   the same instant in every zone — the zone only decides how a zoneless
   date is READ and how a result is SHOWN. A string that carries its own
   offset (Z, +02:00, GMT) always keeps it.

   `unixZoneOk` is exported for callers that take a zone from anywhere
   untrusted (stored preference, query string, user input): Intl throws a
   RangeError on a name its tz data does not know, and every function here
   would carry that up to the caller.

   Pure computation: no DOM, no network, no storage. */

export function unixZoneOk(z){
  if(!z) return true;
  try{ new Intl.DateTimeFormat('en',{timeZone:z}); return true; }catch(_){ return false; }
}
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
   the wall clock of `zone` ('' = this device, DST included). For a named
   zone: format into it, then read the fields back as if they were UTC —
   the standard trick, and the only one that needs no offset table of our
   own. */
function unixZoneShift(ms,zone){
  if(!zone) return ms-new Date(ms).getTimezoneOffset()*60000;
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
  /* ±8.64e15 is a legal instant, but shifting it into a zone can push it out
     of the Date range — formatting that would print 0NaN-0NaN. */
  const shifted=unixZoneShift(ms,zone);
  if(!Number.isFinite(shifted)) return null;
  const d=new Date(shifted);
  if(!Number.isFinite(d.getTime())) return null;
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
  /* Placeholder year, then stamped — Date.UTC folds 0-99 onto 1900-1999, and
     the round-trip below would then reject every year under 100. */
  const wallD=new Date(Date.UTC(2000,month-1,day,hour,minute,second,millis));
  wallD.setUTCFullYear(year);
  const wall=wallD.getTime();
  if(!Number.isFinite(wall))return null;
  let ms=wall-(unixZoneShift(wall,zone)-wall);
  ms=wall-(unixZoneShift(ms,zone)-ms);
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
  const explicit=/(?:Z|[+-]\d{2}:?\d{2}|\b(?:UTC|GMT))\s*$/i.test(value);
  const prefixed=value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?(?:\.(\d{1,3}))?)?/);
  if(prefixed){
    const fraction=prefixed[7]?Number(prefixed[7].padEnd(3,'0')):0;
    /* The calendar part has to name a real day, or Date.parse below rolls
       2026-02-30 into March. A value carrying its own offset is checked
       zone-free: its wall clock belongs to that offset, not to the zone the
       result gets shown in — otherwise a perfectly good 02:30-05:00 would be
       rejected for landing in the display zone's spring-forward gap. */
    if(unixDateFromParts([prefixed[1],prefixed[2],prefixed[3],prefixed[4]||0,prefixed[5]||0,prefixed[6]||0,fraction],explicit?'UTC':zone)===null)return null;
  }
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

/* ── One instant, every other way (2026-10-09) ──
   Under the conversion: the same instant in the zones the reader keeps (UTC,
   this device, the World Clock's cities), in the formats other systems store
   time in, where it sits in its calendar, and the round numbers the epoch
   counter is heading for. Lockstep with the tab (index.html / unix.html). */
export function unixOffsetMin(ms,zone){ return Math.round((unixZoneShift(ms,zone)-ms)/60000); }
export function unixOffsetStr(min){ const a=Math.abs(min); return 'UTC'+(min<0?'−':'+')+unixPad(Math.floor(a/60))+':'+unixPad(a%60); }
/* GPS time ignores the leap seconds UTC has inserted since 1980-01-06:
   the count at each insertion, newest first */
const UNIX_LEAPS=[[Date.UTC(2017,0,1),18],[Date.UTC(2015,6,1),17],[Date.UTC(2012,6,1),16],[Date.UTC(2009,0,1),15],[Date.UTC(2006,0,1),14],
  [Date.UTC(1999,0,1),13],[Date.UTC(1997,6,1),12],[Date.UTC(1996,0,1),11],[Date.UTC(1994,6,1),10],[Date.UTC(1993,6,1),9],[Date.UTC(1992,6,1),8],
  [Date.UTC(1991,0,1),7],[Date.UTC(1990,0,1),6],[Date.UTC(1988,0,1),5],[Date.UTC(1985,6,1),4],[Date.UTC(1983,6,1),3],[Date.UTC(1982,6,1),2],[Date.UTC(1981,6,1),1]];
const UNIX_RFC_DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], UNIX_RFC_MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/* [key, English label, value or null] — null when the format cannot hold
   the instant (FILETIME before 1601, Excel before 1900, GPS before 1980…) */
export function unixFormats(ms,zone){
  const off=unixOffsetMin(ms,zone), w=new Date(unixZoneShift(ms,zone)), y=w.getUTCFullYear();
  const isoOff=off?(off<0?'-':'+')+unixPad(Math.floor(Math.abs(off)/60))+':'+unixPad(Math.abs(off)%60):'Z';
  const yy=y<0||y>9999?(y<0?'-':'+')+unixPad(Math.abs(y),6):unixPad(y,4);
  const wall=yy+'-'+unixPad(w.getUTCMonth()+1)+'-'+unixPad(w.getUTCDate())+'T'+unixPad(w.getUTCHours())+':'+unixPad(w.getUTCMinutes())+':'+unixPad(w.getUTCSeconds());
  const frac=(((ms%1000)+1000)%1000), B=BigInt(ms), sec=Math.floor(ms/1000);
  let gps=null;
  if(ms>=315964800000){ const lp=UNIX_LEAPS.find(l=>ms>=l[0]); gps=String(Math.floor((ms-315964800000)/1000)+(lp?lp[1]:0)); }
  /* Excel's 1900 system counts a 29 February 1900 that never was: from
     1 March 1900 its serials run one ahead of the days elapsed, before it
     they do not (1 January 1900 is 1, and there is no day 0) */
  const xl=unixZoneShift(ms,zone), excel=(xl-Date.UTC(1899,11,30))/86400000-(xl<Date.UTC(1900,2,1)?1:0);
  return [
    ['iso','ISO 8601',wall+(frac?'.'+unixPad(frac,3):'')+isoOff],
    ['rfc2822','RFC 2822',y>=0&&y<=9999?UNIX_RFC_DAYS[w.getUTCDay()]+', '+unixPad(w.getUTCDate())+' '+UNIX_RFC_MONTHS[w.getUTCMonth()]+' '+unixPad(y,4)+' '+unixPad(w.getUTCHours())+':'+unixPad(w.getUTCMinutes())+':'+unixPad(w.getUTCSeconds())+' '+(off<0?'-':'+')+unixPad(Math.floor(Math.abs(off)/60))+unixPad(Math.abs(off)%60):null],
    ['utc','RFC 3339, UTC',(()=>{ try{ return new Date(ms).toISOString(); }catch(_){ return null; } })()],
    ['us','Unix microseconds',(B*1000n).toString()],
    ['ns','Unix nanoseconds',(B*1000000n).toString()],
    ['filetime','Windows FILETIME',ms>=-11644473600000?((B+11644473600000n)*10000n).toString():null],
    ['ticks','.NET ticks',ms>=-62135596800000?((B+62135596800000n)*10000n).toString():null],
    ['excel','Excel serial date',excel>=1?String(Math.round(excel*1e6)/1e6):null],
    ['ntp','NTP seconds',ms>=-2208988800000?String(sec+2208988800):null],
    ['gps','GPS seconds',gps],
    ['jd','Julian Day',String(Math.round((ms/86400000+2440587.5)*1e6)/1e6)],
    ['cocoa','Apple Cocoa',String((ms-978307200000)/1000)],
    ['webkit','WebKit / Chrome',ms>=-11644473600000?((B+11644473600000n)*1000n).toString():null],
    ['hex','Hex seconds',(sec<0?'-0x':'0x')+Math.abs(sec).toString(16)]
  ];
}
/* where the instant sits in the zone's calendar, and the zone's clock */
export function unixIsoWeek(y,m,d){
  const t=new Date(0); t.setUTCFullYear(y,m,d);
  const th=t.getTime()+(3-(t.getUTCDay()+6)%7)*86400000, ty=new Date(th).getUTCFullYear(), j=new Date(0);
  j.setUTCFullYear(ty,0,1);
  return { year:ty, week:1+Math.floor((th-j.getTime())/(7*86400000)) };
}
export function unixDateInfo(ms,zone){
  const w=new Date(unixZoneShift(ms,zone)), y=w.getUTCFullYear(), m=w.getUTCMonth(), d=w.getUTCDate();
  const j=new Date(0); j.setUTCFullYear(y,0,1);
  const t0=new Date(0); t0.setUTCFullYear(y,m,d);
  const doy=Math.round((t0.getTime()-j.getTime())/86400000)+1;
  const days=(y%4===0&&y%100!==0)||y%400===0?366:365;
  /* Clock changes, read off the offset every two days from half a year
     back to a year ahead — no January/July shortcut: Morocco changes around
     Ramadan with the same offset at both. Daylight saving is in effect when
     the offset stands above the lowest within half a year either side; the
     next switch is bisected on whole minutes, where switches fall. */
  const DAY=86400000, cur=unixOffsetMin(ms,zone);
  let low=cur, varies=false, next=null, a=ms, prev=cur;
  for(let k=-91;k<=183;k++){
    const t=ms+k*2*DAY;
    if(Math.abs(t)>8.64e15) continue;
    const o=unixOffsetMin(t,zone);
    if(o!==cur) varies=true;
    if(k<=91&&o<low) low=o;
    if(k>0&&!next){
      if(o!==prev){
        let lo=Math.floor(a/60000), hi=Math.ceil(t/60000);
        while(hi-lo>1){ const mid=Math.floor((lo+hi)/2); if(unixOffsetMin(mid*60000,zone)===prev) lo=mid; else hi=mid; }
        next={ ms:hi*60000, delta:unixOffsetMin(hi*60000,zone)-prev };
      }
      a=t; prev=o;
    }
  }
  const dst=varies?cur>low:null;
  return { weekday:w.getUTCDay(), iso:unixIsoWeek(y,m,d), doy, days, quarter:Math.floor(m/3)+1, dst, next };
}
/* the next three hundred-million marks after `nowMs`, then the 32-bit limits */
export function unixMilestones(nowMs){
  const s=Math.floor(nowMs/1000), out=[], step=100000000;
  for(let v=(Math.floor(s/step)+1)*step;out.length<3;v+=step) out.push({ sec:v, kind:'round' });
  if(2147483647>s) out.push({ sec:2147483647, kind:'i32' });
  if(4294967295>s) out.push({ sec:4294967295, kind:'u32' });
  return out.sort((x,y)=>x.sec-y.sec);
}

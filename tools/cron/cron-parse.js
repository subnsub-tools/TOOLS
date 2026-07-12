/* Cron expression parser — core logic of the Cron Expression tab on
   subnsub.com, kept in lockstep with the in-page version.

   Classic 5-field cron: minute hour day-of-month month day-of-week.
   Each field takes lists, ranges, steps and * — "1-5", "0,30", "9-17/2",
   and "*" combined with "/15" for an every-15 step. Day-of-week runs 0-6
   with 7 accepted as Sunday, and wrap-around ranges like "5-1" expand
   across the week boundary.

   Day matching follows POSIX/Vixie semantics: when BOTH day-of-month and
   day-of-week are restricted, a date matches if EITHER does; when only
   one is restricted, that one decides.

   Next-run times are computed by walking the local-time calendar minute
   by minute (with day/hour skips when a coarser field already rules a
   stretch out), so DST transitions behave exactly like the wall clock
   does. A safety bound of one year of minutes stops impossible schedules
   ("0 0 31 2 *") from looping forever — they simply return fewer (or
   zero) results.

   No seconds field, no @hourly-style macros, no L/W/# extensions, and no
   month/day names ("JAN", "MON") — numbers only, matching the site's
   input surface. Pure computation: no DOM, no network, no storage. */

const CRON_MONTHS=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CRON_DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

/* Expand one field into a sorted list of matching values within
   [min, max]. wrapAt enables wrap-around ranges (7 for day-of-week, so
   "5-1" → Fri…Mon and a literal 7 folds onto Sunday). Malformed parts
   contribute nothing rather than throwing. */
export function cronExpand(field,min,max,wrapAt){
  const results=new Set();
  for(const part of field.split(',')){
    const stepM=part.match(/^(.+)\/(\d+)$/);
    let range=stepM?stepM[1]:part;
    const step=stepM?parseInt(stepM[2]):1;
    if(step<=0) continue;
    if(range==='*')range=`${min}-${max}`;
    const rangeM=range.match(/^(\d+)-(\d+)$/);
    if(rangeM){
      let lo=parseInt(rangeM[1]),hi=parseInt(rangeM[2]);
      if(lo>hi&&wrapAt!=null){for(let i=lo;i<=wrapAt;i+=step)results.add(i%wrapAt);for(let i=min;i<=hi;i+=step)results.add(i);}
      else for(let i=lo;i<=hi;i+=step)results.add(wrapAt!=null?i%wrapAt:i);
    }else{
      let v=parseInt(range);
      if(wrapAt!=null&&v>=wrapAt) v=v%wrapAt;
      results.add(v);
    }
  }
  return [...results].filter(n=>n>=min&&n<=max).sort((a,b)=>a-b);
}

/* Render the expression as an English sentence ("Every 15 minutes, on
   Mon, Tue, in Jan"). Returns null when it is not 5 fields. */
export function cronDescribe(expr){
  const p=expr.trim().split(/\s+/);
  if(p.length!==5)return null;
  const [mn,hr,dom,mon,dow]=p;
  let parts=[];
  if(mn==='*'&&hr==='*')parts.push('every minute');
  else if(mn.includes('/')&&hr==='*')parts.push('every {n} minutes'.replace('{n}',mn.split('/')[1]));
  else if(hr.includes('/')&&mn==='0')parts.push('every {n} hours'.replace('{n}',hr.split('/')[1]));
  else if(mn!=='*'&&hr!=='*'){
    const hrs=cronExpand(hr,0,23),mns=cronExpand(mn,0,59);
    if(hrs.length<=3&&mns.length<=3){
      const times=[];
      for(const h of hrs)for(const m of mns)times.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
      parts.push('at {times}'.replace('{times}',times.join(', ')));
    }else{
      parts.push('minute {m} of hour {h}'.replace('{m}',mn).replace('{h}',hr));
    }
  }else if(mn!=='*'){parts.push('at minute {m}'.replace('{m}',mn));}
  else{parts.push('every minute of hour {h}'.replace('{h}',hr));}

  if(dom!=='*'&&dow==='*')parts.push('on day {d} of the month'.replace('{d}',dom));
  else if(dow!=='*'&&dom==='*'){
    const days=cronExpand(dow,0,6,7).map(d=>CRON_DAYS[d]||d);
    parts.push('on {days}'.replace('{days}',days.join(', ')));
  }else if(dom!=='*'&&dow!=='*'){
    parts.push('on day {dom} and {days}'.replace('{dom}',dom).replace('{days}',cronExpand(dow,0,6,7).map(d=>CRON_DAYS[d]).join(', ')));
  }
  if(mon!=='*'){
    const months=cronExpand(mon,1,12).map(m=>CRON_MONTHS[m]||m);
    parts.push('in {months}'.replace('{months}',months.join(', ')));
  }
  return parts.join(', ').replace(/^./, c=>c.toUpperCase());
}

/* The next `count` fire times after `from` (exclusive of the current
   minute), as local-time Dates. Returns [] for a malformed expression and
   fewer than `count` entries when the safety bound (one year of minutes)
   runs out first. */
export function cronNext(expr,count=10,from=new Date()){
  const p=expr.trim().split(/\s+/);
  if(p.length!==5)return[];
  const mns=cronExpand(p[0],0,59),hrs=cronExpand(p[1],0,23);
  const doms=p[2]==='*'?null:cronExpand(p[2],1,31);
  const mons=p[3]==='*'?null:cronExpand(p[3],1,12);
  const dows=p[4]==='*'?null:cronExpand(p[4],0,6,7);
  const results=[];
  const now=from;
  const d=new Date(now.getFullYear(),now.getMonth(),now.getDate(),now.getHours(),now.getMinutes()+1,0,0);
  let safety=525960;
  while(results.length<count&&safety-->0){
    if(mons&&!mons.includes(d.getMonth()+1)){d.setMinutes(0);d.setHours(0);d.setDate(d.getDate()+1);continue;}
    const domOk=!doms||doms.includes(d.getDate());
    const dowOk=!dows||dows.includes(d.getDay());
    const dayOk=p[2]==='*'&&p[4]!=='*'?dowOk:p[4]==='*'&&p[2]!=='*'?domOk:p[2]!=='*'&&p[4]!=='*'?(domOk||dowOk):(domOk&&dowOk);
    if(!dayOk){d.setMinutes(0);d.setHours(0);d.setDate(d.getDate()+1);continue;}
    if(!hrs.includes(d.getHours())){d.setMinutes(0);d.setHours(d.getHours()+1);continue;}
    if(!mns.includes(d.getMinutes())){d.setMinutes(d.getMinutes()+1);continue;}
    results.push(new Date(d));
    d.setMinutes(d.getMinutes()+1);
  }
  return results;
}

/* Compact "in 5m" / "in 3h" relative label for a fire time. */
export function cronRelative(date, now=Date.now()){
  const diff=(date-now)/1000;
  if(diff<60)return 'in {t}'.replace('{t}',Math.round(diff)+'s');
  if(diff<3600)return 'in {t}'.replace('{t}',Math.round(diff/60)+'m');
  if(diff<86400)return 'in {t}'.replace('{t}',Math.round(diff/3600)+'h');
  return 'in {t}'.replace('{t}',Math.round(diff/86400)+'d');
}

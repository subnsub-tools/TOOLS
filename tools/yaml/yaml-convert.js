/* YAML ↔ JSON — core logic of the YAML ↔ JSON tab on subnsub.com, kept in
   lockstep with the in-page version.

   A deliberately small, hand-rolled YAML subset — the shape of config
   files, not the full spec:

     - block mappings and sequences, nested by indentation
     - "- " list items, including inline "key: value" starts
     - literal (|) and folded (>) block scalars
     - single/double-quoted scalars with the usual escapes
     - plain-scalar typing: true/false/null/~, integers (kept as numbers
       only within the IEEE-754 safe range), decimals, scientific
       notation, 0x… hex, 0o… octal
     - inline [flow] and {flow} values, tried as JSON first
     - top-level scalar documents (a bare/quoted scalar, flow collection
       or block scalar as the whole document)

   Not supported (silently treated as plain text or ignored): anchors and
   aliases, tags, multi-document streams, complex keys, trailing same-line
   comments. Duplicate keys resolve last-one-wins. Parsing never throws on
   odd indentation — unrecognised lines are skipped, which matches the
   tool's paste-something-see-something behaviour.

   The emitter mirrors the parser: it quotes strings that would otherwise
   re-parse as another type (leading digit / true / null …) or that contain
   YAML syntax characters, emits multi-line strings as literal blocks, and
   round-trips through the parser for the constructs above. Everything is
   synchronous, pure computation — no DOM, no network. */

const YAML={
  parse(s){
    const lines=s.split('\n');
    const root={};
    const stack=[{indent:-1,node:root}];
    let i=0,first=true;
    function top(){return stack[stack.length-1];}
    function resolve(ctx){return ctx.key!=null?(ctx.node[ctx.key]===null||ctx.node[ctx.key]===undefined?(ctx.node[ctx.key]={}):ctx.node[ctx.key]):ctx.node;}
    while(i<lines.length){
      const raw=lines[i], trimmed=raw.replace(/\s+$/,'');
      i++;
      if(!trimmed||/^\s*#/.test(trimmed)) continue;
      const indent=trimmed.search(/\S/);
      const content=trimmed.slice(indent);
      if(first){
        first=false;
        /* Top-level scalar documents: the emitter may produce a bare
           scalar, a quoted scalar, a flow collection or a block scalar as
           the whole document — recognise those shapes when nothing else
           follows, instead of returning {}. */
        if(content==='|'||content==='>'){
          const r=YAML._block(lines,i,content);
          if(lines.slice(r[1]).every(l=>!l.trim()||/^\s*#/.test(l))) return r[0];
        } else if(!/^- /.test(content)&&content!=='-'&&lines.slice(i).every(l=>!l.trim()||/^\s*#/.test(l))){
          const flow=(content[0]==='['&&content.endsWith(']'))||(content[0]==='{'&&content.endsWith('}'));
          const quoted=/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')$/.test(content);
          if(flow||quoted||!/^[^:]+:/.test(content)) return YAML._val(content);
        }
      }
      while(stack.length>1&&indent<=top().indent) stack.pop();

      if(/^- /.test(content)||content==='-'){
        const ctx=top();
        if(ctx.key!=null&&!Array.isArray(ctx.node[ctx.key])) ctx.node[ctx.key]=[];
        let arr=ctx.key!=null?ctx.node[ctx.key]:ctx.node;
        if(!Array.isArray(arr)){arr=[];if(ctx.key!=null)ctx.node[ctx.key]=arr;else stack[stack.length-1].node=arr;}
        const item=content==='-'?'':content.slice(2).trim();
        if(!item){
          const child={};arr.push(child);
          stack.push({indent:indent+1,node:child});
        } else if((item[0]==='['&&item.endsWith(']'))||(item[0]==='{'&&item.endsWith('}'))||/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')$/.test(item)){
          arr.push(YAML._val(item));
        } else {
          const p=YAML._pair(item,true);
          if(p){
            const child={};arr.push(child);
            const k2=p[0],v2=p[1];
            if(v2) child[k2]=YAML._val(v2);
            else child[k2]=null;
            /* Two contexts: the item mapping itself (keys sit at column
               indent+2, so indent+1 survives siblings but a same-column
               "- " pops it), and — for a valueless inline key — the key's
               value container at the key's own column, so a sibling key
               at indent+2 pops back to the item instead of nesting. */
            stack.push({indent:indent+1,node:child});
            if(!v2) stack.push({indent:indent+2,node:child,key:k2});
          } else {
            arr.push(YAML._val(item));
          }
        }
        continue;
      }

      const m=YAML._pair(content,false);
      if(m){
        const k=m[0], v=m[1];
        const target=resolve(top());
        if(v){
          if(v==='|'||v==='>'){
            const r=YAML._block(lines,i,v);
            target[k]=r[0];i=r[1];
          } else {
            target[k]=YAML._val(v);
          }
        } else {
          target[k]=null;
          stack.push({indent:indent,node:target,key:k});
        }
      }
    }
    return stack[0].node;
  },
  _val(s){
    if(s==='true'||s==='True'||s==='TRUE') return true;
    if(s==='false'||s==='False'||s==='FALSE') return false;
    if(s==='null'||s==='Null'||s==='NULL'||s==='~') return null;
    if(/^-?\d+$/.test(s)){const n=Number(s);if(n>=-9007199254740991&&n<=9007199254740991)return n;}
    if(/^-?\d+\.\d+$/.test(s))return parseFloat(s);
    if(/^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(s))return Number(s);
    if(/^0x[\da-fA-F]+$/.test(s))return parseInt(s,16);
    if(/^0o[0-7]+$/.test(s))return parseInt(s.slice(2),8);
    if(s.length>1&&((s[0]==='"'&&s.endsWith('"'))||(s[0]==="'"&&s.endsWith("'"))))return YAML._unquote(s);
    if(s.startsWith('[')&&s.endsWith(']')){
      try{return JSON.parse(s);}catch{}
      return s.slice(1,-1).split(',').map(x=>YAML._val(x.trim()));
    }
    if(s.startsWith('{')&&s.endsWith('}')){
      try{return JSON.parse(s);}catch{}
    }
    return s;
  },
  /* Split "key: value" line content into [key, value]. Quoted keys are
     matched first so colons inside the quotes don't split the line. In
     strict mode (sequence items) a bare key requires ": " or line-end
     after the colon — the historical item test; mapping lines stay
     lenient (first colon splits). Returns null when not a pair. */
  _pair(s,strict){
    let m=s.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:\s*(.*)$/);
    if(m) return [YAML._unquote(m[1]),m[2].trim()];
    if(strict&&!/^[^:]+:\s/.test(s)&&!/^[^:]+:$/.test(s)) return null;
    m=s.match(/^([^:]+?):\s*(.*)$/);
    return m?[YAML._unquote(m[1].trim()),m[2].trim()]:null;
  },
  /* Strip one layer of matching quotes; single-pass unescape so "\\n"
     stays a literal backslash-n (the old chained .replace() corrupted
     it), with full JSON escapes so JSON.stringify output reads back. */
  _unquote(s){
    if(s.length>1&&s[0]==='"'&&s.endsWith('"'))
      return s.slice(1,-1).replace(/\\(?:u([\da-fA-F]{4})|(.))/g,(x,u,c)=>u!==undefined?String.fromCharCode(parseInt(u,16)):({n:'\n',t:'\t',r:'\r',b:'\b',f:'\f'}[c]||c));
    if(s.length>1&&s[0]==="'"&&s.endsWith("'"))
      return s.slice(1,-1).replace(/''/g,"'");
    return s;
  },
  /* Read a literal (|) / folded (>) block starting at lines[i]; returns
     [text, next line index]. */
  _block(lines,i,style){
    let block='',nextIndent=-1;
    while(i<lines.length){
      const bl=lines[i];
      if(!bl.trim()){block+='\n';i++;continue;}
      const bi=bl.search(/\S/);
      if(nextIndent<0) nextIndent=bi;
      if(bi<nextIndent) break;
      block+=(block&&style==='|'?'\n':block?' ':'')+bl.slice(nextIndent).trimEnd();
      i++;
    }
    return [block,i];
  },
  stringify(obj,indent=2,level=0){
    const pad=' '.repeat(indent*level);
    if(obj===null||obj===undefined) return pad+'null';
    if(typeof obj==='boolean') return pad+(obj?'true':'false');
    if(typeof obj==='number') return pad+String(obj);
    if(typeof obj==='string'){
      if(!obj) return pad+"''";
      if(/[\n\r]/.test(obj)){
        /* Block scalars only re-parse faithfully when no line carries
           leading/trailing whitespace the parser would eat; otherwise
           fall back to a JSON-quoted single line. */
        if(/^\s|\r/.test(obj)||obj.split('\n').some(l=>l!==l.trimEnd()))
          return pad+JSON.stringify(obj);
        return pad+'|\n'+obj.split('\n').map(l=>' '.repeat(indent*(level+1))+l).join('\n');
      }
      /* Quote whenever the parser would read the bare text back as
         anything other than this exact string (numbers incl. negative /
         scientific, booleans in any case, null, quote-stripping, flow),
         plus the historical syntax-character set and edge whitespace. */
      if(YAML._val(obj)!==obj||/^(true|false|null|~|\d)/.test(obj)||/[:#\[\]{}&*!|>',@`"]/.test(obj)||obj.includes(': ')||obj.endsWith(':')||/^\s|\s$/.test(obj))
        return pad+JSON.stringify(obj);
      return pad+obj;
    }
    if(Array.isArray(obj)){
      if(!obj.length) return pad+'[]';
      return obj.map(item=>{
        if(Array.isArray(item)) return pad+'- '+JSON.stringify(item);
        if(item&&typeof item==='object'){
          /* Re-pad continuation lines so item keys align in the column
             right after "- " (mapping keys must share a column to
             re-parse); with indent=2 this is an identity transform. */
          const base=' '.repeat(indent*(level+1));
          const inner=YAML.stringify(item,indent,level+1).split('\n')
            .map((l,idx)=>idx?pad+'  '+l.slice(base.length):l.trimStart()).join('\n');
          return pad+'- '+inner;
        }
        if(typeof item==='string'&&/[\n\r]/.test(item)) return pad+'- '+JSON.stringify(item);
        const v=YAML.stringify(item,indent,0).trim();
        return pad+'- '+v;
      }).join('\n');
    }
    if(typeof obj==='object'){
      const keys=Object.keys(obj);
      if(!keys.length) return pad+'{}';
      return keys.map(k=>{
        const v=obj[k];
        const safeK=(!k||/[:#\[\]{}&*!|>',@`"\s]/.test(k))?JSON.stringify(k):k;
        if(v&&typeof v==='object'){
          /* Empty containers inline — an indented bare "[]"/"{}" line is
             not something the block parser reads back. */
          const empty=Array.isArray(v)?!v.length:!Object.keys(v).length;
          if(empty) return pad+safeK+': '+(Array.isArray(v)?'[]':'{}');
          return pad+safeK+':\n'+YAML.stringify(v,indent,level+1);
        }
        return pad+safeK+': '+YAML.stringify(v,indent,0).trim();
      }).join('\n');
    }
    return pad+String(obj);
  }
};

/* YAML text → plain JS value (objects / arrays / scalars). */
export function parseYaml(s){ return YAML.parse(s); }

/* JS value → YAML text. indent = spaces per nesting level. */
export function stringifyYaml(obj, indent=2){ return YAML.stringify(obj, indent); }

/* The tool's two conversion directions. indent applies to the output side
   (the site offers 2 or 4). Both throw on unparseable JSON input; YAML
   parsing itself is non-throwing by design. */
export function yamlToJson(text, indent=2){ return JSON.stringify(YAML.parse(text), null, indent); }
export function jsonToYaml(text, indent=2){ return YAML.stringify(JSON.parse(text), indent); }

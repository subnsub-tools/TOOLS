/* YAML ↔ JSON — core logic of the YAML ↔ JSON tab on subnsub.com, kept in
   lockstep with the in-page version.

   A deliberately small, hand-rolled YAML subset — the shape of config
   files, not the full spec:

     - block mappings and sequences, nested by indentation
     - "- " list items, including inline "key: value" starts
     - literal (|) and folded (>) block scalars
     - single/double-quoted scalars with the usual escapes
     - plain-scalar typing: true/false/null/~, integers (kept as numbers
       only within the IEEE-754 safe range), decimals, 0x… hex, 0o… octal
     - inline [flow] and {flow} values, tried as JSON first

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
    let i=0;
    function top(){return stack[stack.length-1];}
    function resolve(ctx){return ctx.key!=null?(ctx.node[ctx.key]===null||ctx.node[ctx.key]===undefined?(ctx.node[ctx.key]={}):ctx.node[ctx.key]):ctx.node;}
    while(i<lines.length){
      const raw=lines[i], trimmed=raw.replace(/\s+$/,'');
      i++;
      if(!trimmed||/^\s*#/.test(trimmed)) continue;
      const indent=trimmed.search(/\S/);
      const content=trimmed.slice(indent);
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
        } else if(/^[^:]+:\s/.test(item)||/^[^:]+:$/.test(item)){
          const child={};arr.push(child);
          const m2=item.match(/^([^:]+?):\s*(.*)/);
          if(m2){
            const k2=m2[1].trim(),v2=m2[2].trim();
            if(v2) child[k2]=YAML._val(v2);
            else child[k2]=null;
            stack.push({indent:indent+1,node:child,key:v2?undefined:k2});
          } else stack.push({indent:indent+1,node:child});
        } else {
          arr.push(YAML._val(item));
        }
        continue;
      }

      const m=content.match(/^([^:]+?):\s*(.*)/);
      if(m){
        const k=m[1].trim(), v=m[2].trim();
        const target=resolve(top());
        if(v){
          if(v==='|'||v==='>'){
            let block='',nextIndent=-1;
            while(i<lines.length){
              const bl=lines[i];
              if(!bl.trim()){block+='\n';i++;continue;}
              const bi=bl.search(/\S/);
              if(nextIndent<0) nextIndent=bi;
              if(bi<nextIndent) break;
              block+=(block&&v==='|'?'\n':block?' ':'')+bl.slice(nextIndent).trimEnd();
              i++;
            }
            target[k]=block;
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
    if(/^0x[\da-fA-F]+$/.test(s))return parseInt(s,16);
    if(/^0o[0-7]+$/.test(s))return parseInt(s.slice(2),8);
    if(s.startsWith('"')&&s.endsWith('"'))return s.slice(1,-1).replace(/\\n/g,'\n').replace(/\\t/g,'\t').replace(/\\"/g,'"').replace(/\\\\/g,'\\');
    if(s.startsWith("'")&&s.endsWith("'"))return s.slice(1,-1).replace(/''/g,"'");
    if(s.startsWith('[')&&s.endsWith(']')){
      try{return JSON.parse(s);}catch{}
      return s.slice(1,-1).split(',').map(x=>YAML._val(x.trim()));
    }
    if(s.startsWith('{')&&s.endsWith('}')){
      try{return JSON.parse(s);}catch{}
    }
    return s;
  },
  stringify(obj,indent=2,level=0){
    const pad=' '.repeat(indent*level);
    if(obj===null||obj===undefined) return pad+'null';
    if(typeof obj==='boolean') return pad+(obj?'true':'false');
    if(typeof obj==='number') return pad+String(obj);
    if(typeof obj==='string'){
      if(!obj) return pad+"''";
      if(/[\n\r]/.test(obj)) return pad+'|\n'+obj.split('\n').map(l=>' '.repeat(indent*(level+1))+l).join('\n');
      if(/^(true|false|null|~|\d)/.test(obj)||/[:#\[\]{}&*!|>',@`]/.test(obj)||obj.includes(': ')||obj.endsWith(':'))
        return pad+JSON.stringify(obj);
      return pad+obj;
    }
    if(Array.isArray(obj)){
      if(!obj.length) return pad+'[]';
      return obj.map(item=>{
        if(item&&typeof item==='object'){
          const inner=YAML.stringify(item,indent,level+1).trimStart();
          return pad+'- '+inner;
        }
        const v=YAML.stringify(item,indent,0).trim();
        return pad+'- '+v;
      }).join('\n');
    }
    if(typeof obj==='object'){
      const keys=Object.keys(obj);
      if(!keys.length) return pad+'{}';
      return keys.map(k=>{
        const v=obj[k];
        const safeK=/[:#\[\]{}&*!|>',@`\s]/.test(k)?JSON.stringify(k):k;
        if(v&&typeof v==='object'){
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

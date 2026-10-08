/* WebRTC IP exposure probe. Logic of the My IP tab on subnsub.com,
   kept in lockstep with the in-page version.

   A throwaway RTCPeerConnection with one data channel is offered and its
   ICE candidates are read back: every distinct address the browser is
   willing to put on the wire is collected and split into local (private,
   link-local, CGNAT, loopback, ULA) and public. Comparing the public
   candidates against the address websites actually see for you yields
   the leak verdict — the classic failure is a VPN/proxy user whose ICE
   candidates disclose the real egress address the tunnel was supposed to
   hide.

   The same gather also reads NAT mapping behaviour. The main connection
   carries TWO STUN servers on purpose: mapping behaviour is the question
   "when the same local socket talks to two different destinations, does
   it come back wearing the same public endpoint?", and that is only
   answerable if both binding requests leave the SAME socket. A second
   RTCPeerConnection would answer nothing — its candidates have a
   different base by construction, and their public ports differ whatever
   the NAT does. Two small single-server connections run beside the main
   one purely to prove that each server actually replied; see
   assessNatMapping() for why that proof is load-bearing.

   The probe sends no user data anywhere. With the default ICE config the
   only packets leaving the machine are STUN binding requests — that is
   how a browser learns its server-reflexive address, and without them
   there are no public candidates to check. Each STUN server sees the
   source address of the request it got, nothing more. Pass
   { iceServers: [] } for a fully local probe: host candidates only, zero
   network traffic, and no NAT reading.

   Requires a browser: RTCPeerConnection has no server-side equivalent.
   Environments without it (or with WebRTC disabled) resolve to empty
   results with supported:false, which the verdict reports as
   'unavailable'. */

/* STUN servers, same two as the in-page probe. The main leg talks to
   both; the alternate is what makes the mapping comparison possible.
   Overridable per call. */
export const STUN_MAIN = 'stun:stun.l.google.com:19302';
export const STUN_ALT = 'stun:stun.cloudflare.com:3478';
export const DEFAULT_ICE_SERVERS = [{ urls: STUN_MAIN }, { urls: STUN_ALT }];

/* Gathering is hard-bounded: a blackholed STUN route, or a browser that
   never fires the end-of-candidates event, must still settle the probe. */
export const GATHER_TIMEOUT_MS = 6000;

var RE_V4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
var RE_V4_PRIV = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.)/;

/* Bucket one candidate address the way the exposure verdict needs.
   IPv4 'local' covers RFC 1918 (10/8, 172.16/12, 192.168/16),
   link-local (169.254/16), CGNAT (100.64/10) and 0/8; IPv6 'local'
   covers loopback (::1), link-local (fe80::/10) and ULA (fc00::/7).
   Anything else that parses as an address is 'pub'. Candidate fields
   that are not addresses at all — the mDNS *.local hostnames browsers
   emit when host-candidate anonymisation is on — return null and get
   skipped: an mDNS name exposes nothing by design. */
export function classifyCandidateAddress(addr){
  if(RE_V4.test(addr)){
    if(RE_V4_PRIV.test(addr))
      return 'local';
    return 'pub';
  }
  if(addr.indexOf(':')>=0){
    var lo=addr.toLowerCase();
    if(lo==='::1'||/^fe[89ab]/i.test(lo)||/^f[cd]/i.test(lo))
      return 'local';
    return 'pub';
  }
  return null;
}

function isPublicV4(addr){
  return RE_V4.test(addr) && !RE_V4_PRIV.test(addr);
}

/* Parse one candidate-attribute string:
     "candidate:<foundation> <component> <transport> <priority>
      <connection-address> <port> typ <type> [raddr <a> rport <p>] …"
   Field order after the first five is not fixed by the grammar, so the
   keywords are scanned for instead of indexed at a constant. raddr AND
   rport are both kept: a base is a full transport address, and two
   interfaces that happen to pick the same local port would otherwise
   collapse into one. Returns null for anything shorter than six fields;
   otherwise { proto, addr, port, typ, raddr, rport } with proto
   lower-cased, numbers parsed (0 when absent) and typ '' when absent. */
export function parseCandidate(str){
  var p=String(str||'').split(/\s+/);
  if(p.length<6) return null;
  var c={proto:(p[2]||'').toLowerCase(),addr:p[4],port:parseInt(p[5],10)||0,
         typ:'',raddr:'',rport:0};
  for(var i=6;i<p.length-1;i++){
    if(p[i]==='typ'&&!c.typ) c.typ=p[i+1];
    else if(p[i]==='raddr') c.raddr=p[i+1];
    else if(p[i]==='rport') c.rport=parseInt(p[i+1],10)||0;
  }
  return c;
}

/* Gather every address WebRTC is willing to disclose, and the raw
   material for the NAT mapping reading.
     options.iceServers  RTCConfiguration servers for the main leg
                         (default: STUN_MAIN + STUN_ALT; pass [] for a
                         fully local probe). The first two entries also
                         each get a single-server confirmation leg.
     options.timeoutMs   hard settle bound in ms (default 6000)
   Resolves to
     { local, pub       string[] — deduplicated, in candidate order; the
                        exact shape the leak verdict is scored off
       srflx4           public IPv4 server-reflexive candidates from the
                        MAIN leg only: { proto, addr, port, raddr, rport }
       hosts4           distinct non-IPv6 host candidates on the main leg
                        (mDNS names count — their family is unreadable,
                        and the count is what bounds the ambiguity check)
       okMain, okAlt    the first / second server answered its own
                        single-server leg over public IPv4
       anySrflx         any leg, any family, produced a reflexive
                        candidate — the only positive proof UDP got out
       supported        RTCPeerConnection exists }
   Always resolves, never rejects: a missing RTCPeerConnection, a
   constructor throw, a failed offer and a timeout all settle with
   whatever was gathered so far. */
export function detectWebRTCAddresses(options){
  var opts = options || {};
  var iceServers = opts.iceServers !== undefined ? opts.iceServers : DEFAULT_ICE_SERVERS;
  var timeoutMs = opts.timeoutMs || GATHER_TIMEOUT_MS;
  return new Promise(function(resolve){
    var RTC = typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null;
    /* local/pub keep their exact shape and meaning from before the NAT
       reading existed: assessExposure() reports the leak from them.
       anySrflx is kept across ALL legs and both families — the main leg
       alone timing out must not be reported as a blocked network. */
    var ips={local:[],pub:[],srflx4:[],hosts4:0,okMain:false,okAlt:false,
             anySrflx:false,supported:!!RTC};
    /* Leg count is fixed up front, as the in-page probe does it: a main
       leg that throws synchronously must not hit zero and settle before
       the confirmation legs below have even been started. */
    var legs=1+(iceServers.length>0?1:0)+(iceServers.length>1?1:0);
    var done=false,pending=legs,pcs=[];
    var seenHost={};

    function shut(pc){ if(pc)try{pc.close();}catch(x){} }
    function fin(){ if(done)return; done=true; pcs.forEach(shut); resolve(ips); }
    setTimeout(fin,timeoutMs);
    if(!RTC){ fin(); return; }

    function classify(c){
      var addr=c.addr;
      if(c.typ==='host'){
        /* Chrome swaps host addresses for an mDNS alias unless the page
           holds a media permission, so the literal is usually a .local
           name and its family is unreadable. Only count what is provably
           NOT IPv6, so an IPv6-only interface cannot inflate the IPv4
           ambiguity check. */
        if(!seenHost[addr]&&addr.indexOf(':')<0){ seenHost[addr]=1; ips.hosts4++; }
      }
      if(c.typ==='srflx'){
        ips.anySrflx=true;
        if(isPublicV4(addr))
          ips.srflx4.push({proto:c.proto,addr:addr,port:c.port,raddr:c.raddr,rport:c.rport});
      }
      if(ips.local.indexOf(addr)>=0||ips.pub.indexOf(addr)>=0) return;
      var scope=classifyCandidateAddress(addr);
      if(scope) ips[scope].push(addr);
    }

    /* One guard per leg: a connection that both errors and completes
       must not decrement twice and end the gather while the others are
       still working. */
    function gather(servers,onCand){
      var pc=null,spent=false;
      function leg(){ if(spent)return; spent=true; if(--pending<=0) fin(); }
      try{
        pc=new RTC({iceServers:servers});
        /* A data channel is the cheapest thing that makes the offer
           gather candidates — no media, no permissions prompt. */
        pc.createDataChannel('');
        pc.createOffer().then(function(o){return pc.setLocalDescription(o);}).catch(leg);
        pc.onicecandidate=function(e){
          if(!e.candidate){ leg(); return; }   /* null candidate = gathering done */
          var c=parseCandidate(e.candidate.candidate);
          if(c) onCand(c);
        };
      }catch(e){ leg(); }
      pcs.push(pc);
    }

    gather(iceServers,classify);
    /* Two single-server probes, one per STUN. Their whole job is to
       establish that BOTH destinations answer over IPv4, because the
       main leg cannot say so itself: endpoint-independent mapping and
       one dead server produce the same single candidate. Confirming only
       the alternate leaves the mirror-image hole — first server down,
       second up also yields one mapping, and that would read as a clean
       cone NAT. Family matters too: an IPv6 srflx from one server proves
       nothing about the IPv4 mapping being compared, so both probes only
       count IPv4. Their candidates never touch ips.local/ips.pub — a
       separate socket's mapping is not a leak and must not be scored as
       one — but they DO set anySrflx, since any reply at all is proof UDP
       got out. With fewer than two servers configured the missing flag
       stays false and the mapping can never read 'independent'. */
    function probe(flag){
      return function(c){
        if(c.typ!=='srflx') return;
        ips.anySrflx=true;
        if(isPublicV4(c.addr)) ips[flag]=true;
      };
    }
    if(iceServers.length>0) gather([iceServers[0]],probe('okMain'));
    if(iceServers.length>1) gather([iceServers[1]],probe('okAlt'));
  });
}

/* The verdict printed over the gathered candidates, given the public
   address websites see for this connection (the site feeds the address
   its own edge observed; any what-is-my-IP witness works):
     'unavailable' — no RTCPeerConnection: nothing was probed
     'leak'        — a public candidate differs from publicIp: WebRTC is
                     disclosing an egress address the rest of the traffic
                     does not use (the classic VPN/proxy leak)
     'protected'   — no candidates at all: nothing exposed
     'no-leak'     — candidates exist, but no public address beyond the
                     one already visible
   Comparison is exact-string, matching the in-page check; without a
   publicIp to compare against nothing can count as leaked. A result
   without a supported flag (just { local, pub }) is taken as probed. */
export function assessExposure(ips, publicIp){
  if (ips.supported === false) return { status: 'unavailable', leaked: [] };
  var mainIp = publicIp || '';
  var leaked = mainIp ? ips.pub.filter(function(ip){ return ip !== mainIp; }) : [];
  if (leaked.length) return { status: 'leak', leaked: leaked };
  if (!ips.pub.length && !ips.local.length) return { status: 'protected', leaked: [] };
  return { status: 'no-leak', leaked: [] };
}

/* NAT mapping verdict from what the gather actually saw:
     'dependent'   one base wore two different mapped endpoints
     'independent' one mapped endpoint, with BOTH servers proven to answer
     'unsure'      anything we cannot separate; never dressed up as a pass

   Reading leans on ICE's own de-duplication (RFC 8445 §5.1.3: a
   candidate is redundant when its transport address AND base match
   another's). Endpoint-independent mapping therefore collapses both
   servers' replies into ONE srflx candidate; endpoint-dependent mapping
   keeps two, because the mapped endpoints differ. One candidate is only
   allowed to mean 'independent' once both servers are known to have
   replied — one dead server looks identical from here, and without that
   check every blocked-STUN network would read as a clean cone NAT.

   WHAT THIS CANNOT SAY. The verdict is only ever endpoint-INdependent or
   endpoint-DEPENDENT. Telling address-dependent from address-and-port-
   dependent needs RFC 5780's two-step probe (alternate address with the
   original port, then with the alternate port); our two servers differ
   in BOTH address and port, so a changed mapping only proves "not EIM"
   and the verdict must not name which flavour. Filtering behaviour — the
   classic full-cone / restricted / port-restricted split of RFC 3489 —
   needs the server to reply from a different IP and port (STUN's
   CHANGE-REQUEST), which WebRTC does not expose; it is not measured and
   not guessed at. Mapping behaviour is the honest half, and it is the
   half that predicts whether P2P will work.

   The UDP reading sits beside this, not inside it: ips.anySrflx true
   means a reflexive candidate came back from some leg, which is proof
   UDP got out. Its ABSENCE proves nothing — a host holding a public
   address makes its srflx redundant and ICE drops it, an IPv6-only path
   never produces an IPv4 one, and a browser policy or a sulking STUN
   server looks identical — so silence is reported as silence ("no STUN
   reply"), never promoted to "blocked". */
export function assessNatMapping(R){
  var S=R.srflx4||[];
  if(!S.length) return 'unsure';
  /* A base is a full transport address, so group on protocol + raddr +
     rport. Grouping on rport alone merged two interfaces that happened
     to pick the same local port and read them as one symmetric socket. */
  var haveBase=true,i;
  for(i=0;i<S.length;i++) if(!S[i].rport||!S[i].raddr||S[i].raddr==='0.0.0.0'){ haveBase=false; break; }
  var seen={},n=0,groups={},multi=false;
  for(i=0;i<S.length;i++){
    var ep=S[i].addr+':'+S[i].port;
    if(!seen[ep]){ seen[ep]=1; n++; }
    if(haveBase){
      var g=S[i].proto+'|'+S[i].raddr+'|'+S[i].rport;
      (groups[g]||(groups[g]={}))[ep]=1;
    }
  }
  if(haveBase){
    for(var k in groups) if(Object.keys(groups[k]).length>1) multi=true;
    if(multi) return 'dependent';
  } else if(n>1){
    /* No base to group on (mDNS masking leaves raddr/rport empty). Two
       mapped endpoints from one socket is symmetric; two sockets holding
       one each is an ordinary multi-homed machine. With the base masked
       those are indistinguishable, so only claim symmetric when there is
       provably one IPv4 interface to have come from. Note the endpoint is
       compared whole: a changed public ADDRESS is just as much "not
       endpoint-independent" as a changed port. */
    return R.hosts4<=1?'dependent':'unsure';
  }
  /* One mapped endpoint. That only means endpoint-independent if both
     destinations actually replied — otherwise nothing was compared. */
  return (R.okMain&&R.okAlt)?'independent':'unsure';
}

/* Curated AS numbers beat name-matching: the org string for AS16509 is
   "AMAZON-02", which /amazon/ happens to catch, but plenty of major clouds
   and hosters ("DIGITALOCEAN-ASN", "AS-CHOOPA", "M247") drift past any
   sane regex. Numbers are stable identifiers; the regex chain stays as the
   fallback for the long tail. */
var ASN_TYPE={
  16509:'Cloud',14618:'Cloud',8075:'Cloud',15169:'Cloud',396982:'Cloud',
  31898:'Cloud',45102:'Cloud',37963:'Cloud',45090:'Cloud',132203:'Cloud',
  13335:'Cloud',54113:'Cloud',20940:'Cloud',16625:'Cloud',36351:'Cloud',
  24940:'Hosting',16276:'Hosting',14061:'Hosting',63949:'Hosting',
  20473:'Hosting',51167:'Hosting',12876:'Hosting',197540:'Hosting',
  8560:'Hosting',26496:'Hosting',46606:'Hosting',9009:'Hosting',
  60068:'Hosting',212238:'Hosting'
};

/* Classify the kind of network an address belongs to from its AS number
   and organisation string (as BGP/WHOIS report them). Returns
   { type, c }: type is one of 'Hosting' | 'Cloud' | 'VPN / Proxy' |
   'Tor' | 'Education' | 'Government' | 'Mobile ISP' | 'ISP' | 'Unknown';
   c is the severity channel the site colours the badge with — 'r'
   (anonymisation infrastructure), 'y' (datacenter space, unusual for a
   human visitor), 'g' (ordinary eyeball network). */
export function classifyASN(org,asn){
  var t=asn&&ASN_TYPE[asn];
  if(t)return{type:t,c:'y'};
  if(!org)return{type:'Unknown',c:'y'};
  var o=org.toLowerCase();
  if(/hosting|hetzner|ovh|vultr|linode|digitalocean|data.?cent|rackspace|contabo|kamatera|scaleway/.test(o))return{type:'Hosting',c:'y'};
  if(/amazon|google|microsoft|azure|oracle|alibaba|tencent|ibm.cloud/.test(o))return{type:'Cloud',c:'y'};
  if(/vpn|proxy|tunnel|mullvad|nordvpn|expressvpn|surfshark|cyberghost|proton|private.internet|windscribe/.test(o))return{type:'VPN / Proxy',c:'r'};
  if(/tor\b|relay|exit.node/.test(o))return{type:'Tor',c:'r'};
  if(/universit|college|school|academ|research|\.edu/.test(o))return{type:'Education',c:'g'};
  if(/government|defense|military|federal|ministry/.test(o))return{type:'Government',c:'g'};
  if(/mobile|wireless|cellular|vodafone|t-mobile|sprint/.test(o))return{type:'Mobile ISP',c:'g'};
  return{type:'ISP',c:'g'};
}

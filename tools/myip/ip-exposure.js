/* WebRTC IP exposure probe. Core logic of the My IP tab on subnsub.com,
   kept in lockstep with the in-page version.

   A throwaway RTCPeerConnection with one data channel is offered and its
   ICE candidates are read back: every distinct address the browser is
   willing to put on the wire is collected and split into local (private,
   link-local, CGNAT, loopback, ULA) and public. Comparing the public
   candidates against the address websites actually see for you yields
   the leak verdict — the classic failure is a VPN/proxy user whose ICE
   candidates disclose the real egress address the tunnel was supposed to
   hide.

   The probe sends no user data anywhere. With the default ICE config the
   only packet leaving the machine is a STUN binding request — that is
   how a browser learns its server-reflexive address, and without it
   there are no public candidates to check. Pass { iceServers: [] } for a
   fully local probe: host candidates only, zero network traffic.

   Requires a browser: RTCPeerConnection has no server-side equivalent.
   Environments without it (or with WebRTC disabled) resolve to empty
   results, which the verdict honestly reports as 'protected'. */

/* Default STUN server, same as the in-page probe: a long-lived public
   binding service used only to elicit server-reflexive candidates.
   Overridable per call. */
export const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

/* Gathering is hard-bounded: a blackholed STUN route, or a browser that
   never fires the end-of-candidates event, must still settle the probe. */
export const GATHER_TIMEOUT_MS = 5000;

/* Bucket one candidate address the way the exposure verdict needs.
   IPv4 'local' covers RFC 1918 (10/8, 172.16/12, 192.168/16),
   link-local (169.254/16), CGNAT (100.64/10) and 0/8; IPv6 'local'
   covers loopback (::1), link-local (fe80::/10) and ULA (fc00::/7).
   Anything else that parses as an address is 'pub'. Candidate fields
   that are not addresses at all — the mDNS *.local hostnames browsers
   emit when host-candidate anonymisation is on — return null and get
   skipped: an mDNS name exposes nothing by design. */
export function classifyCandidateAddress(addr){
  if(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)){
    if(/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.)/.test(addr))
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

/* Gather every address WebRTC is willing to disclose.
     options.iceServers  RTCConfiguration servers (default: one public
                         STUN server; pass [] for a fully local probe)
     options.timeoutMs   hard settle bound in ms (default 5000)
   Resolves to { local: string[], pub: string[] } — deduplicated, in
   candidate order. Always resolves, never rejects: a missing
   RTCPeerConnection, a constructor throw, a failed offer and a timeout
   all settle with whatever was gathered so far. */
export function detectWebRTCAddresses(options){
  var opts = options || {};
  var iceServers = opts.iceServers !== undefined ? opts.iceServers : DEFAULT_ICE_SERVERS;
  var timeoutMs = opts.timeoutMs || GATHER_TIMEOUT_MS;
  return new Promise(function(resolve){
    var ips={local:[],pub:[]};
    var done=false;
    var pc=null;
    function fin(){if(done)return;done=true;if(pc)try{pc.close();}catch(x){}resolve(ips);}
    setTimeout(fin,timeoutMs);
    var RTC = typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null;
    if(!RTC){fin();return;}
    try{
      pc=new RTC({iceServers:iceServers});
      /* A data channel is the cheapest thing that makes the offer gather
         candidates — no media, no permissions prompt. */
      pc.createDataChannel('');
      pc.createOffer().then(function(o){return pc.setLocalDescription(o);}).catch(fin);
      pc.onicecandidate=function(e){
        if(!e.candidate){fin();return;}   /* null candidate = gathering done */
        /* candidate-attribute grammar: "candidate:<foundation> <component>
           <transport> <priority> <connection-address> <port> typ …" —
           whitespace-split field 5 is the address. */
        var parts=(e.candidate.candidate||'').split(/\s+/);
        if(parts.length<5)return;
        var addr=parts[4];
        if(ips.local.indexOf(addr)>=0||ips.pub.indexOf(addr)>=0)return;
        var scope=classifyCandidateAddress(addr);
        if(scope)ips[scope].push(addr);
      };
    }catch(e){fin();}
  });
}

/* The verdict printed over the gathered candidates, given the public
   address websites see for this connection (the site feeds the address
   its own edge observed; any what-is-my-IP witness works):
     'leak'      — a public candidate differs from publicIp: WebRTC is
                   disclosing an egress address the rest of the traffic
                   does not use (the classic VPN/proxy leak)
     'protected' — no candidates at all: nothing exposed
     'no-leak'   — candidates exist, but no public address beyond the
                   one already visible
   Comparison is exact-string, matching the in-page check; without a
   publicIp to compare against nothing can count as leaked. */
export function assessExposure(ips, publicIp){
  var mainIp = publicIp || '';
  var leaked = mainIp ? ips.pub.filter(function(ip){ return ip !== mainIp; }) : [];
  if (leaked.length) return { status: 'leak', leaked: leaked };
  if (!ips.pub.length && !ips.local.length) return { status: 'protected', leaked: [] };
  return { status: 'no-leak', leaked: [] };
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

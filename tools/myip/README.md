# My IP — WebRTC exposure check

The WebRTC probe at the heart of the
[My IP tab on subnsub.com](https://subnsub.com): gather every address the
browser is willing to disclose through ICE candidates, classify each one
(private / link-local / CGNAT / loopback / ULA vs public), judge whether
WebRTC is leaking an egress address the rest of your traffic hides, and
read the NAT's mapping behaviour off the same candidates. Published so
the verdict logic, the "this probe sends no user data" claim and the
list of things the NAT reading refuses to claim are all auditable.
Beside it, two pure readers from the same tab: an IPv6 address read
apart (does its interface identifier carry the device's MAC?) and the
connection's key exchange (post-quantum or not).

## Files

- [`ip-exposure.js`](ip-exposure.js) — the module:
  `detectWebRTCAddresses()`, `parseCandidate()`,
  `classifyCandidateAddress()`, `assessExposure()`, `assessNatMapping()`,
  `classifyASN()`, `ipv6Anatomy()`, `ipv6Words()`, `ipv6Text()`,
  `parseTrace()`, `kexInfo()`, plus the constants `STUN_MAIN`, `STUN_ALT`,
  `DEFAULT_ICE_SERVERS`, `GATHER_TIMEOUT_MS`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import {
  detectWebRTCAddresses, assessExposure, assessNatMapping,
  classifyCandidateAddress, parseCandidate, classifyASN,
} from './ip-exposure.js';

const ips = await detectWebRTCAddresses();
// → { local: ['192.168.1.10'], pub: ['203.0.113.7'],
//     srflx4: [{ proto:'udp', addr:'203.0.113.7', port:51234,
//                raddr:'192.168.1.10', rport:51234 }],
//     hosts4: 1, okMain: true, okAlt: true, anySrflx: true, supported: true }
// (≤ 6 s, always resolves)

// publicIp = the address websites see for you (any what-is-my-IP witness)
const verdict = assessExposure(ips, '203.0.113.7');
// → { status: 'leak' | 'no-leak' | 'protected' | 'unavailable', leaked: [...] }

const nat = assessNatMapping(ips);
// → 'independent' | 'dependent' | 'unsure'
const udp = ips.anySrflx ? 'open' : 'no STUN reply';

classifyCandidateAddress('100.72.3.9');   // 'local'  (CGNAT)
classifyCandidateAddress('2001:db8::1');  // 'pub'
parseCandidate('candidate:1 1 udp 1 203.0.113.7 51234 typ srflx raddr 192.168.1.10 rport 51234');
// → { proto:'udp', addr:'203.0.113.7', port:51234, typ:'srflx', raddr:'192.168.1.10', rport:51234 }
classifyASN('Mullvad VPN AB', 0);         // { type: 'VPN / Proxy', c: 'r' }

ipv6Anatomy('2001:db8:1:2:21a:2bff:fe3c:4d5e');
// → { prefix: '2001:db8:1:2::/64', iid: 'eui64', mac: '00:1a:2b:3c:4d:5e' }
ipv6Anatomy('2002:c000:204::1');          // { iid: '6to4', v4: '192.0.2.4' }

const trace = await (await fetch('/cdn-cgi/trace')).text();   // on a Cloudflare-served origin
kexInfo(parseTrace(trace).kex);           // { name: 'X25519MLKEM768', pq: true }
```

Requires a browser — `RTCPeerConnection` has no server-side equivalent.
Where it is missing or disabled the probe resolves empty with
`supported: false`, which `assessExposure()` reports as `'unavailable'`.

## What counts as local

| Family | Ranges |
|---|---|
| IPv4 | RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), link-local `169.254/16`, CGNAT `100.64/10`, `0/8` |
| IPv6 | loopback `::1`, link-local `fe80::/10`, ULA `fc00::/7` |

Everything else that parses as an address is public. Candidate fields
that are not addresses — the mDNS `*.local` hostnames browsers emit when
host-candidate anonymisation is on — classify as `null` and are skipped:
an mDNS name exposes nothing by design.

## Leak verdict semantics

- **`leak`** — a public candidate differs from `publicIp`: WebRTC is
  disclosing an egress address your other traffic doesn't use (the
  classic VPN/proxy leak). The offending addresses are in `leaked`.
- **`protected`** — no candidates at all: nothing exposed.
- **`no-leak`** — candidates exist, but no public address beyond the one
  already visible to every site.
- **`unavailable`** — no `RTCPeerConnection`: nothing was probed. A
  result without a `supported` flag (a bare `{ local, pub }`) is taken
  as probed.

Without a `publicIp` to compare against, nothing counts as leaked.

## NAT mapping semantics

The main connection carries two STUN servers *on one socket*, because
mapping behaviour is the question "when the same local socket talks to
two destinations, does it come back wearing the same public endpoint?".
A second connection could never answer that — its candidates have a
different base by construction.

The reading leans on ICE's own de-duplication (RFC 8445 §5.1.3): an
endpoint-independent NAT collapses both servers' replies into one
server-reflexive candidate; an endpoint-dependent one keeps two. Two
single-server legs run beside the main one purely to prove that *each*
server actually replied over IPv4, because one dead server also yields
exactly one candidate — and without that proof every blocked-STUN
network would read as a clean cone NAT.

- **`dependent`** — one base (protocol + `raddr` + `rport`) wore two
  different mapped endpoints (address *or* port changed).
- **`independent`** — one mapped endpoint, and both servers are proven
  to have answered.
- **`unsure`** — anything that cannot be separated. In particular: no
  IPv4 reflexive candidate at all; one endpoint but a server never
  confirmed; or the base masked by mDNS (`raddr`/`rport` absent) with
  more than one IPv4 host interface present, where multi-homing and a
  symmetric NAT are genuinely indistinguishable. Never dressed up as a
  pass.

What it deliberately does **not** say:

- *Address-dependent vs address-and-port-dependent.* The two servers
  differ in both address and port, so a changed mapping only proves
  "not endpoint-independent". Naming the flavour needs RFC 5780's
  two-step probe.
- *Filtering behaviour* (full-cone / restricted / port-restricted). That
  needs STUN's CHANGE-REQUEST, which WebRTC does not expose. Not measured,
  not guessed at.
- *"UDP blocked".* `anySrflx` true is proof UDP got out; its absence
  proves nothing — a host on a public address makes its reflexive
  candidate redundant and ICE drops it, an IPv6-only path never yields an
  IPv4 one, and a browser policy or a silent STUN server looks identical.
  Silence is reported as "no STUN reply", never promoted to "blocked".

## An IPv6 address, read apart

`ipv6Anatomy(address)` splits an IPv6 address the way it was built and
returns `null` for anything else (a zone suffix such as `%en0` is
dropped):

- **`prefix`** — the `/64` in RFC 5952 text: the network's half, the same
  for every device behind that router.
- **`iid`** — how the interface identifier, the device's half, was made:
  - `eui64` — `ff:fe` in the middle: modified EUI-64, the hardware MAC
    with its universal/local bit flipped. The same identifier follows the
    device to every network it joins; `mac` gives the address it came
    from.
  - `random` — a privacy (RFC 8981) or stable-private (RFC 7217)
    identifier. One sample cannot tell those two apart, so it does not
    try.
  - `assigned` — the top 32 bits are zero (`::1`, `::2a`, `::c000:201`):
    handed out by a person or a DHCPv6 server.
  - `teredo` (`2001::/32`), `6to4` (`2002::/16`, with the IPv4 address the
    prefix carries in `v4`) and `isatap` (`…:5efe:…`) — tunnels, named as
    such. Teredo and 6to4 return no `prefix`: their upper bits describe
    the tunnel, not a network.

`ipv6Words()` and `ipv6Text()` are the parser and the RFC 5952 formatter
underneath.

## Key exchange

Cloudflare's `/cdn-cgi/trace` names the key-exchange group the TLS (or
QUIC) handshake agreed on as `kex=`. `parseTrace()` turns the body into an
object; `kexInfo(name)` returns `{ name, pq }`, where `pq` is true for an
ML-KEM hybrid or the Kyber drafts before it — session keys that stay safe
from traffic recorded today and decrypted once a large quantum computer
exists. X25519 or a P-curve alone reads `pq: false`. No `kex` field gives
`null`.

## Network use & privacy

The module performs no fetches and transmits no user data
(`parseTrace()` reads a body the caller fetched). The only
network side effect is the STUN binding requests implied by the default
ICE configuration: three short-lived connections (main leg to
`stun:stun.l.google.com:19302` and `stun:stun.cloudflare.com:3478`, plus
one single-server confirmation leg to each). Those requests are how the
browser learns its server-reflexive address, they carry no payload, and
each server sees only the source address of the request it got.
`detectWebRTCAddresses({ iceServers: [] })` runs entirely on-device (host
candidates only, no confirmation legs, no NAT reading), and gathering is
hard-bounded at 6 s either way.

## On subnsub.com

The tab feeds `assessExposure()` the address the site's own edge observed
for the connection (its `/api/ip` echo); any what-is-my-IP witness works
as `publicIp`. The same result drives the UDP and NAT Mapping rows via
`anySrflx` and `assessNatMapping()`. The site version additionally runs
a server-side IP reputation lookup (`/api/iprep`, membership checks
against public blocklists compiled server-side) — a server component,
deliberately not part of this module; under its rows the tab lists each
blocklist's size and the age of the copy checked. `classifyASN()` is the
client-side network-type classifier both views share; `ipv6Anatomy()`
reads the IPv6 Readiness card's address and `kexInfo()` the Connection
card's trace.

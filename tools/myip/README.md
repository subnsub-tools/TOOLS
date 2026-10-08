# My IP — WebRTC exposure check

The WebRTC probe at the heart of the
[My IP tab on subnsub.com](https://subnsub.com): gather every address the
browser is willing to disclose through ICE candidates, classify each one
(private / link-local / CGNAT / loopback / ULA vs public), judge whether
WebRTC is leaking an egress address the rest of your traffic hides, and
read the NAT's mapping behaviour off the same candidates. Published so
the verdict logic, the "this probe sends no user data" claim and the
list of things the NAT reading refuses to claim are all auditable.

## Files

- [`ip-exposure.js`](ip-exposure.js) — the module:
  `detectWebRTCAddresses()`, `parseCandidate()`,
  `classifyCandidateAddress()`, `assessExposure()`, `assessNatMapping()`,
  `classifyASN()`, plus the constants `STUN_MAIN`, `STUN_ALT`,
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

## Network use & privacy

The module performs no fetches and transmits no user data. The only
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
deliberately not part of this module. `classifyASN()` is the client-side
network-type classifier both views share.

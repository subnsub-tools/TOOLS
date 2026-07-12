# My IP — WebRTC exposure check

The WebRTC probe at the heart of the
[My IP tab on subnsub.com](https://subnsub.com): gather every address the
browser is willing to disclose through ICE candidates, classify each one
(private / link-local / CGNAT / loopback / ULA vs public), and judge
whether WebRTC is leaking an egress address the rest of your traffic
hides. Published so both the verdict logic and the "this probe sends no
user data" claim are auditable.

## Files

- [`ip-exposure.js`](ip-exposure.js) — the module:
  `detectWebRTCAddresses()`, `classifyCandidateAddress()`,
  `assessExposure()`, `classifyASN()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Usage

```js
import {
  detectWebRTCAddresses, assessExposure, classifyCandidateAddress, classifyASN,
} from './ip-exposure.js';

const ips = await detectWebRTCAddresses();
// → { local: ['192.168.1.10'], pub: ['203.0.113.7'] } (≤ 5 s, always resolves)

// publicIp = the address websites see for you (any what-is-my-IP witness)
const verdict = assessExposure(ips, '203.0.113.7');
// → { status: 'leak' | 'no-leak' | 'protected', leaked: [...] }

classifyCandidateAddress('100.72.3.9');   // 'local'  (CGNAT)
classifyCandidateAddress('2001:db8::1');  // 'pub'
classifyASN('Mullvad VPN AB', 0);         // { type: 'VPN / Proxy', c: 'r' }
```

Requires a browser — `RTCPeerConnection` has no server-side equivalent.
Where it is missing or disabled the probe resolves empty, which
`assessExposure()` reports as `'protected'`.

## What counts as local

| Family | Ranges |
|---|---|
| IPv4 | RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), link-local `169.254/16`, CGNAT `100.64/10`, `0/8` |
| IPv6 | loopback `::1`, link-local `fe80::/10`, ULA `fc00::/7` |

Everything else that parses as an address is public. Candidate fields
that are not addresses — the mDNS `*.local` hostnames browsers emit when
host-candidate anonymisation is on — classify as `null` and are skipped:
an mDNS name exposes nothing by design.

## Verdict semantics

- **`leak`** — a public candidate differs from `publicIp`: WebRTC is
  disclosing an egress address your other traffic doesn't use (the
  classic VPN/proxy leak). The offending addresses are in `leaked`.
- **`protected`** — no candidates at all: nothing exposed.
- **`no-leak`** — candidates exist, but no public address beyond the one
  already visible to every site.

Without a `publicIp` to compare against, nothing counts as leaked.

## Network use & privacy

The module performs no fetches and transmits no user data. The one
network side effect is the STUN binding request implied by the default
ICE configuration (`stun:stun.l.google.com:19302`, a public STUN
server) — that request is how the browser learns its server-reflexive
address, it carries no payload, and without it there are no public
candidates to check. `detectWebRTCAddresses({ iceServers: [] })` runs
entirely on-device (host candidates only), and gathering is hard-bounded
at 5 s either way.

## On subnsub.com

The tab feeds `assessExposure()` the address the site's own edge observed
for the connection (its `/api/ip` echo); any what-is-my-IP witness works
as `publicIp`. The site version additionally runs a server-side IP
reputation lookup (`/api/iprep`, membership checks against public
blocklists compiled server-side) — a server component, deliberately not
part of this module. `classifyASN()` is the client-side network-type
classifier both views share.

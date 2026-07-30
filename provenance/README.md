# Provenance

`ANCHOR.txt` pins this repository's history — the head commit and tree
hashes it names — and `ANCHOR.txt.ots` is an
[OpenTimestamps](https://opentimestamps.org) proof that the anchor existed
no later than its anchor date. The proof commits to the Bitcoin
blockchain, so it stays verifiable independently of any hosting platform.

Verify with the OpenTimestamps client:

    ots verify ANCHOR.txt.ots

A freshly minted proof is *pending attestation* until a calendar commits
it to a block; `ots upgrade ANCHOR.txt.ots` collects the final
attestation. Anchors are refreshed at milestones, not per commit.
